/**
 * Lectores de prompts de Claude Code y Codex: traducen sus registros de sesión a los mensajes de
 * `promptFlow.ts` y reutilizan el mismo armado (fin de turno, tramos, tokens y coste). Solo
 * lectura: nunca se escribe nada en `~/.claude` ni en `~/.codex`.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { isSamePath } from "../agents/paths";
import { plainText, projectSessionsDir, sessionFiles } from "../providers/claude";
import { codexHome } from "../providers/codex";
import { LOOKBACK_MS, promptsFromSessions, type Msg, type PromptBuildOptions, type PromptScanResult } from "./promptFlow";

/** Nombre de la fila de la sesión principal, el mismo que en el Explorador. */
const CLAUDE_LANE = "CLAUDE";
const CODEX_LANE = "CODEX";

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function time(value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function mtime(file: string): { at: number; sig: string } | undefined {
  try {
    const st = statSync(file);
    return { at: st.mtimeMs, sig: `${st.mtimeMs}:${st.size}` };
  } catch {
    return undefined;
  }
}

function emptyMsg(session: string, seq: number, type: string, at: number): Msg {
  return {
    session,
    seq,
    type,
    created: at,
    updated: at,
    agent: "",
    provider: "",
    model: "",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    text: "",
  };
}

function setTokens(msg: Msg, input: number, output: number, reasoning: number, cacheRead: number, cacheWrite: number): void {
  msg.tokens = { input, output, reasoning, cacheRead, cacheWrite, total: input + output + reasoning + cacheRead + cacheWrite };
}

/** Mensajes por sesión con lo anterior a `floor` fuera, y el árbol de cada raíz. */
function assemble(
  roots: Array<{ root: string; files: Array<{ session: string; msgs: Msg[] }> }>,
  floor: number,
  options: PromptBuildOptions
): PromptScanResult {
  const trees = new Map<string, Set<string>>();
  const bySession = new Map<string, Msg[]>();
  for (const { root, files } of roots) {
    const tree = trees.get(root) ?? new Set<string>();
    trees.set(root, tree);
    for (const { session, msgs } of files) {
      tree.add(session);
      const list = bySession.get(session) ?? [];
      bySession.set(session, list);
      for (const msg of msgs) {
        if (msg.created >= floor) {
          list.push(msg);
        }
      }
    }
  }
  return promptsFromSessions(trees, bySession, options);
}

/* ------------------------------- Claude Code ------------------------------ */

const claudeCache = new Map<string, { sig: string; msgs: Msg[] }>();
/**
 * Clave de origen de cada mensaje (`uuid` de la línea; `message.id` en los assistant). Al
 * reanudar (`claude --continue`) el CLI copia el historial en el `.jsonl` nuevo con los mismos
 * `uuid`, `message.id` y `timestamp`: con esta clave lo copiado se cuenta una sola vez.
 */
const claudeKey = new WeakMap<Msg, string>();

/** Texto del mensaje de usuario si es un prompt de verdad; `undefined` si no lo es. */
function claudePromptText(line: Json): string | undefined {
  // El resumen de `/compact` llega como `user`, pero lo escribe el CLI.
  if (line.isMeta === true || line.isSidechain === true || line.isCompactSummary === true) {
    return undefined;
  }
  const message = obj(line.message);
  if (message?.role !== "user") {
    return undefined;
  }
  const content = message.content;
  let raw: string;
  if (typeof content === "string") {
    raw = content;
  } else if (Array.isArray(content)) {
    // Los resultados de herramientas también llegan como `user`: no son prompts.
    if (content.some((part) => obj(part)?.type === "tool_result")) {
      return undefined;
    }
    raw = content.map((part) => (obj(part)?.type === "text" ? str(obj(part)?.text) : "")).join("\n");
  } else {
    return undefined;
  }
  const origin = obj(line.origin);
  if (origin) {
    // Los CLI recientes marcan el origen: avisos de tareas y relevos de subagentes no son prompts.
    return origin.kind === "human" ? plainText(raw) || raw.trim() : undefined;
  }
  // Sin origen (CLI viejos, y `/compact` en los nuevos): fuera comandos, su salida y las
  // interrupciones.
  const text = plainText(raw);
  return text && !text.startsWith("/") && !text.startsWith("[Request interrupted") ? text : undefined;
}

/**
 * Mensajes de un transcript de Claude. Un assistant por `message.id` (el CLI escribe una línea por
 * bloque con el mismo `usage`); empieza en la línea anterior del fichero, que es cuando salió la
 * petición, y acaba en su última línea. `turn_duration` es el fin de turno (`idle`).
 */
function parseClaude(file: string, session: string, agent: string, main: boolean): Msg[] {
  const stat = mtime(file);
  const cached = claudeCache.get(file);
  if (stat && cached && cached.sig === stat.sig) {
    return cached.msgs;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const msgs: Msg[] = [];
  const byId = new Map<string, Msg>();
  let prev = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Filtro barato antes de parsear: los adjuntos y los volcados de petición pesan mucho.
    if (!raw.includes('"type":"user"') && !raw.includes('"type":"assistant"') && !raw.includes("turn_duration")) {
      continue;
    }
    let line: Json | undefined;
    try {
      line = obj(JSON.parse(raw));
    } catch {
      continue; // Línea a medio escribir de una sesión viva.
    }
    const at = time(line?.timestamp);
    if (!line || at <= 0) {
      continue;
    }
    // ponytail: las líneas de subagente dentro del transcript principal (CLI viejos) se ignoran.
    if (main && line.isSidechain === true) {
      continue;
    }
    if (line.type === "system") {
      // Con subagentes en segundo plano pendientes el turno no ha acabado: al terminar, el CLI
      // retoma la sesión y escribe otro `turn_duration`.
      if (main && line.subtype === "turn_duration" && !num(line.pendingBackgroundAgentCount)) {
        const msg = emptyMsg(session, i, "idle", at);
        claudeKey.set(msg, str(line.uuid));
        msgs.push(msg);
      }
      continue;
    }
    if (line.type === "user") {
      const prompt = main ? claudePromptText(line) : undefined;
      if (prompt !== undefined) {
        const msg = emptyMsg(session, i, "user", at);
        claudeKey.set(msg, str(line.uuid));
        msg.text = prompt;
        msgs.push(msg);
      }
      prev = at;
      continue;
    }
    if (line.type !== "assistant") {
      continue;
    }
    const message = obj(line.message);
    const id = str(message?.id) || str(line.uuid) || `${i}`;
    let msg = byId.get(id);
    if (!msg) {
      msg = emptyMsg(session, i, "assistant", prev > 0 && prev <= at ? prev : at);
      msg.agent = agent;
      msg.provider = "anthropic";
      byId.set(id, msg);
      claudeKey.set(msg, str(message?.id) || str(line.uuid));
      msgs.push(msg);
    }
    msg.completed = at;
    msg.updated = at;
    msg.model = str(message?.model) || msg.model;
    const usage = obj(message?.usage);
    if (usage) {
      const output = num(usage.output_tokens);
      const thinking = Math.min(output, num(obj(usage.output_tokens_details)?.thinking_tokens));
      setTokens(
        msg,
        num(usage.input_tokens),
        output - thinking,
        thinking,
        num(usage.cache_read_input_tokens),
        num(usage.cache_creation_input_tokens)
      );
    }
    prev = at;
  }
  if (stat) {
    claudeCache.set(file, { sig: stat.sig, msgs });
  }
  return msgs;
}

/** Subagentes de una sesión: cada `agent-*.jsonl` con el `agentType` de su `.meta.json`. */
function claudeSubagents(sessionDir: string, floor: number, seen: Set<string>): Array<{ session: string; msgs: Msg[] }> {
  const dir = path.join(sessionDir, "subagents");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return []; // Sesión sin subagentes.
  }
  const out: Array<{ session: string; msgs: Msg[] }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if ((mtime(file)?.at ?? 0) < floor) {
      continue;
    }
    seen.add(file);
    const stem = name.slice(0, -".jsonl".length);
    let agent = "";
    try {
      agent = str(obj(JSON.parse(readFileSync(path.join(dir, `${stem}.meta.json`), "utf8")))?.agentType).trim();
    } catch {
      // Sin meta todavía: se pinta como subagente sin nombre.
    }
    const session = `claude:${path.basename(sessionDir)}:${stem}`;
    out.push({ session, msgs: parseClaude(file, session, agent || "(subagente)", false) });
  }
  return out;
}

