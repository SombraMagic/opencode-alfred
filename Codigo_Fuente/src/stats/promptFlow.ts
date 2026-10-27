import { listDbFiles, openSqliteReadOnly, tokensFromMessage } from "./opencodeStats";
import type { TokenCounts } from "./opencodeStats";

/** Tramo trabajado por un agente dentro de un prompt. */
export interface PromptSegment {
  start: number;
  end: number;
}

/** Una fila del registro: un agente que intervino en el prompt. */
export interface PromptLane {
  agent: string;
  color?: string;
  /** El agente es el de la sesión raíz (la del usuario), no un subagente. */
  root: boolean;
  segments: PromptSegment[];
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  workMs: number;
  cost: number;
  /** Al menos una llamada se estimó con tarifas en vez del coste real de opencode. */
  costEstimated: boolean;
  /** Hubo coste real o tarifa válida; con `false` el coste es 0 por desconocido. */
  priced: boolean;
}

/** Un prompt del usuario con todo lo que se movió mientras duró. */
export interface PromptRecord {
  id: string;
  project: string;
  prompt: string;
  startedAt: number;
  endedAt: number;
  live: boolean;
  lanes: PromptLane[];
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  workMs: number;
  cost: number;
  costEstimated: boolean;
  priced: boolean;
}

export interface PromptStatsSnapshot {
  ok: boolean;
  error?: string;
  monitor: boolean;
  monitorSince: number;
  project?: string;
  scannedAt: number;
  prompts: PromptRecord[];
  /** Registros guardados en disco del proyecto mostrado (0 si no hay proyecto). */
  savedCount: number;
}

