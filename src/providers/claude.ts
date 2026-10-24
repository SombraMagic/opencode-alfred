import {
  closeSync,
  existsSync,
  fstatSync,
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
import { applyEdits, FormattingOptions, modify, parse as parseJsonc, ParseError } from "jsonc-parser";
import { parseAgentFile } from "../agents/parser";
import { isSamePath } from "../agents/paths";
import { writeAtomic } from "../agents/store";
import type { ExplorerAgent, ExplorerCatalogItem } from "../panels/explorerPanel";
import type { ModelEntry } from "../panels/modelsPanel";
import type { ContextWindowInfo } from "../stats/contextWindow";

export type ClaudeScope = "project" | "global";

export interface ClaudeExplorer {
  agents: { project: ExplorerAgent[]; global: ExplorerAgent[]; builtin: ExplorerAgent[] };
  mcp: ExplorerCatalogItem[];
  skills: ExplorerCatalogItem[];
  plugins: ExplorerCatalogItem[];
  autoAccept: boolean;
  /** Agentes en marcha ahora mismo (la sesión principal se llama `claude`). */
  activity: ClaudeActivity[];
}

type JsonObject = Record<string, unknown>;

const FMT: FormattingOptions = { insertSpaces: true, tabSize: 2 };

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/* --------------------------------- rutas --------------------------------- */

export function claudeHome(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.normalize(dir) : path.join(os.homedir(), ".claude");
}

/** Estado global de la app. Con CLAUDE_CONFIG_DIR, Claude mueve también `.claude.json` ahí. */
function globalStateFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(path.normalize(dir), ".claude.json") : path.join(os.homedir(), ".claude.json");
}

function settingsFile(): string {
  return path.join(claudeHome(), "settings.json");
}

function installedPluginsFile(): string {
  return path.join(claudeHome(), "plugins", "installed_plugins.json");
}

function projectAgentsDir(root: string): string {
  return path.join(root, ".claude", "agents");
}

function projectSkillsDir(root: string): string {
  return path.join(root, ".claude", "skills");
}

function projectMcpFile(root: string): string {
  return path.join(root, ".mcp.json");
}

function projectLocalSettingsFile(root: string): string {
  return path.join(root, ".claude", "settings.local.json");
}

export function claudeAgentFile(
  name: string,
  scope: ClaudeScope,
  projectRoot: string | undefined
): string | undefined {
  if (scope === "project") {
    return projectRoot ? path.join(projectAgentsDir(projectRoot), `${name}.md`) : undefined;
  }
  return path.join(claudeHome(), "agents", `${name}.md`);
}

export function claudeInstructionsFile(scope: ClaudeScope, projectRoot: string | undefined): string {
  if (scope === "global") {
    return path.join(claudeHome(), "CLAUDE.md");
  }
  if (!projectRoot) {
    throw new Error("No hay un proyecto abierto.");
  }
  const claudeMd = path.join(projectRoot, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    return claudeMd;
  }
  // Sin CLAUDE.md, Claude carga el AGENTS.md del proyecto.
  const agentsMd = path.join(projectRoot, "AGENTS.md");
  return existsSync(agentsMd) ? agentsMd : claudeMd;
}

/* --------------------------------- lectura -------------------------------- */

/** JSON de configuración; un fichero ausente o roto se trata como vacío. */
function readJson(file: string): JsonObject | undefined {
  try {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
    return errors.length === 0 ? asObject(parsed) : undefined;
  } catch {
    return undefined;
  }
}

