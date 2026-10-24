import * as path from "path";
import * as fs from "fs";
import { opencodeDataDir } from "../agents/paths";

export interface TokenCounts {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface AgentActivity {
  agent: string;
  tokens: TokenCounts;
  cost: number;
  /** Sum of assistant-message generation durations, in ms. */
  workMs: number;
  messages: number;
  sessions: number;
  /** Epoch ms of the last known activity. */
  lastActive: number;
  /** Hay un turno abierto: trabajando o pensando entre iteraciones. */
  working: boolean;
  /** Además hay algo en vuelo (streaming o herramienta en ejecución). */
  streaming: boolean;
  workingSessions: number;
}

export interface SessionInfo {
  id: string;
  parentId?: string;
  agent: string;
  title: string;
  model: string;
  directory: string;
  tokens: TokenCounts;
  cost: number;
  workMs: number;
  created: number;
  updated: number;
  working: boolean;
  streaming: boolean;
}

export interface StatsSnapshot {
  ok: boolean;
  error?: string;
  dataDir: string;
  dbs: string[];
  scannedAt: number;
  agents: AgentActivity[];
  sessions: SessionInfo[];
  totals: AgentActivity;
}

interface RawSqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  exec(sql: string): void;
  close(): void;
}

/**
 * Marcas por sesión de las que se deriva "trabajando". Guardan tiempos, no booleanos,
 * porque la decisión depende del reloj y se reevalúa en cada sondeo (ver applyWorkingFlags).
 */
interface ActivityMarks {
  /** `created` del mensaje assistant más reciente en vuelo (streaming). */
  openMessageAt: number;
  /** `time_updated` del mensaje con herramienta en ejecución más reciente. */
  runningToolAt: number;
  /** `time_created` del último mensaje `idle` (fin de turno). */
  lastIdleAt: number;
  /** `time_created` del último mensaje que no es `idle`. */
  lastOtherAt: number;
}

/** Mutable state shared while scanning one or more opencode databases. */
interface ScanContext {
  sessionsMap: Map<string, SessionInfo>;
  agentAgg: Map<string, AgentActivity>;
  marks: Map<string, ActivityMarks>;
}

function marksFor(ctx: ScanContext, sessionId: string): ActivityMarks {
  let marks = ctx.marks.get(sessionId);
  if (!marks) {
    marks = { openMessageAt: 0, runningToolAt: 0, lastIdleAt: 0, lastOtherAt: 0 };
    ctx.marks.set(sessionId, marks);
  }
  return marks;
}

function hasTable(db: RawSqlite, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

/** Window (ms) in which a running tool part still counts as "working". */
const RUNNING_PART_WINDOW = 5 * 60 * 1000;
/** Window (ms) in which an uncompleted assistant message still counts as "working". */
const OPEN_MESSAGE_WINDOW = 15 * 60 * 1000;
/**
 * Window (ms) in which an unclosed turn still counts as "working". opencode escribe un
 * mensaje `idle` al terminar el turno; mientras no llegue, el agente está trabajando
 * aunque en ese instante no haya nada en vuelo (el modelo está pensando). Esta ventana
 * es sólo la red de seguridad por si un turno se abandona sin `idle`.
 */
const OPEN_TURN_WINDOW = 15 * 60 * 1000;

export function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addTokens(target: TokenCounts, src: TokenCounts): void {
  target.input += src.input;
  target.output += src.output;
  target.reasoning += src.reasoning;
  target.cacheRead += src.cacheRead;
  target.cacheWrite += src.cacheWrite;
  target.total += src.total;
}

function tokensFromMessage(msg: Record<string, unknown>): TokenCounts {
  const tk = (msg.tokens ?? {}) as Record<string, unknown>;
  const cache = (tk.cache ?? {}) as Record<string, unknown>;
  const input = num(tk.input);
  const output = num(tk.output);
  const reasoning = num(tk.reasoning);
  const cacheRead = num(cache.read);
  const cacheWrite = num(cache.write);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: num(tk.total) || input + output + reasoning + cacheRead + cacheWrite,
  };
}

export function emptyActivity(agent: string): AgentActivity {
  return {
    agent,
    tokens: emptyTokens(),
    cost: 0,
    workMs: 0,
    messages: 0,
    sessions: 0,
    lastActive: 0,
    working: false,
    streaming: false,
    workingSessions: 0,
  };
}

export function parseModel(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "";
  }
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const provider = typeof obj.providerID === "string" ? obj.providerID : "";
    const id = typeof obj.id === "string" ? obj.id : typeof obj.modelID === "string" ? obj.modelID : "";
    if (provider && id) {
      return `${provider}/${id}`;
    }
    return id || provider || raw;
  } catch {
    return raw;
  }
}

