/**
 * Lectura y edición de la configuración de Codex (`~/.codex/config.toml`) para el
 * Explorador. Las escrituras son quirúrgicas: solo tocan la clave pedida, vía
 * `setValue` de `toml.ts`, y el fichero solo se reescribe si el texto cambia.
 */
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  type Dirent,
} from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { isSamePath } from "../agents/paths";
import { parseAgentFile } from "../agents/parser";
import { writeAtomic } from "../agents/store";
import type { ExplorerAgent, ExplorerCatalogItem } from "../panels/explorerPanel";
import type { ContextWindowInfo } from "../stats/contextWindow";
import { findTable, getValue, listTables, setValue } from "./toml";

export interface CodexExplorer {
  agents: { project: ExplorerAgent[]; global: ExplorerAgent[]; builtin: ExplorerAgent[] };
  mcp: ExplorerCatalogItem[];
  skills: ExplorerCatalogItem[];
  plugins: ExplorerCatalogItem[];
  autoAccept: boolean;
  /** Tokens del proyecto: histórico de rollouts y sesión en curso. */
  tokens: CodexTokens;
}

/* --------------------------------- rutas --------------------------------- */

export function codexHome(): string {
  const dir = process.env.CODEX_HOME?.trim();
  return dir ? path.normalize(dir) : path.join(os.homedir(), ".codex");
}

export function codexConfigFile(): string {
  return path.join(codexHome(), "config.toml");
}

export function codexInstructionsFile(
  scope: "project" | "global",
  projectRoot: string | undefined
): string {
  if (scope === "global") {
    return path.join(codexHome(), "AGENTS.md");
  }
  if (!projectRoot) {
    throw new Error("No hay un proyecto abierto.");
  }
  // El mismo AGENTS.md que lee opencode en el proyecto: aquí solo se devuelve la ruta.
  return path.join(projectRoot, "AGENTS.md");
}

/* --------------------------------- lectura -------------------------------- */

function readConfig(): string {
  try {
    return readFileSync(codexConfigFile(), "utf8");
  } catch {
    return "";
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function readAgents(text: string, file: string): ExplorerAgent[] {
  return listTables(text, ["agents"])
    .map((name) => ({
      name,
      // Los agentes de Codex son roles de multiagente: siempre globales y sin actividad.
      mode: "subagent" as const,
      scope: "global" as const,
      description: getValue(text, ["agents", name], "description"),
      filePath: file,
      working: false,
      streaming: false,
      tokens: 0,
      // Los rollouts de Codex no dicen qué rol gastó los tokens: cada fila va a 0 y el
      // total del proyecto viaja en CodexExplorer.tokens.
      tokensTotal: 0,
      tokensSession: 0,
      workMs: 0,
      cost: 0,
    }))
    .sort(byName);
}

function readMcp(text: string, file: string): ExplorerCatalogItem[] {
  return listTables(text, ["mcp_servers"])
    .map((name) => {
      const table = ["mcp_servers", name];
      const command = getValue(text, table, "command")?.trim();
      return {
        name,
        scope: "global" as const,
        // `enabled` ausente = servidor activo.
        enabled: getValue(text, table, "enabled") !== "false",
        detail: command || (getValue(text, table, "url") ? "http" : undefined),
        filePath: file,
      };
    })
    .sort(byName);
}

function readSkills(): ExplorerCatalogItem[] {
  const dir = path.join(codexHome(), "skills");
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExplorerCatalogItem[] = [];
  for (const entry of entries) {
    // `.system` son las skills internas de Codex: no se listan.
    if (!entry.isDirectory() || entry.name === ".system") {
      continue;
    }
    const file = path.join(dir, entry.name, "SKILL.md");
    try {
      const { frontmatter } = parseAgentFile(readFileSync(file, "utf8"));
      out.push({
        name: entry.name,
        scope: "global",
        enabled: true,
        // Codex no documenta forma de desactivar una skill: solo se muestra.
        toggleable: false,
        detail: frontmatter.description,
        filePath: file,
      });
    } catch {
      // Sin SKILL.md o con frontmatter ilegible: no es una skill utilizable.
    }
  }
  return out.sort(byName);
}

function readPlugins(text: string, file: string): ExplorerCatalogItem[] {
  return listTables(text, ["plugins"])
    .map((name) => {
      const at = name.lastIndexOf("@");
      return {
        name,
        scope: "global" as const,
        enabled: getValue(text, ["plugins", name], "enabled") !== "false",
        detail: at > 0 ? name.slice(at + 1) : undefined,
        filePath: file,
      };
    })
    .sort(byName);
}

export function codexExplorer(projectRoot: string | undefined): CodexExplorer {
  const file = codexConfigFile();
  const text = readConfig();
  return {
    agents: { project: [], global: readAgents(text, file), builtin: [] },
    mcp: readMcp(text, file),
    skills: readSkills(),
    plugins: readPlugins(text, file),
    autoAccept: getValue(text, [], "approval_policy") === "never",
    tokens: codexTokens(projectRoot),
  };
}

/* -------------------------------- contexto -------------------------------- */

let contextCache: { key: string; info: ContextWindowInfo } | undefined;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Los 20 rollouts más recientes. La carpeta y el nombre llevan la fecha, así que ordenan solos. */
function recentRollouts(): string[] {
  const base = path.join(codexHome(), "sessions");
  const out: string[] = [];
  for (const year of subdirs(base).sort().reverse()) {
    for (const month of subdirs(path.join(base, year)).sort().reverse()) {
      for (const day of subdirs(path.join(base, year, month)).sort().reverse()) {
        const dir = path.join(base, year, month, day);
        let names: string[];
        try {
          names = readdirSync(dir).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const name of names.sort().reverse()) {
          out.push(path.join(dir, name));
          if (out.length >= 20) {
            return out;
          }
        }
      }
    }
  }
  return out;
}

/** Cabecera del rollout sin leer el fichero entero. */
function firstLine(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(65536);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, read);
    const end = text.indexOf("\n");
    return end < 0 ? text : text.slice(0, end);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

type RolloutLine = { type?: string; payload?: Record<string, unknown> };

function parseLine<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined; // Línea a medio escribir de una sesión viva.
  }
}