function readAgents(dir: string, scope: ClaudeScope): ExplorerAgent[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExplorerAgent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const file = path.join(dir, entry.name);
    try {
      const { frontmatter } = parseAgentFile(readFileSync(file, "utf8"));
      out.push({
        name: entry.name.slice(0, -3),
        mode: "subagent",
        scope,
        description: frontmatter.description,
        model: frontmatter.model,
        color: frontmatter.color,
        filePath: file,
        working: false,
        streaming: false,
        tokens: 0,
        workMs: 0,
        cost: 0,
      });
    } catch {
      // Frontmatter ilegible: se omite ese agente y la lista sigue.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readSkills(dir: string, scope: ClaudeScope): ExplorerCatalogItem[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExplorerCatalogItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(dir, entry.name, "SKILL.md");
    try {
      const { frontmatter } = parseAgentFile(readFileSync(file, "utf8"));
      out.push({
        name: entry.name,
        scope,
        // Claude no documenta forma de desactivar una skill: solo se muestra.
        enabled: true,
        toggleable: false,
        detail: frontmatter.description,
        filePath: file,
      });
    } catch {
      // Sin SKILL.md o con frontmatter ilegible: no es una skill utilizable.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function mcpDetail(entry: JsonObject): string | undefined {
  if (typeof entry.command === "string" && entry.command.trim()) {
    return entry.command;
  }
  return typeof entry.type === "string" || typeof entry.url === "string" ? "http" : undefined;
}

/** Servidores `name → entrada` de un mapa `mcpServers`; las entradas que no son objeto se omiten. */
function mcpEntries(servers: unknown): Array<{ name: string; entry: JsonObject }> {
  const map = asObject(servers);
  if (!map) {
    return [];
  }
  return Object.entries(map)
    .map(([name, entry]) => ({ name, entry: asObject(entry) }))
    .filter((item): item is { name: string; entry: JsonObject } => item.entry !== undefined);
}

function readMcpFile(file: string): Array<{ name: string; entry: JsonObject }> {
  return mcpEntries(readJson(file)?.mcpServers);
}

/**
 * Estados de `~/.claude.json` de este proyecto. La misma carpeta puede estar anotada
 * varias veces cambiando la caja de la unidad; se casan todas con `isSamePath`.
 */
function projectStates(projectRoot: string): JsonObject[] {
  const projects = asObject(readJson(globalStateFile())?.projects);
  if (!projects) {
    return [];
  }
  return Object.entries(projects)
    .filter(([dir]) => isSamePath(dir, projectRoot))
    .map(([, state]) => asObject(state))
    .filter((state): state is JsonObject => state !== undefined);
}

function readMcp(projectRoot: string | undefined): ExplorerCatalogItem[] {
  const out: ExplorerCatalogItem[] = [];
  const globalFile = globalStateFile();
  const states = projectRoot ? projectStates(projectRoot) : [];
  const disabled = new Set<string>();
  for (const state of states) {
    const names = state.disabledMcpServers;
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === "string") {
          disabled.add(name);
        }
      }
    }
  }
  for (const { name, entry } of readMcpFile(globalFile)) {
    out.push({
      name,
      scope: "global",
      enabled: !disabled.has(name),
      detail: mcpDetail(entry),
      filePath: globalFile,
      // Los MCP globales viven en ~/.claude.json, que también guarda credenciales: solo se leen.
      toggleable: false,
    });
  }
  if (!projectRoot) {
    return out;
  }
  // Locales del proyecto: también en ~/.claude.json (`projects[<ruta>].mcpServers`). Con
  // varias claves para la misma carpeta se juntan por nombre; gana la última.
  const local = new Map<string, JsonObject>();
  for (const state of states) {
    for (const { name, entry } of mcpEntries(state.mcpServers)) {
      local.set(name, entry);
    }
  }
  for (const [name, entry] of local) {
    out.push({
      name,
      scope: "project",
      enabled: !disabled.has(name),
      detail: mcpDetail(entry),
      filePath: globalFile,
      toggleable: false,
    });
  }
  // Compartidos: `<raíz>/.mcp.json`, aprobados desde settings.local.json (sí se escribe).
  const file = projectMcpFile(projectRoot);
  const disabledJson = readJson(projectLocalSettingsFile(projectRoot))?.disabledMcpjsonServers;
  const disabledNames = Array.isArray(disabledJson)
    ? disabledJson.filter((n) => typeof n === "string")
    : [];
  for (const { name, entry } of readMcpFile(file)) {
    out.push({
      name,
      scope: "project",
      enabled: !disabledNames.includes(name),
      detail: mcpDetail(entry),
      filePath: file,
    });
  }
  return out;
}