/** Firma barata (mtime+tamaño) de las BD y sus WAL, para cachear escaneos. */
export function dbSignature(files: string[]): string {
  const parts: string[] = [];
  for (const file of files) {
    for (const candidate of [file, `${file}-wal`]) {
      try {
        const st = fs.statSync(candidate);
        parts.push(`${candidate}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${candidate}:-`);
      }
    }
  }
  return parts.join("|");
}

/** Directory holding opencode's data (SQLite databases). */
export function listDbFiles(dataDir: string): string[] {
  try {
    return fs
      .readdirSync(dataDir)
      .filter((name) => /^opencode.*\.db$/i.test(name))
      .map((name) => path.join(dataDir, name));
  } catch {
    return [];
  }
}

/** Abre una BD de opencode en solo lectura; undefined si el host no trae node:sqlite. */
export function openSqlite(file: string): RawSqlite | undefined {
  let mod: { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => RawSqlite };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("node:sqlite");
  } catch {
    return undefined;
  }
  try {
    return new mod.DatabaseSync(file, { readOnly: true });
  } catch {
    try {
      return new mod.DatabaseSync(file);
    } catch {
      return undefined;
    }
  }
}

export class StatsService {
  private cache?: { sig: string; agents: AgentActivity[]; sessions: SessionInfo[]; totals: AgentActivity };
  private marks = new Map<string, ActivityMarks>();