/** Rollouts del proyecto, de más nuevo a más viejo (se miran como mucho 20). */
function rolloutsFor(root: string): string[] {
  // shortcut: sólo se lee la cabecera (64 KB); un session_meta mayor no casaría.
  const out: string[] = [];
  for (const file of recentRollouts()) {
    const meta = parseLine<RolloutLine>(firstLine(file));
    const cwd = meta?.type === "session_meta" ? meta.payload?.cwd : undefined;
    if (typeof cwd === "string" && isSamePath(cwd, root)) {
      out.push(file);
    }
  }
  return out;
}

/** Título del hilo: Codex lo guarda aparte, en `session_index.jsonl`. */
function threadTitle(id: string): string | undefined {
  if (!id) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(path.join(codexHome(), "session_index.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(id)) {
      continue;
    }
    const item = parseLine<{ id?: unknown; thread_name?: unknown }>(line);
    if (item?.id === id && typeof item.thread_name === "string" && item.thread_name.trim()) {
      return item.thread_name.trim();
    }
  }
  return undefined;
}

function noSession(scannedAt: number): ContextWindowInfo {
  return {
    ok: false,
    error: "Ninguna sesión de Codex de este proyecto tiene una respuesta medida todavía.",
    used: 0,
    limit: 0,
    slices: [],
    scannedAt,
  };
}

/** Firma de caché de un fichero: ruta + fecha + tamaño. */
function fileSignature(file: string): string {
  try {
    const st = statSync(file);
    return `${file}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${file}:0:0`;
  }
}

/** Último uso medido del rollout; `undefined` si no hay ninguno. */
function readContext(file: string, scannedAt: number): ContextWindowInfo | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let sessionId = "";
  let model = "";
  let used = 0;
  let limit = 0;
  for (const line of text.split("\n")) {
    // Los tres tipos que importan; el resto del rollout (mensajes, tools) no se parsea.
    if (
      !line.includes('"session_meta"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"token_count"')
    ) {
      continue;
    }
    const item = parseLine<RolloutLine>(line);
    const payload = item?.payload;
    if (item?.type === "session_meta") {
      if (typeof payload?.session_id === "string") {
        sessionId = payload.session_id;
      }
      continue;
    }
    if (item?.type === "turn_context") {
      if (typeof payload?.model === "string" && payload.model.trim()) {
        model = payload.model.trim();
      }
      continue;
    }
    if (item?.type === "event_msg" && payload?.type === "token_count") {
      const info = payload.info as
        | { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown }
        | null
        | undefined;
      // `info: null` sólo refresca los rate limits: no borra la última medición.
      if (!info) {
        continue;
      }
      // Tras compactar, `used` no cambia hasta el siguiente `token_count` con uso.
      used = num(info.last_token_usage?.total_tokens);
      limit = num(info.model_context_window) || limit;
    }
  }
  if (used <= 0) {
    return undefined;
  }
  return {
    ok: true,
    sessionId: sessionId || undefined,
    title: threadTitle(sessionId),
    agent: "codex",
    model: model || undefined,
    used,
    limit,
    slices: [{ key: "conversation", label: "Conversación", tokens: used, estimated: false }],
    scannedAt,
  };
}