function readPlugins(settings: JsonObject | undefined): ExplorerCatalogItem[] {
  const installed = asObject(readJson(installedPluginsFile())?.plugins);
  if (!installed) {
    return [];
  }
  const enabledMap = asObject(settings?.enabledPlugins) ?? {};
  return Object.keys(installed)
    .map((name) => {
      const installs = installed[name];
      const first = Array.isArray(installs) ? asObject(installs[0]) : undefined;
      return {
        name,
        scope: "global" as const,
        enabled: enabledMap[name] === true,
        detail: typeof first?.version === "string" ? first.version : undefined,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `permissions.defaultMode` de settings.json, sin interpretar. */
export function claudePermissionMode(): string | undefined {
  const mode = asObject(readJson(settingsFile())?.permissions)?.defaultMode;
  return typeof mode === "string" ? mode : undefined;
}

export function claudeExplorer(projectRoot: string | undefined): ClaudeExplorer {
  const settings = readJson(settingsFile());
  const defaultMode = claudePermissionMode();
  const activity = claudeActivity(projectRoot);
  const withActivity = (agents: ExplorerAgent[]): ExplorerAgent[] =>
    agents.map((agent) => {
      const live = activity.find((a) => a.agent === agent.name);
      return live ? { ...agent, working: true, streaming: live.streaming } : agent;
    });
  return {
    agents: {
      project: projectRoot ? withActivity(readAgents(projectAgentsDir(projectRoot), "project")) : [],
      global: withActivity(readAgents(path.join(claudeHome(), "agents"), "global")),
      builtin: [],
    },
    mcp: readMcp(projectRoot),
    skills: [
      ...readSkills(path.join(claudeHome(), "skills"), "global"),
      ...(projectRoot ? readSkills(projectSkillsDir(projectRoot), "project") : []),
    ],
    plugins: readPlugins(settings),
    // `auto` es el modo automático del CLI; `bypassPermissions`, aceptar sin ningún filtro.
    // `acceptEdits` solo acepta ediciones: no es "aceptar todo".
    autoAccept: defaultMode === "auto" || defaultMode === "bypassPermissions",
    activity,
  };
}

/* --------------------------------- modelos -------------------------------- */

export interface ClaudeModels {
  models: ModelEntry[];
  /** Modelo efectivo de las sesiones nuevas como `claude/<modelo>`; vacío si no hay. */
  currentModel: string;
}

/** Sufijo de ventana (`[1m]`): no forma parte del nombre, pero decide el límite. */
const MODEL_SUFFIX = /\[[^\]]*\]$/;

/** Variables con las que Claude Code elige modelo, de más a menos prioridad. */
const MODEL_ENV_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/** Variable de modelo: manda el `env` de settings.json y, si falta, el entorno. */
function envModel(settings: JsonObject | undefined, name: string): string {
  const fromFile = asObject(settings?.env)?.[name];
  if (typeof fromFile === "string" && fromFile.trim()) {
    return fromFile.trim();
  }
  const fromProcess = process.env[name];
  return typeof fromProcess === "string" ? fromProcess.trim() : "";
}

/** Modelo con el que arrancan las sesiones nuevas: `ANTHROPIC_MODEL` tapa a `settings.model`. */
function effectiveModel(settings: JsonObject | undefined): string {
  const fromEnv = envModel(settings, "ANTHROPIC_MODEL");
  if (fromEnv) {
    return fromEnv;
  }
  const configured = settings?.model;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return envModel(settings, "ANTHROPIC_DEFAULT_MODEL");
}

/** Carpeta de sesiones del proyecto: la ruta con todo lo no alfanumérico en `-`. */
function projectSessionsDir(root: string): string | undefined {
  const base = path.join(claudeHome(), "projects");
  const slug = root.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  try {
    // La caja del slug cambia entre versiones de Claude: se compara sin distinguirla.
    const name = readdirSync(base).find((entry) => entry.toLowerCase() === slug);
    return name ? path.join(base, name) : undefined;
  } catch {
    return undefined;
  }
}

/** Los cinco `.jsonl` más recientes de la carpeta. */
function recentSessionFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ file: string; at: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) {
      continue;
    }
    const file = path.join(dir, entry.name);
    try {
      files.push({ file, at: statSync(file).mtimeMs });
    } catch {
      // Sesión borrada entre el listado y el stat.
    }
  }
  return files
    .sort((a, b) => b.at - a.at)
    .slice(0, 5)
    .map((item) => item.file);
}