/** USD por millón de tokens. */
export interface PromptRates {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ScanPromptOptions {
  dataDir: string;
  project: string;
  since: number;
  now: number;
  colorOf(agent: string): string | undefined;
  ratesFor(provider: string, model: string): PromptRates | undefined;
}

export interface PromptScanResult {
  ok: boolean;
  error?: string;
  prompts: PromptRecord[];
  /** Los terminados de `prompts`; el servicio los incorpora por `id` (upsert por cierre). */
  completed: PromptRecord[];
}

/** Sin `idle` ni user siguiente: pasado esto sin actividad, el prompt se cierra como abandonado. */
const ABANDONED_MS = 15 * 60 * 1000;
/** Un prompt puede haber empezado antes de `since`: margen suficiente para no perderlo. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/**
 * Tolerancia para el `time_updated` de las sesiones raíz: un turno vivo al reabrir VS Code no
 * ha vuelto a escribirse, así que la mira hacia atrás cubre como mínimo la ventana de turno vivo.
 */
const ROOT_TOLERANCE_MS = ABANDONED_MS;
const TEXT_MAX = 180;

type Db = NonNullable<ReturnType<typeof openSqliteReadOnly>>;

interface SessionRow {
  id: string;
  parentId?: string;
  directory: string;
  updated: number;
}

/** Mensaje ya parseado de `session_message`. */
interface Msg {
  session: string;
  seq: number;
  type: string;
  created: number;
  updated: number;
  completed?: number;
  agent: string;
  provider: string;
  model: string;
  cost: number;
  tokens: TokenCounts;
  text: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function trimDir(p: string): string {
  let s = p.replace(/[\\/]+/g, "/");
  while (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}

/** Las rutas de opencode vienen con barras alternativas; en Windows además da igual la caja. */
function sameDir(a: string, b: string): boolean {
  const na = trimDir(a);
  const nb = trimDir(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function promptText(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (!t) {
    return "(prompt sin texto)";
  }
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

function parseProviderModel(raw: unknown): { provider: string; model: string } {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return {
      provider: typeof obj.providerID === "string" ? obj.providerID : "",
      model: typeof obj.id === "string" ? obj.id : typeof obj.modelID === "string" ? obj.modelID : "",
    };
  }
  // Algunas BD viejas guardan el modelo como texto "proveedor/id".
  if (typeof raw === "string") {
    const slash = raw.indexOf("/");
    if (slash > 0) {
      return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
    }
    return { provider: "", model: raw };
  }
  return { provider: "", model: "" };
}

function toMsg(row: Record<string, unknown>): Msg | undefined {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(row.data)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const time = (data.time ?? {}) as Record<string, unknown>;
  const created = num(time.created) || num(row.time_created);
  const completed = typeof time.completed === "number" ? time.completed : undefined;
  const type = String(row.type ?? "");
  const { provider, model } = parseProviderModel(data.model);
  return {
    session: String(row.session_id),
    seq: num(row.seq),
    type,
    created,
    updated: num(row.time_updated),
    completed,
    agent: type === "assistant" ? (typeof data.agent === "string" && data.agent ? data.agent : "(desconocido)") : "",
    provider,
    model,
    cost: num(data.cost),
    tokens: type === "assistant" ? tokensFromMessage(data) : tokensFromMessage({}),
    text: typeof data.text === "string" ? data.text : "",
  };
}

/** Acumulador de una fila mientras se recorren los mensajes. */
interface LaneAcc {
  agent: string;
  root: boolean;
  spans: Map<string, { start: number; end: number }>;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Al menos una llamada se estimó con tarifas. */
  estimated: boolean;
  /** Al menos una llamada tiene coste real o tarifa. */
  priced: boolean;
}

function laneAcc(agent: string): LaneAcc {
  return {
    agent,
    root: false,
    spans: new Map(),
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    estimated: false,
    priced: false,
  };
}

export function scanOpencodePrompts(options: ScanPromptOptions): PromptScanResult {
  const dbs = listDbFiles(options.dataDir);
  if (dbs.length === 0) {
    return {
      ok: false,
      error: `No se encontraron bases de datos de opencode en ${options.dataDir}`,
      prompts: [],
      completed: [],
    };
  }

  const sessions = new Map<string, SessionRow>();
  const messages = new Map<string, Msg>();
  let opened = 0;
  let schema = false;

  // Primera pasada: el árbol de sesiones. La de mensajes sólo se hace sobre lo que interesa.
  for (const file of dbs) {
    // En estricta lectura: la que no abre se omite y el escaneo sigue con las demás.
    const db = openSqliteReadOnly(file);
    if (!db) {
      continue;
    }
    opened += 1;
    try {
      db.exec("PRAGMA busy_timeout=3000");
    } catch {
      /* algunas versiones no admiten PRAGMA en solo lectura */
    }
    try {
      readSessions(db, sessions);
      schema = true;
    } catch {
      // BD con esquema viejo o sin tablas: no aporta prompts de v2.
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  if (opened === 0) {
    const probe = openSqliteReadOnly(":memory:");
    if (probe) {
      try {
        probe.close();
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      error: probe
        ? "No se pudo abrir en solo lectura ninguna base de datos de opencode (¿bloqueadas?)"
        : "El módulo node:sqlite no está disponible en este VS Code (requiere Node 22.5+/24).",
      prompts: [],
      completed: [],
    };
  }
  if (!schema) {
    return { ok: true, prompts: [], completed: [] };
  }

  const childrenOf = new Map<string, string[]>();
  for (const s of sessions.values()) {
    if (!s.parentId) {
      continue;
    }
    const list = childrenOf.get(s.parentId) ?? [];
    list.push(s.id);
    childrenOf.set(s.parentId, list);
  }

  const trees = new Map<string, Set<string>>();
  for (const s of sessions.values()) {
    if (s.parentId || !sameDir(s.directory, options.project)) {
      continue;
    }
    if (s.updated >= options.since - ROOT_TOLERANCE_MS) {
      trees.set(s.id, descendants(s.id, childrenOf));
    }
  }
  if (trees.size === 0) {
    return { ok: true, prompts: [], completed: [] };
  }

  const wanted = new Set<string>();
  for (const tree of trees.values()) {
    for (const id of tree) {
      wanted.add(id);
    }
  }

  // Segunda pasada: sólo los mensajes de las sesiones del proyecto.
  for (const file of dbs) {
    const db = openSqliteReadOnly(file);
    if (!db) {
      continue;
    }
    try {
      db.exec("PRAGMA busy_timeout=3000");
    } catch {
      /* algunas versiones no admiten PRAGMA en solo lectura */
    }
    try {
      readMessages(db, wanted, options.since, messages);
    } catch {
      // BD sin la tabla de mensajes del esquema v2: no aporta nada.
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  const bySession = new Map<string, Msg[]>();
  for (const msg of messages.values()) {
    const list = bySession.get(msg.session) ?? [];
    list.push(msg);
    bySession.set(msg.session, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.seq - b.seq || a.created - b.created);
  }

  const prompts: PromptRecord[] = [];
  for (const [rootId, tree] of trees) {
    for (const record of promptsOfRoot(rootId, tree, bySession, options)) {
      prompts.push(record);
    }
  }
  prompts.sort((a, b) => b.startedAt - a.startedAt);
  const completed = prompts.filter((p) => !p.live);
  return { ok: true, prompts, completed };
}

/** Sesión raíz más todos sus descendientes por `parent_id`. */
function descendants(rootId: string, childrenOf: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) {
      continue;
    }
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) {
      stack.push(child);
    }
  }
  return out;
}

function readSessions(db: Db, sessions: Map<string, SessionRow>): void {
  const rows = db
    .prepare("SELECT id, parent_id, directory, time_updated FROM session_v2")
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const id = String(row.id);
    const updated = num(row.time_updated);
    const prev = sessions.get(id);
    // La misma id puede estar en varias BD: gana la fila más reciente.
    if (prev && prev.updated >= updated) {
      continue;
    }
    sessions.set(id, {
      id,
      parentId: row.parent_id ? String(row.parent_id) : undefined,
      directory: row.directory ? String(row.directory) : "",
      updated,
    });
  }
}

function readMessages(db: Db, wanted: Set<string>, since: number, messages: Map<string, Msg>): void {
  const ids = [...wanted];
  if (ids.length === 0) {
    return;
  }
  const floor = since - LOOKBACK_MS;
  // Por tandas: `IN` con miles de ids sería un comando desmesurado.
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT session_id, seq, type, time_created, time_updated, data FROM session_message ` +
          `WHERE session_id IN (${marks}) AND type IN ('user','assistant','idle') AND time_created >= ? ` +
          `ORDER BY session_id, seq`
      )
      .all(...chunk, floor) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const msg = toMsg(row);
      if (!msg) {
        continue;
      }
      const key = `${msg.session}:${msg.seq}`;
      const prev = messages.get(key);
      if (prev && prev.updated >= msg.updated) {
        continue;
      }
      messages.set(key, msg);
    }
  }
}

function promptsOfRoot(
  rootId: string,
  tree: Set<string>,
  bySession: Map<string, Msg[]>,
  options: ScanPromptOptions
): PromptRecord[] {
  const root = bySession.get(rootId) ?? [];
  const out: PromptRecord[] = [];
  for (let i = 0; i < root.length; i++) {
    const user = root[i];
    if (user.type !== "user") {
      continue;
    }
    const record = buildPrompt(rootId, tree, bySession, user, options, i);
    if (record) {
      out.push(record);
    }
  }
  return out;
}

function buildPrompt(
  rootId: string,
  tree: Set<string>,
  bySession: Map<string, Msg[]>,
  user: Msg,
  options: ScanPromptOptions,
  userIndex: number
): PromptRecord | undefined {
  const { now } = options;
  const root = bySession.get(rootId) ?? [];

  // Cierre natural: el `idle` que de verdad cierra el turno. Un turno puede reanudarse después
  // de un `idle` (auto-reanudación, subagentes tardíos) y volver a trabajar: si el último mensaje
  // de raíz del tramo es un `idle`, ése es el cierre, aunque hubiera idles anteriores. Si no,
  // cierra el siguiente mensaje user (interrupción) y, si tampoco lo hay, el turno sigue abierto.
  let nextUser: Msg | undefined;
  let ultimo: Msg | undefined;
  let ultimoIdle: number | undefined;
  for (let j = userIndex + 1; j < root.length; j++) {
    const next = root[j];
    if (next.type === "user") {
      nextUser = next;
      break;
    }
    ultimo = next;
    if (next.type === "idle") {
      ultimoIdle = next.created;
    }
  }
  const naturalEnd = ultimo?.type === "idle" ? ultimoIdle : nextUser?.created;

  const pool: Msg[] = [];
  for (const id of tree) {
    for (const msg of bySession.get(id) ?? []) {
      if (msg.type === "assistant" && msg.created >= user.created) {
        pool.push(msg);
      }
    }
  }
  pool.sort((a, b) => a.created - b.created || a.seq - b.seq);

  let end = naturalEnd;
  let lastActivity = user.created;
  const taken: Msg[] = [];
  for (const msg of pool) {
    // Admite sólo lo anterior al cierre natural (el `idle` final del turno o el siguiente user),
    // raíz o hijo: un hijo creado después pertenece al siguiente turno, aunque termine antes de
    // su fin.
    if (naturalEnd !== undefined && msg.created > naturalEnd) {
      break;
    }
    taken.push(msg);
    const provisional = msg.completed ?? (msg.updated > 0 ? msg.updated : msg.created);
    if (provisional > lastActivity) {
      lastActivity = provisional;
    }
    // Un hijo admitido que termina después del cierre alarga el prompt.
    if (end !== undefined && provisional > end) {
      end = provisional;
    }
  }

  const live = end === undefined && now - lastActivity <= ABANDONED_MS;
  if (end === undefined) {
    // Sin `idle`: turno vivo hasta `now`; si hace rato que no se escribe nada, abandonado.
    end = live ? now : Math.max(lastActivity, user.created);
  }
  if (end < options.since) {
    return undefined;
  }

  const lanes = new Map<string, LaneAcc>();
  for (const msg of taken) {
    const lane = lanes.get(msg.agent) ?? laneAcc(msg.agent);
    lanes.set(msg.agent, lane);
    if (msg.session === rootId) {
      lane.root = true;
    }
    lane.input += msg.tokens.input;
    lane.output += msg.tokens.output;
    lane.reasoning += msg.tokens.reasoning;
    lane.cacheRead += msg.tokens.cacheRead;
    lane.cacheWrite += msg.tokens.cacheWrite;
    lane.total += msg.tokens.total;

    const span = lane.spans.get(msg.session);
    const finish = msg.completed ?? (live ? now : msg.updated > 0 ? msg.updated : msg.created);
    if (!span) {
      lane.spans.set(msg.session, { start: msg.created, end: Math.max(finish, msg.created) });
    } else if (finish > span.end) {
      span.end = finish;
    }

    if (msg.cost > 0) {
      lane.cost += msg.cost;
      lane.priced = true;
    } else {
      const rates = options.ratesFor(msg.provider, msg.model);
      // Sin trabajo medido no hay nada que estimar: un assistant en streaming sin tokens
      // seguiría siendo incógnita aunque el modelo tenga tarifa.
      if (rates && msg.tokens.total > 0) {
        lane.cost +=
          (msg.tokens.input * rates.input +
            msg.tokens.output * rates.output +
            msg.tokens.reasoning * rates.reasoning +
            msg.tokens.cacheRead * rates.cacheRead +
            msg.tokens.cacheWrite * rates.cacheWrite) /
          1_000_000;
        lane.estimated = true;
        lane.priced = true;
      }
    }
  }

  const laneList: PromptLane[] = [];
  const record: PromptRecord = {
    id: `${rootId}:${user.created}`,
    project: options.project,
    prompt: promptText(user.text),
    startedAt: user.created,
    endedAt: end,
    live,
    lanes: laneList,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    workMs: 0,
    cost: 0,
    costEstimated: false,
    priced: false,
  };

  for (const acc of lanes.values()) {
    const segments = [...acc.spans.values()]
      .map((s) => ({ start: s.start, end: Math.max(s.end, s.start) }))
      .sort((a, b) => a.start - b.start);
    const lane: PromptLane = {
      agent: acc.agent,
      color: options.colorOf(acc.agent),
      root: acc.root,
      segments,
      input: acc.input,
      output: acc.output,
      reasoning: acc.reasoning,
      cacheRead: acc.cacheRead,
      cacheWrite: acc.cacheWrite,
      total: acc.total,
      workMs: segments.reduce((ms, s) => ms + Math.max(0, s.end - s.start), 0),
      cost: acc.cost,
      costEstimated: acc.estimated,
      priced: acc.priced,
    };
    laneList.push(lane);
    record.input += lane.input;
    record.output += lane.output;
    record.reasoning += lane.reasoning;
    record.cacheRead += lane.cacheRead;
    record.cacheWrite += lane.cacheWrite;
    record.total += lane.total;
    record.workMs += lane.workMs;
    record.cost += lane.cost;
    record.costEstimated = record.costEstimated || lane.costEstimated;
    record.priced = record.priced || lane.priced;
  }
  // La fila del usuario manda, luego el resto por orden alfabético para que sea estable.
  laneList.sort((a, b) => Number(b.root) - Number(a.root) || a.agent.localeCompare(b.agent));

  if (laneList.length === 0 && !live) {
    // Prompt sin ninguna respuesta: sólo interesa mientras está vivo.
    return undefined;
  }
  return record;
}