  async collect(): Promise<StatsSnapshot> {
    const dataDir = opencodeDataDir();
    const dbs = listDbFiles(dataDir);
    const scannedAt = Date.now();

    if (dbs.length === 0) {
      return {
        ok: false,
        error: `No se encontraron bases de datos de opencode en ${dataDir}`,
        dataDir,
        dbs,
        scannedAt,
        agents: [],
        sessions: [],
        totals: emptyActivity("(total)"),
      };
    }

    const sig = this.signature(dbs);
    if (this.cache && this.cache.sig === sig) {
      // El escaneo está cacheado, pero las ventanas de tiempo siguen corriendo: hay que
      // reevaluarlas en cada sondeo o un icono encendido no se apagaría nunca.
      applyWorkingFlags(this.cache.agents, this.cache.sessions, this.cache.totals, this.marks, scannedAt);
      return {
        ok: true,
        dataDir,
        dbs,
        scannedAt,
        agents: this.cache.agents,
        sessions: this.cache.sessions,
        totals: this.cache.totals,
      };
    }

    try {
      const result = this.scan(dbs, scannedAt);
      this.cache = { sig, ...result };
      return { ok: true, dataDir, dbs, scannedAt, ...result };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        dataDir,
        dbs,
        scannedAt,
        agents: [],
        sessions: [],
        totals: emptyActivity("(total)"),
      };
    }
  }

  private signature(dbs: string[]): string {
    return dbSignature(dbs);
  }

  private scan(
    dbs: string[],
    now: number
  ): { agents: AgentActivity[]; sessions: SessionInfo[]; totals: AgentActivity } {
    const ctx: ScanContext = {
      sessionsMap: new Map(),
      agentAgg: new Map(),
      marks: new Map(),
    };
    let opened = 0;

    for (const file of dbs) {
      const db = openSqlite(file);
      if (!db) {
        continue;
      }
      opened += 1;
      try {
        db.exec("PRAGMA busy_timeout=3000");
        // opencode >= 0.5 uses session_v2 + session_message; older builds used
        // session + message + part. Prefer the new schema when it has data.
        if (!this.scanV2(db, ctx)) {
          this.scanV1(db, ctx);
        }
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (opened === 0) {
      const hasSqlite = !!openSqlite(":memory:");
      throw new Error(
        hasSqlite
          ? "No se pudo abrir ninguna base de datos de opencode (¿bloqueadas?)"
          : "El modulo node:sqlite no esta disponible en este VS Code (requiere Node 22.5+/24)."
      );
    }

    const { sessionsMap, agentAgg } = ctx;

    for (const session of sessionsMap.values()) {
      const agg = agentAgg.get(session.agent) ?? emptyActivity(session.agent);
      agg.sessions += 1;
      agg.lastActive = Math.max(agg.lastActive, session.updated);
      agentAgg.set(session.agent, agg);
    }

    const agents = [...agentAgg.values()].sort(
      (a, b) => b.tokens.total - a.tokens.total || a.agent.localeCompare(b.agent)
    );
    const sessions = [...sessionsMap.values()].sort((a, b) => b.updated - a.updated);

    const totals = emptyActivity("(total)");
    for (const a of agents) {
      addTokens(totals.tokens, a.tokens);
      totals.cost += a.cost;
      totals.workMs += a.workMs;
      totals.messages += a.messages;
      totals.sessions += a.sessions;
      totals.lastActive = Math.max(totals.lastActive, a.lastActive);
      totals.working = totals.working || a.working;
      totals.workingSessions += a.workingSessions;
    }

    this.marks = ctx.marks;
    applyWorkingFlags(agents, sessions, totals, ctx.marks, now);

    return { agents, sessions, totals };
  }

  /**
   * Current opencode schema: `session_v2` + `session_message` (JSON `data`).
   * Returns true when this database uses it (so the legacy scan is skipped).
   */
  private scanV2(db: RawSqlite, ctx: ScanContext): boolean {
    if (!hasTable(db, "session_v2") || !hasTable(db, "session_message")) {
      return false;
    }

    const sessionRows = db
      .prepare(
        "SELECT id, parent_id, agent, model, title, directory, time_created, time_updated FROM session_v2"
      )
      .all() as Array<Record<string, unknown>>;
    if (sessionRows.length === 0) {
      return false;
    }

    for (const row of sessionRows) {
      const id = String(row.id);
      ctx.sessionsMap.set(id, {
        id,
        parentId: row.parent_id ? String(row.parent_id) : undefined,
        agent: row.agent ? String(row.agent) : "(desconocido)",
        title: row.title ? String(row.title) : "",
        model: parseModel(row.model),
        directory: row.directory ? String(row.directory) : "",
        tokens: emptyTokens(),
        cost: 0,
        workMs: 0,
        created: num(row.time_created),
        updated: num(row.time_updated),
        working: false,
        streaming: false,
      });
    }

    const messageRows = db
      .prepare("SELECT session_id, time_updated, data FROM session_message WHERE type='assistant'")
      .all() as Array<{ session_id: string; time_updated: number; data: string }>;
    for (const row of messageRows) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokens = tokensFromMessage(msg);
      const cost = num(msg.cost);
      const time = (msg.time ?? {}) as Record<string, unknown>;
      const created = num(time.created);
      const completed = typeof time.completed === "number" ? time.completed : undefined;
      const workMs = completed !== undefined && created > 0 ? Math.max(0, completed - created) : 0;
      const agent = typeof msg.agent === "string" && msg.agent ? msg.agent : "(desconocido)";

      const session = ctx.sessionsMap.get(row.session_id);
      if (session) {
        addTokens(session.tokens, tokens);
        session.cost += cost;
        session.workMs += workMs;
      }

      const agg = ctx.agentAgg.get(agent) ?? emptyActivity(agent);
      addTokens(agg.tokens, tokens);
      agg.cost += cost;
      agg.workMs += workMs;
      agg.messages += 1;
      agg.lastActive = Math.max(agg.lastActive, created);
      ctx.agentAgg.set(agent, agg);

      const evidence = workingEvidence(msg, num(row.time_updated));
      if (evidence === "message") {
        const marks = marksFor(ctx, row.session_id);
        marks.openMessageAt = Math.max(marks.openMessageAt, created);
      } else if (evidence === "tool") {
        const marks = marksFor(ctx, row.session_id);
        marks.runningToolAt = Math.max(marks.runningToolAt, num(row.time_updated));
      }
    }

    // opencode escribe un mensaje `idle` al terminar el turno: comparando el último `idle`
    // con el último mensaje que no lo es, se sabe si el turno sigue abierto aunque en ese
    // instante no haya nada en vuelo (el modelo está pensando entre iteraciones).
    const lastRows = db
      .prepare(
        "SELECT session_id, " +
          "MAX(CASE WHEN type='idle' THEN time_created END) AS last_idle, " +
          "MAX(CASE WHEN type<>'idle' THEN time_created END) AS last_other " +
          "FROM session_message GROUP BY session_id"
      )
      .all() as Array<{ session_id: string; last_idle: number; last_other: number }>;
    for (const row of lastRows) {
      const marks = marksFor(ctx, row.session_id);
      marks.lastIdleAt = num(row.last_idle);
      marks.lastOtherAt = num(row.last_other);
    }

    return true;
  }

  /** Legacy opencode schema: `session` + `message` + `part`. */
  private scanV1(db: RawSqlite, ctx: ScanContext): void {
    if (!hasTable(db, "session")) {
      return;
    }

    const sessionRows = db
      .prepare(
        "SELECT id, parent_id, agent, model, title, directory, time_created, time_updated FROM session"
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of sessionRows) {
      const id = String(row.id);
      ctx.sessionsMap.set(id, {
        id,
        parentId: row.parent_id ? String(row.parent_id) : undefined,
        agent: row.agent ? String(row.agent) : "(desconocido)",
        title: row.title ? String(row.title) : "",
        model: parseModel(row.model),
        directory: row.directory ? String(row.directory) : "",
        tokens: emptyTokens(),
        cost: 0,
        workMs: 0,
        created: num(row.time_created),
        updated: num(row.time_updated),
        working: false,
        streaming: false,
      });
    }

    const messageRows = db
      .prepare(
        "SELECT session_id, data FROM message WHERE json_extract(data,'$.role')='assistant'"
      )
      .all() as Array<{ session_id: string; data: string }>;
    for (const row of messageRows) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const tokens = tokensFromMessage(msg);
      const cost = num(msg.cost);
      const time = (msg.time ?? {}) as Record<string, unknown>;
      const created = num(time.created);
      const completed = typeof time.completed === "number" ? time.completed : undefined;
      const workMs = completed !== undefined && created > 0 ? Math.max(0, completed - created) : 0;
      const agent = typeof msg.agent === "string" && msg.agent ? msg.agent : "(desconocido)";

      const session = ctx.sessionsMap.get(row.session_id);
      if (session) {
        addTokens(session.tokens, tokens);
        session.cost += cost;
        session.workMs += workMs;
      }

      const agg = ctx.agentAgg.get(agent) ?? emptyActivity(agent);
      addTokens(agg.tokens, tokens);
      agg.cost += cost;
      agg.workMs += workMs;
      agg.messages += 1;
      agg.lastActive = Math.max(agg.lastActive, created);
      ctx.agentAgg.set(agent, agg);

      // El esquema viejo no escribe `idle`, así que aquí no hay marcas de turno:
      // estas sesiones se quedan con la regla de "algo en vuelo".
      if (completed === undefined && created > 0) {
        const marks = marksFor(ctx, row.session_id);
        marks.openMessageAt = Math.max(marks.openMessageAt, created);
      }
    }

    const runningRows = db
      .prepare(
        "SELECT session_id, MAX(time_updated) AS u FROM part " +
          "WHERE json_extract(data,'$.state.status') IN ('running','pending') GROUP BY session_id"
      )
      .all() as Array<{ session_id: string; u: number }>;
    for (const row of runningRows) {
      const marks = marksFor(ctx, row.session_id);
      marks.runningToolAt = Math.max(marks.runningToolAt, num(row.u));
    }
  }
}