/**
 * Claude no publica catálogo local: los modelos salen del configurado, de sus
 * variables de entorno, del `modelPicker` de settings y de los que ya usaron las
 * sesiones de este proyecto. Sin nada de eso queda una lista vacía.
 */
export function claudeModels(projectRoot: string | undefined): ClaudeModels {
  const settings = readJson(settingsFile());
  const current = effectiveModel(settings);
  const seen = new Set<string>();
  const models: ModelEntry[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const name = value.trim();
    // `[1m]` es una variante de ventana, no el mismo modelo: cada forma va aparte.
    if (!name || name === "<synthetic>" || seen.has(name.toLowerCase())) {
      return;
    }
    seen.add(name.toLowerCase());
    models.push({ id: `claude/${name}`, provider: "claude", model: name, name, free: false });
  };
  // El efectivo va primero: es el que usan las sesiones nuevas.
  add(current);
  const picker = asObject(settings?.modelPicker)?.options;
  if (Array.isArray(picker)) {
    for (const row of picker) {
      add(asObject(row)?.model);
    }
  }
  for (const key of MODEL_ENV_VARS) {
    add(envModel(settings, key));
  }
  const dir = projectRoot ? projectSessionsDir(projectRoot) : undefined;
  for (const file of dir ? recentSessionFiles(dir) : []) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      // Filtro barato: solo las líneas del assistant llevan `message.model`.
      if (!line.includes('"assistant"')) {
        continue;
      }
      let model: unknown;
      try {
        const item = JSON.parse(line) as { type?: string; message?: { model?: unknown } };
        model = item.type === "assistant" ? item.message?.model : undefined;
      } catch {
        continue; // Línea a medio escribir de una sesión viva.
      }
      add(model);
    }
  }
  return { models, currentModel: current ? `claude/${current}` : "" };
}

/* -------------------------------- contexto -------------------------------- */

let contextCache: { key: string; info: ContextWindowInfo } | undefined;