export function scanClaudePrompts(options: PromptBuildOptions): PromptScanResult {
  const dir = projectSessionsDir(options.project);
  if (!dir) {
    return { ok: true, prompts: [], completed: [] };
  }
  const floor = options.since - LOOKBACK_MS;
  const seen = new Set<string>();
  const roots: Array<{ root: string; files: Array<{ session: string; msgs: Msg[] }> }> = [];
  for (const file of sessionFiles(dir)) {
    if ((mtime(file)?.at ?? 0) < floor) {
      break; // Vienen del más reciente al más viejo.
    }
    seen.add(file);
    const id = path.basename(file, ".jsonl");
    const root = `claude:${id}`;
    const files = [{ session: root, msgs: parseClaude(file, root, CLAUDE_LANE, true) }];
    files.push(...claudeSubagents(path.join(dir, id), floor, seen));
    roots.push({ root, files });
  }
  // La caché sólo guarda lo que sigue en la ventana.
  for (const file of claudeCache.keys()) {
    if (!seen.has(file)) {
      claudeCache.delete(file);
    }
  }
  // Del más viejo al más nuevo: el original se queda y lo copiado al reanudar se descarta
  // entero (prompt, respuestas y fin de turno), sobre copias para no tocar la caché.
  const known = new Set<string>();
  for (let r = roots.length - 1; r >= 0; r--) {
    for (const file of roots[r].files) {
      file.msgs = file.msgs.filter((msg) => {
        const key = claudeKey.get(msg);
        if (!key) {
          return true;
        }
        if (known.has(key)) {
          return false;
        }
        known.add(key);
        return true;
      });
    }
  }
  return assemble(roots, floor, options);
}