/**
 * Qué evidencia de trabajo en vuelo tiene un mensaje: sigue en streaming (sin hora de
 * finalización), tiene una herramienta en ejecución, o ninguna. Las ventanas de tiempo
 * se aplican después, en applyWorkingFlags.
 */
function workingEvidence(
  msg: Record<string, unknown>,
  updated: number
): "message" | "tool" | undefined {
  const time = (msg.time ?? {}) as Record<string, unknown>;
  const created = num(time.created);
  const completed = typeof time.completed === "number" ? time.completed : undefined;
  if (completed === undefined && !msg.error && created > 0) {
    return "message";
  }
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const rawPart of content) {
      const part = rawPart as Record<string, unknown>;
      if (part.type !== "tool") {
        continue;
      }
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = state.status;
      if ((status === "running" || status === "pending") && updated > 0) {
        return "tool";
      }
    }
  }
  return undefined;
}

/**
 * Deriva `working` (hay un turno abierto) y `streaming` (además hay algo en vuelo) a
 * partir de las marcas del escaneo. Se llama en cada sondeo, también cuando el escaneo
 * viene de caché: si opencode deja de escribir, sin esto las ventanas nunca caducarían.
 */
function applyWorkingFlags(
  agents: AgentActivity[],
  sessions: SessionInfo[],
  totals: AgentActivity,
  marks: Map<string, ActivityMarks>,
  now: number
): void {
  const byAgent = new Map(agents.map((a) => [a.agent, a]));
  for (const a of agents) {
    a.working = false;
    a.streaming = false;
    a.workingSessions = 0;
  }
  for (const s of sessions) {
    const m = marks.get(s.id);
    const streaming =
      !!m &&
      ((m.openMessageAt > 0 && now - m.openMessageAt < OPEN_MESSAGE_WINDOW) ||
        (m.runningToolAt > 0 && now - m.runningToolAt < RUNNING_PART_WINDOW));
    const turnOpen = !!m && m.lastOtherAt > m.lastIdleAt && now - m.lastOtherAt < OPEN_TURN_WINDOW;
    s.streaming = streaming;
    s.working = streaming || turnOpen;
    const agg = byAgent.get(s.agent);
    if (agg && s.working) {
      agg.working = true;
      agg.workingSessions += 1;
      agg.streaming = agg.streaming || streaming;
    }
  }
  totals.working = agents.some((a) => a.working);
  totals.streaming = agents.some((a) => a.streaming);
  totals.workingSessions = agents.reduce((n, a) => n + a.workingSessions, 0);
}