type ClaudeLine = {
  type?: string;
  message?: { model?: unknown; usage?: Record<string, unknown>; content?: unknown };
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Quita las etiquetas XML con su contenido: los comandos locales no son parte del mensaje. */
function plainText(text: string): string {
  return text
    .replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, " ")
    .replace(/<\/?[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Primer mensaje de usuario que no sea un comando local, en 60 caracteres. */
function sessionTitle(content: unknown): string | undefined {
  const raw = Array.isArray(content)
    ? (content.find((part) => (part as { type?: unknown })?.type === "text") as
        | { text?: unknown }
        | undefined)?.text
    : content;
  const text = typeof raw === "string" ? plainText(raw) : "";
  return text ? text.slice(0, 60) : undefined;
}

/**
 * Ventana por convenio del sufijo. `message.model` llega sin él (`deepseek-flash`), así que
 * si coincide con el configurado se usa el configurado (`deepseek-flash[1m]`).
 */
function contextLimit(model: string): number {
  // shortcut: ventana por convenio del sufijo; no hay catálogo local de Claude.
  const configured = effectiveModel(readJson(settingsFile()));
  const name = configured.replace(MODEL_SUFFIX, "").toLowerCase() === model.toLowerCase()
    ? configured
    : model;
  return MODEL_SUFFIX.test(name) ? 1_000_000 : 200_000;
}

/** Último assistant con uso real y primer mensaje del usuario; `undefined` si no hay medición. */
function readContext(
  file: string,
  sessionId: string,
  scannedAt: number
): ContextWindowInfo | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  // Los comandos locales (`<synthetic>`) llegan con todo a cero: no pisan la última medición.
  // Tras compactar, `used` sigue siendo el de antes hasta la siguiente respuesta medida.
  let used = 0;
  let model = "";
  let title: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) {
      continue;
    }
    let item: ClaudeLine;
    try {
      item = JSON.parse(line) as ClaudeLine;
    } catch {
      continue; // Línea a medio escribir de una sesión viva.
    }
    if (item.type === "assistant") {
      const usage = item.message?.usage;
      if (usage) {
        const total =
          num(usage.input_tokens) +
          num(usage.cache_read_input_tokens) +
          num(usage.cache_creation_input_tokens);
        if (total > 0) {
          used = total;
          model = typeof item.message?.model === "string" ? item.message.model.trim() : "";
        }
      }
      continue;
    }
    if (item.type === "user" && !title) {
      title = sessionTitle(item.message?.content);
    }
  }
  if (used <= 0) {
    return undefined;
  }
  return {
    ok: true,
    sessionId,
    title,
    agent: "claude",
    model: model || undefined,
    used,
    limit: contextLimit(model),
    slices: [{ key: "conversation", label: "Conversación", tokens: used, estimated: false }],
    scannedAt,
  };
}

function noSession(scannedAt: number): ContextWindowInfo {
  return {
    ok: false,
    error: "Ninguna sesión de Claude de este proyecto tiene una respuesta medida todavía.",
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

/** Contexto de la sesión más reciente del proyecto que tenga medición; cacheado por firmas. */
export function claudeContext(projectRoot: string | undefined): ContextWindowInfo {
  const scannedAt = Date.now();
  const dir = projectRoot ? projectSessionsDir(projectRoot) : undefined;
  const files = dir ? recentSessionFiles(dir) : [];
  if (files.length === 0) {
    return noSession(scannedAt);
  }
  const key = [settingsFile(), ...files].map(fileSignature).join("|");
  if (contextCache?.key === key) {
    return contextCache.info;
  }
  let info = noSession(scannedAt);
  for (const file of files) {
    const measured = readContext(file, path.basename(file, ".jsonl"), scannedAt);
    if (measured) {
      info = measured;
      break;
    }
  }
  contextCache = { key, info };
  return info;
}

/* ------------------------------ sesiones vivas ----------------------------- */

export interface ClaudeLiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  kind?: string;
  name?: string;
  status?: string;
  startedAt?: number;
}

/** `kill(pid, 0)` no mata: solo pregunta. `EPERM` significa que existe, pero es de otro usuario. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Sesiones de Claude vivas (proceso existente) para este proyecto, la más reciente primero.
 * Sin carpeta abierta no hay proyecto con el que casar: lista vacía.
 */
export function claudeLiveSessions(projectRoot: string | undefined): ClaudeLiveSession[] {
  if (!projectRoot) {
    return [];
  }
  const dir = path.join(claudeHome(), "sessions");
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ClaudeLiveSession[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }
    let item: JsonObject | undefined;
    try {
      item = asObject(JSON.parse(readFileSync(path.join(dir, entry.name), "utf8")));
    } catch {
      continue; // Fichero a medio escribir o de otra versión.
    }
    const pid = item?.pid;
    const sessionId = item?.sessionId;
    const cwd = item?.cwd;
    if (typeof pid !== "number" || typeof sessionId !== "string" || typeof cwd !== "string") {
      continue;
    }
    if (!pidAlive(pid) || !isSamePath(cwd, projectRoot)) {
      continue;
    }
    out.push({
      pid,
      sessionId,
      cwd,
      kind: typeof item?.kind === "string" ? item.kind : undefined,
      name: typeof item?.name === "string" ? item.name : undefined,
      status: typeof item?.status === "string" ? item.status : undefined,
      startedAt: typeof item?.startedAt === "number" ? item.startedAt : undefined,
    });
  }
  // Una sesión en segundo plano no tiene terminal: si hay interactivas, mandan ellas.
  const interactive = out.filter((session) => session.kind !== "bg");
  return (interactive.length > 0 ? interactive : out).sort(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)
  );
}