/* ---------------------------------- Codex --------------------------------- */

interface CodexRollout {
  sig: string;
  at: number;
  cwd: string;
  id: string;
  msgs: Msg[];
}

const codexCache = new Map<string, CodexRollout>();

type ZstdZlib = typeof zlib & { zstdDecompressSync?: (buf: Buffer) => Buffer };

/** Texto de un mensaje de usuario sin el contexto que inyecta Codex (`<environment_context>`, AGENTS.md...). */
function codexUserText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => str(obj(part)?.text).trim())
    .filter((t) => t && !t.startsWith("<") && !t.startsWith("# AGENTS.md"))
    .join("\n");
}

/**
 * Un rollout de Codex. Cada turno va de `task_started` a `task_complete`/`turn_aborted` (`idle`);
 * cada `token_count` es una petición que empieza donde acabó la anterior. El `token_count` repetido
 * (mismo acumulado) no suma otra vez.
 */
function parseCodex(text: string): Omit<CodexRollout, "sig" | "at"> {
  let cwd = "";
  let id = "";
  let model = "";
  let prev = 0;
  let lastTotal = -1;
  let turnUser: Msg | undefined;
  const msgs: Msg[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line: Json | undefined;
    try {
      line = obj(JSON.parse(lines[i]));
    } catch {
      continue;
    }
    const payload = obj(line?.payload);
    const at = time(line?.timestamp);
    if (!line || !payload || at <= 0) {
      continue;
    }
    if (line.type === "session_meta") {
      cwd = str(payload.cwd);
      id = str(payload.id) || str(payload.session_id);
      continue;
    }
    if (line.type === "turn_context") {
      model = str(payload.model) || model;
      continue;
    }
    if (line.type === "response_item" && payload.type === "message" && payload.role === "user") {
      if (turnUser && !turnUser.text) {
        turnUser.text = codexUserText(payload.content);
      }
      continue;
    }
    if (line.type !== "event_msg") {
      continue;
    }
    const kind = payload.type;
    if (kind === "task_started") {
      turnUser = emptyMsg("", i, "user", at);
      msgs.push(turnUser);
      prev = at;
    } else if (kind === "user_message") {
      if (turnUser && !turnUser.text) {
        turnUser.text = str(payload.message).trim();
      }
    } else if (kind === "task_complete" || kind === "turn_aborted") {
      msgs.push(emptyMsg("", i, "idle", at));
      turnUser = undefined;
    } else if (kind === "token_count") {
      const info = obj(payload.info);
      const last = obj(info?.last_token_usage);
      const total = num(obj(info?.total_token_usage)?.total_tokens);
      if (!last || total === lastTotal) {
        continue;
      }
      lastTotal = total;
      const msg = emptyMsg("", i, "assistant", prev > 0 && prev <= at ? prev : at);
      msg.completed = at;
      msg.agent = CODEX_LANE;
      msg.provider = "openai";
      msg.model = model;
      // `input_tokens` y `output_tokens` ya incluyen lo cacheado y el razonamiento.
      const cacheRead = num(last.cached_input_tokens);
      const cacheWrite = num(last.cache_write_input_tokens);
      const output = num(last.output_tokens);
      const reasoning = Math.min(output, num(last.reasoning_output_tokens));
      setTokens(
        msg,
        Math.max(0, num(last.input_tokens) - cacheRead - cacheWrite),
        output - reasoning,
        reasoning,
        cacheRead,
        cacheWrite
      );
      msgs.push(msg);
      prev = at;
    }
  }
  const session = `codex:${id}`;
  for (const msg of msgs) {
    msg.session = session;
  }
  return { cwd, id, msgs };
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function scanCodexPrompts(options: PromptBuildOptions): PromptScanResult {
  const base = path.join(codexHome(), "sessions");
  const floor = options.since - LOOKBACK_MS;
  const unzstd = (zlib as ZstdZlib).zstdDecompressSync;
  let error: string | undefined;
  const seen = new Set<string>();
  // Una sesión reanudada escribe en su rollout original, así que no se poda por carpeta de fecha.
  // ponytail: un `stat` por rollout en cada sondeo; podar por fecha si llegan a ser miles.
  const bySessionId = new Map<string, CodexRollout>();
  for (const year of subdirs(base)) {
    for (const month of subdirs(path.join(base, year))) {
      for (const day of subdirs(path.join(base, year, month))) {
        const dir = path.join(base, year, month, day);
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => n.startsWith("rollout-") && (n.endsWith(".jsonl") || n.endsWith(".jsonl.zst")));
        } catch {
          continue;
        }
        for (const name of names) {
          const file = path.join(dir, name);
          const stat = mtime(file);
          if (!stat || stat.at < floor) {
            continue;
          }
          seen.add(file);
          let rollout = codexCache.get(file);
          if (!rollout || rollout.sig !== stat.sig) {
            const zst = name.endsWith(".zst");
            if (zst && !unzstd) {
              error = "Este VS Code no trae zstd (Node 22.15+): no se pueden leer las sesiones comprimidas de Codex.";
              continue;
            }
            try {
              const buf = readFileSync(file);
              const text = (zst && unzstd ? unzstd(buf) : buf).toString("utf8");
              rollout = { sig: stat.sig, at: stat.at, ...parseCodex(text) };
            } catch {
              continue; // Ilegible o a medio comprimir: se reintenta en el siguiente sondeo.
            }
            codexCache.set(file, rollout);
          }
          if (!rollout.id || !isSamePath(rollout.cwd, options.project)) {
            continue;
          }
          // El mismo rollout en `.jsonl` y `.jsonl.zst` mientras se comprime: gana el más nuevo.
          const prev = bySessionId.get(rollout.id);
          if (!prev || prev.at < rollout.at) {
            bySessionId.set(rollout.id, rollout);
          }
        }
      }
    }
  }
  for (const file of codexCache.keys()) {
    if (!seen.has(file)) {
      codexCache.delete(file);
    }
  }
  const roots = [...bySessionId.values()].map((r) => {
    const root = `codex:${r.id}`;
    return { root, files: [{ session: root, msgs: r.msgs }] };
  });
  const result = assemble(roots, floor, options);
  return error ? { ...result, error } : result;
}