/** Contexto de la sesión más reciente del proyecto con medición; cacheado por firmas. */
export function codexContext(projectRoot: string | undefined): ContextWindowInfo {
  const scannedAt = Date.now();
  const files = projectRoot ? rolloutsFor(projectRoot) : [];
  if (files.length === 0) {
    return noSession(scannedAt);
  }
  const key = files.map(fileSignature).join("|");
  if (contextCache?.key === key) {
    return contextCache.info;
  }
  let info = noSession(scannedAt);
  for (const file of files) {
    const measured = readContext(file, scannedAt);
    if (measured) {
      info = measured;
      break;
    }
  }
  contextCache = { key, info };
  return info;
}

/* --------------------------------- tokens --------------------------------- */

export interface CodexTokens {
  /** Suma del último uso medido de cada rollout del proyecto. */
  total: number;
  /** Último uso medido del rollout más reciente: la sesión en curso. */
  session: number;
}

/** Tokens por rollout, cacheados por firma: un fichero solo se relee si cambió. */
const rolloutTokensCache = new Map<string, { sig: string; tokens: number }>();

/** Último `last_token_usage.total_tokens` del rollout; 0 si no tiene medición. */
function rolloutTokens(file: string): number {
  const sig = fileSignature(file);
  const hit = rolloutTokensCache.get(file);
  if (hit && hit.sig === sig) {
    return hit.tokens;
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // Rollout borrado o ilegible: se queda a 0.
  }
  let tokens = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) {
      continue;
    }
    const payload = parseLine<RolloutLine>(line)?.payload;
    if (payload?.type !== "token_count") {
      continue;
    }
    const info = payload.info as
      | { last_token_usage?: { total_tokens?: unknown } }
      | null
      | undefined;
    // `info: null` sólo refresca los rate limits: no borra la última medición.
    if (!info) {
      continue;
    }
    tokens = num(info.last_token_usage?.total_tokens);
  }
  if (rolloutTokensCache.size > 100) {
    // El tope queda por encima de la ventana de 20 rollouts que se recorre: desalojar la
    // entrada más vieja nunca obliga a releer un fichero de la pasada.
    const oldest = rolloutTokensCache.keys().next().value;
    if (oldest !== undefined) {
      rolloutTokensCache.delete(oldest);
    }
  }
  rolloutTokensCache.set(file, { sig, tokens });
  return tokens;
}

/**
 * Tokens del proyecto de Codex: el histórico de sus rollouts y el de la sesión en curso.
 * shortcut: solo mira los 20 rollouts más recientes (ver recentRollouts).
 */
export function codexTokens(projectRoot: string | undefined): CodexTokens {
  let total = 0;
  for (const file of projectRoot ? rolloutsFor(projectRoot) : []) {
    total += rolloutTokens(file);
  }
  return { total, session: codexContext(projectRoot).used };
}

/* -------------------------------- escritura ------------------------------- */

/** Lee, aplica y escribe solo si el texto cambia. Un config ausente se trata como vacío. */
async function editConfig(apply: (text: string) => string): Promise<void> {
  const file = codexConfigFile();
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    // Sin config.toml: se parte de vacío y lo que decida `apply`.
  }
  const next = apply(text);
  if (next !== text) {
    await writeAtomic(file, next);
  }
}

export async function setCodexItem(
  kind: "mcp" | "skill" | "plugin",
  name: string,
  on: boolean
): Promise<void> {
  if (kind === "skill") {
    throw new Error("Codex no permite activar ni desactivar skills desde la configuración.");
  }
  const table = kind === "mcp" ? ["mcp_servers", name] : ["plugins", name];
  await editConfig((text) => {
    if (!findTable(text, table)) {
      throw new Error(
        kind === "mcp"
          ? "Ese servidor MCP no está en la configuración de Codex."
          : "Ese plugin no está en la configuración de Codex."
      );
    }
    return setValue(text, table, "enabled", on);
  });
}

export async function setCodexAutoAccept(on: boolean): Promise<void> {
  await editConfig((text) => setValue(text, [], "approval_policy", on ? "never" : "on-request"));
}