export interface ClaudeActivity {
  agent: string;
  streaming: boolean;
}

/** Un transcript tocado en los últimos 3 s se considera generando (no dentro de una tool). */
const STREAMING_WINDOW_MS = 3000;

function writtenRecently(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs <= STREAMING_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Agentes en marcha ahora mismo: la sesión principal (`claude`) si su registro está
 * `busy`/`waiting`, y los subagentes con meta sin `finished`. El CLI escribe ese meta al
 * lanzarlos, así que su ausencia marca la ejecución.
 */
export function claudeActivity(projectRoot: string | undefined): ClaudeActivity[] {
  const dir = projectRoot ? projectSessionsDir(projectRoot) : undefined;
  if (!dir) {
    return [];
  }
  const live = new Map<string, boolean>();
  const add = (agent: string, streaming: boolean): void => {
    live.set(agent, (live.get(agent) ?? false) || streaming);
  };
  for (const session of claudeLiveSessions(projectRoot)) {
    if (session.status === "busy" || session.status === "waiting") {
      add("claude", writtenRecently(path.join(dir, `${session.sessionId}.jsonl`)));
    }
    const subagents = path.join(dir, session.sessionId, "subagents");
    let entries: Dirent[];
    try {
      entries = readdirSync(subagents, { withFileTypes: true });
    } catch {
      continue; // Sesión sin subagentes.
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".meta.json")) {
        continue;
      }
      const meta = readJson(path.join(subagents, entry.name));
      const agent = meta?.agentType;
      if (meta?.finished === true || typeof agent !== "string" || !agent.trim()) {
        continue;
      }
      const transcript = `${entry.name.slice(0, -".meta.json".length)}.jsonl`;
      add(agent, writtenRecently(path.join(subagents, transcript)));
    }
  }
  return [...live].map(([agent, streaming]) => ({ agent, streaming }));
}

export interface ClaudeSessionMode {
  mode: string;
  /** Posición absoluta del evento en el transcript: cambia cuando el CLI anota otro turno. */
  offset: number;
}

/**
 * Último modo de permisos anotado en el transcript de la sesión. El CLI escribe un
 * evento `permission-mode` al empezar cada turno; con su posición se distingue un
 * evento nuevo de uno ya leído. Se busca hacia atrás por si el último turno fue enorme.
 */
export function claudeSessionMode(
  projectRoot: string | undefined,
  sessionId: string
): ClaudeSessionMode | undefined {
  const dir = projectRoot ? projectSessionsDir(projectRoot) : undefined;
  if (!dir) {
    return undefined;
  }
  const chunk = 1024 * 1024;
  try {
    const fd = openSync(path.join(dir, `${sessionId}.jsonl`), "r");
    try {
      const size = fstatSync(fd).size;
      // Se busca el byte literal: así el offset no se mezcla con índices de caracteres.
      const needle = Buffer.from('"type":"permission-mode","permissionMode":"');
      // 8 MiB de tope: el evento de un turno normal queda mucho más cerca.
      for (let end = size; end > 0 && size - end <= 8 * chunk; end = Math.max(0, end - chunk)) {
        const start = Math.max(0, end - chunk);
        // Solape corto con el bloque siguiente por si el evento cae en el corte.
        const readEnd = Math.min(size, end + 512);
        const buffer = Buffer.alloc(readEnd - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const at = buffer.lastIndexOf(needle);
        if (at >= 0) {
          const from = at + needle.length;
          const quote = buffer.indexOf(0x22, from);
          if (quote > from) {
            return {
              mode: buffer.subarray(from, quote).toString("utf8"),
              offset: start + at,
            };
          }
        }
        if (start === 0) {
          break;
        }
      }
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Pulsaciones de Shift+Tab para pasar de un modo a otro. El CLI cicla
 * `auto → default → acceptEdits → plan → auto` (los modos opcionales van tras plan).
 */
export function claudeModePresses(from: string | undefined, to: string): number | undefined {
  const cycle = ["auto", "default", "acceptEdits", "plan"];
  const source = from === "manual" ? "default" : from;
  const a = source ? cycle.indexOf(source) : -1;
  const b = cycle.indexOf(to);
  return a < 0 || b < 0 ? undefined : (b - a + cycle.length) % cycle.length;
}

/* -------------------------------- escritura ------------------------------- */

async function modifyJsonFile(
  file: string,
  keyPath: Array<string | number>,
  value: unknown
): Promise<void> {
  let text = "{}\n";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    // No existe: se crea con el contenido mínimo.
  }
  if (text.trim()) {
    const errors: ParseError[] = [];
    parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new Error(`${path.basename(file)} tiene un JSON inválido; no se ha modificado.`);
    }
  }
  const edits = modify(text, keyPath, value, { formattingOptions: FMT });
  if (edits.length > 0) {
    await writeAtomic(file, applyEdits(text, edits));
  }
}

export async function setClaudeItem(
  kind: "mcp" | "skill" | "plugin",
  name: string,
  scope: ClaudeScope,
  on: boolean,
  projectRoot: string | undefined
): Promise<void> {
  if (kind === "skill") {
    throw new Error("Claude no permite activar ni desactivar skills desde la configuración.");
  }
  if (kind === "mcp") {
    if (scope !== "project" || !projectRoot) {
      throw new Error("Los servidores MCP globales de Claude no se pueden desactivar desde aquí.");
    }
    const file = projectLocalSettingsFile(projectRoot);
    const current = readJson(file)?.disabledMcpjsonServers;
    const list = Array.isArray(current) ? current.filter((n): n is string => typeof n === "string") : [];
    const next = on
      ? list.filter((n) => n !== name)
      : list.includes(name)
        ? list
        : [...list, name];
    // Sin nombres desactivados, la clave sobra: quitarla deja el fichero como estaba.
    await modifyJsonFile(file, ["disabledMcpjsonServers"], next.length > 0 ? next : undefined);
    return;
  }
  const installed = asObject(readJson(installedPluginsFile())?.plugins) ?? {};
  if (!Object.prototype.hasOwnProperty.call(installed, name)) {
    throw new Error("Ese plugin no está instalado.");
  }
  await modifyJsonFile(settingsFile(), ["enabledPlugins", name], on);
}

export async function setClaudeAutoAccept(on: boolean): Promise<void> {
  // `auto` aprueba sin preguntar y respeta las reglas deny; `acceptEdits` solo acepta
  // ediciones. Al desactivar se escribe `default` (manual): desde 2.1.283 el CLI arranca
  // en `auto` por su cuenta, así que borrar la clave no apagaría nada.
  await modifyJsonFile(settingsFile(), ["permissions", "defaultMode"], on ? "auto" : "default");
}

/** Escribe `model` en settings.json: Claude lo lee al arrancar cada sesión. */
export async function setClaudeModel(id: string): Promise<void> {
  const prefix = "claude/";
  if (!id.startsWith(prefix)) {
    throw new Error("Ese modelo no es de Claude.");
  }
  const model = id.slice(prefix.length).trim();
  if (!model) {
    throw new Error("Falta el nombre del modelo.");
  }
  const file = settingsFile();
  await modifyJsonFile(file, ["model"], model);
  // `ANTHROPIC_MODEL` tapa a `model`: si está puesta, se escribe también en `env`
  // (gana al entorno del sistema) para que la elección llegue a las sesiones nuevas.
  if (envModel(readJson(file), "ANTHROPIC_MODEL")) {
    await modifyJsonFile(file, ["env", "ANTHROPIC_MODEL"], model);
  }
}
