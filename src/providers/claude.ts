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
import { parseAgentFile, serializeAgentFile } from "../agents/parser";
import { isSamePath } from "../agents/paths";
import { writeAtomic } from "../agents/store";
import type { AgentFrontmatter } from "../agents/types";
import type { ValidationIssue } from "../agents/validate";
import type { ExplorerAgent, ExplorerCatalogItem } from "../panels/explorerPanel";
import type { ModelEntry, ModelGroup } from "../panels/modelsPanel";
import type { ContextWindowInfo } from "../stats/contextWindow";

export type ClaudeScope = "project" | "global";

export interface ClaudeExplorer {
  agents: { project: ExplorerAgent[]; global: ExplorerAgent[]; builtin: ExplorerAgent[] };
  mcp: ExplorerCatalogItem[];
  skills: ExplorerCatalogItem[];
  plugins: ExplorerCatalogItem[];
  autoAccept: boolean;
  /** Agentes en marcha ahora mismo (la sesión principal se llama `CLAUDE`). */
  activity: ClaudeActivity[];
  /** Tokens del proyecto: histórico, última sesión y subagentes. */
  tokens: ClaudeTokens;
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
export function globalStateFile(): string {
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
        // Sin transcript propio conocido: los rellena claudeTokens cuando lo haya.
        tokensTotal: 0,
        tokensSession: 0,
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
      // No hay interruptor en settings: se pide `/mcp disable|enable` a la sesión y el
      // CLI lo persiste por proyecto. ~/.claude.json no se escribe a mano (guarda la cuenta).
      toggleable: true,
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
      // Igual que los de usuario: se alternan desde la sesión, no escribiendo el fichero.
      toggleable: true,
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
  const tokens = claudeTokens(projectRoot);
  const activity = claudeActivity(projectRoot);
  const withActivity = (agents: ExplorerAgent[]): ExplorerAgent[] =>
    agents.map((agent) => {
      const live = activity.find((a) => a.agent === agent.name);
      // Cada fila lleva lo suyo: la sesión principal el histórico del proyecto, un subagente
      // el de su último transcript. Sin dato, 0 (el panel pinta «—»).
      const own = tokens.byAgent.get(agent.name) ?? 0;
      const main = agent.mode === "builtin";
      return {
        ...agent,
        working: !!live,
        streaming: live?.streaming === true,
        tokensTotal: main ? tokens.total : own,
        tokensSession: main ? tokens.session : own,
      };
    });
  return {
    agents: {
      project: projectRoot ? withActivity(readAgents(projectAgentsDir(projectRoot), "project")) : [],
      global: withActivity(readAgents(path.join(claudeHome(), "agents"), "global")),
      // Claude no publica agentes integrados: la única fila es la sesión principal.
      builtin: withActivity([
        {
          name: "CLAUDE",
          mode: "builtin",
          scope: "builtin",
          filePath: claudeInstructionsFile(projectRoot ? "project" : "global", projectRoot),
          working: false,
          streaming: false,
          tokens: 0,
          tokensTotal: 0,
          tokensSession: 0,
          workMs: 0,
          cost: 0,
        },
      ]),
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
    tokens,
  };
}

/* --------------------------------- modelos -------------------------------- */

export interface ClaudeModels {
  models: ModelEntry[];
  /** Modelo efectivo de las sesiones nuevas como `claude/<modelo>`; vacío si no hay. */
  currentModel: string;
  title: string;
  note: string;
  groups: ModelGroup[];
  clearable: boolean;
  subagent: { model: string; source: string; clearable: boolean };
}

/** Sufijo de ventana (`[1m]`): no forma parte del nombre, pero decide el límite. */
const MODEL_SUFFIX = /\[[^\]]*\]$/;

/** Alias oficiales de Claude, en el orden del selector del CLI. */
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku", "opusplan"] as const;

/** Variable de modelo en el `env` del fichero (sin caer al entorno). */
function fileEnvModel(settings: JsonObject | undefined, name: string): string {
  const fromFile = asObject(settings?.env)?.[name];
  return typeof fromFile === "string" ? fromFile.trim() : "";
}

/** Variable de modelo: manda el `env` de settings.json y, si falta, el entorno. */
function envModel(settings: JsonObject | undefined, name: string): string {
  const fromFile = fileEnvModel(settings, name);
  if (fromFile) {
    return fromFile;
  }
  const fromProcess = process.env[name];
  return typeof fromProcess === "string" ? fromProcess.trim() : "";
}

/** Host del endpoint configurado, para la cabecera y el grupo del proveedor. */
function baseHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return ""; // Base inválida: se pinta «CLAUDE» a secas.
  }
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

/** Los `.jsonl` de la carpeta, del más reciente al más viejo; `limit` corta la lista. */
function sessionFiles(dir: string, limit?: number): string[] {
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
    .slice(0, limit ?? files.length)
    .map((item) => item.file);
}

/* ------------------------- catálogo del proveedor ------------------------- */

const PROVIDER_TTL_MS = 5 * 60 * 1000;

/** Última consulta al endpoint configurado; `undefined` si nunca se hizo. */
let providerCache: { at: number; host: string; models: string[]; base: string } | undefined;
/** Consulta en vuelo: dos llamadas seguidas comparten la misma promesa. */
let providerInflight: Promise<void> | undefined;

/** Modelos que ofrece el endpoint configurado en Claude; `undefined` hasta la primera consulta. */
export function claudeProviderCatalog(): { host: string; models: string[] } | undefined {
  return providerCache ? { host: providerCache.host, models: providerCache.models } : undefined;
}

/** Una respuesta 200 con lista de modelos; `undefined` en cualquier otro caso. */
async function fetchModels(url: string, token: string): Promise<string[] | undefined> {
  try {
    const res = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as unknown;
    const obj = asObject(body);
    const rows = Array.isArray(body) ? body : Array.isArray(obj?.data) ? obj.data : obj?.models;
    if (!Array.isArray(rows)) {
      return undefined;
    }
    const seen = new Set<string>();
    const models: string[] = [];
    for (const row of rows) {
      const item = asObject(row);
      const candidate = typeof row === "string" ? row : (item?.id ?? item?.name);
      if (typeof candidate !== "string") {
        continue;
      }
      const id = candidate.trim();
      // `<synthetic>` es un marcador del CLI, no un modelo del catálogo.
      if (!id || id === "<synthetic>" || seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push(id);
    }
    return models;
  } catch {
    // Red caída, timeout o respuesta ilegible: silencio. El token nunca sale en un mensaje.
    return undefined;
  }
}

async function loadProviderCatalog(): Promise<void> {
  const settings = readJson(settingsFile());
  const base = envModel(settings, "ANTHROPIC_BASE_URL");
  const token = envModel(settings, "ANTHROPIC_AUTH_TOKEN") || envModel(settings, "ANTHROPIC_API_KEY");
  const host = baseHost(base);
  // Solo https: no se manda el token a un endpoint en claro. Sin host válido, tampoco.
  if (!base || !host || !token || !base.startsWith("https://")) {
    providerCache = { at: Date.now(), host: "", models: [], base };
    return;
  }
  if (providerCache && providerCache.base === base && Date.now() - providerCache.at < PROVIDER_TTL_MS) {
    return;
  }
  const trimmed = base.replace(/\/+$/, "");
  // El host del endpoint sirve `/models`; el prefijo `anthropic` añade `/v1/models`.
  for (const url of [`${trimmed}/v1/models`, `${new URL(base).origin}/models`]) {
    const models = await fetchModels(url, token);
    if (models) {
      providerCache = { at: Date.now(), host, models, base };
      return;
    }
  }
  providerCache = { at: Date.now(), host, models: [], base };
}

/** Consulta el catálogo si toca (caché de 5 minutos) y nunca lanza. */
export async function refreshClaudeProvider(): Promise<void> {
  if (providerInflight) {
    return providerInflight;
  }
  providerInflight = loadProviderCatalog()
    .catch(() => {
      // Contrato: esta función nunca lanza; un fallo raro deja el catálogo como esté.
    })
    .finally(() => {
      providerInflight = undefined;
    });
  return providerInflight;
}

/**
 * Claude no publica catálogo local: los modelos salen del alias oficial y su mapeo,
 * del endpoint configurado (si respondió) y de los que ya usaron las sesiones de este
 * proyecto. El efectivo puede no estar en ningún grupo: no se fuerza.
 */
export function claudeModels(projectRoot: string | undefined): ClaudeModels {
  const settings = readJson(settingsFile());
  const current = effectiveModel(settings);
  const fromFile = fileEnvModel(settings, "ANTHROPIC_MODEL");
  const fromProcess = (process.env.ANTHROPIC_MODEL ?? "").trim();
  const configured = typeof settings?.model === "string" ? settings.model.trim() : "";
  const base = envModel(settings, "ANTHROPIC_BASE_URL");
  const host = baseHost(base);
  // Un catálogo de otra base no sirve para esta.
  const catalog = providerCache && providerCache.base === base ? providerCache : undefined;

  const aliasGroup: ModelGroup = {
    name: "ALIAS DE CLAUDE",
    models: CLAUDE_ALIASES.map((alias) => {
      const mapped = envModel(settings, `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`);
      return {
        id: `claude/${alias}`,
        provider: "alias",
        model: alias,
        name: alias,
        free: false,
        hint: mapped ? `→ ${mapped}` : "alias oficial",
      };
    }),
  };
  const providerGroup: ModelGroup | undefined = catalog?.models.length
    ? {
        name: host,
        models: catalog.models.map((id) => ({
          id: `claude/${id}`,
          provider: "proveedor",
          model: id,
          name: id,
          free: false,
        })),
      }
    : undefined;

  const groups = [aliasGroup, providerGroup].filter((g): g is ModelGroup => !!g);
  // Sin distinguir caja, como antes: dos sesiones no deben pintar la misma fila dos veces.
  const seen = new Set(groups.flatMap((g) => g.models.map((m) => m.id.toLowerCase())));
  const seenModels: ModelEntry[] = [];
  const dir = projectRoot ? projectSessionsDir(projectRoot) : undefined;
  for (const file of dir ? sessionFiles(dir, 5) : []) {
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
      if (typeof model !== "string") {
        continue;
      }
      const name = model.trim();
      const id = `claude/${name}`;
      // `[1m]` es una variante de ventana, no el mismo modelo: cada forma va aparte.
      if (!name || name === "<synthetic>" || seen.has(id.toLowerCase())) {
        continue;
      }
      seen.add(id.toLowerCase());
      seenModels.push({ id, provider: "sesión", model: name, name, free: false });
    }
  }
  if (seenModels.length > 0) {
    groups.push({ name: "VISTOS EN SESIONES", models: seenModels });
  }

  const subFile = fileEnvModel(settings, "CLAUDE_CODE_SUBAGENT_MODEL");
  const subProcess = (process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim();
  const note = fromFile
    ? "ANTHROPIC_MODEL en settings.json · sesiones nuevas; la actual, con /model"
    : fromProcess
      ? "ANTHROPIC_MODEL del entorno · sesiones nuevas; la actual, con /model"
      : configured
        ? "model en settings.json · sesiones nuevas; la actual, con /model"
        : envModel(settings, "ANTHROPIC_DEFAULT_MODEL")
          ? "ANTHROPIC_DEFAULT_MODEL · sesiones nuevas; la actual, con /model"
          : "heredado del proveedor · sesiones nuevas; la actual, con /model";

  return {
    models: groups.flatMap((g) => g.models),
    currentModel: current ? `claude/${current}` : "",
    title: host ? `CLAUDE · ${host}` : "CLAUDE",
    note,
    groups,
    clearable: !!(fromFile || configured),
    subagent: {
      model: envModel(settings, "CLAUDE_CODE_SUBAGENT_MODEL") || current,
      source: subFile ? "settings" : subProcess ? "entorno" : "principal",
      clearable: !!subFile,
    },
  };
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
        const total = usageTotal(usage);
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
  const files = dir ? sessionFiles(dir, 5) : [];
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

/* --------------------------------- tokens --------------------------------- */

export interface ClaudeTokens {
  /** Histórico del proyecto: suma de todos los transcripts de sesión de su carpeta. */
  total: number;
  /** La sesión más reciente del proyecto. */
  session: number;
  /** Tokens del último transcript de cada subagente, por nombre de agente. */
  byAgent: Map<string, number>;
}

/** Tokens por transcript, cacheados por firma: un fichero solo se relee si cambió. */
const transcriptCache = new Map<string, { sig: string; tokens: number }>();

/** Uso medido de un mensaje: la misma cuenta que la ventana de contexto. */
function usageTotal(usage: Record<string, unknown> | undefined): number {
  return (
    num(usage?.input_tokens) +
    num(usage?.cache_read_input_tokens) +
    num(usage?.cache_creation_input_tokens)
  );
}

/** Suma del uso de los assistant de un transcript; 0 si no se puede leer. */
function transcriptTokens(file: string): number {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of text.split("\n")) {
    // Filtro barato: el uso solo viaja en las líneas del assistant.
    if (!line.includes('"usage"')) {
      continue;
    }
    let item: ClaudeLine;
    try {
      item = JSON.parse(line) as ClaudeLine;
    } catch {
      continue; // Línea a medio escribir de una sesión viva.
    }
    if (item.type === "assistant") {
      total += usageTotal(item.message?.usage);
    }
  }
  return total;
}

function cachedTranscriptTokens(file: string): number {
  const sig = fileSignature(file);
  const hit = transcriptCache.get(file);
  if (hit && hit.sig === sig) {
    return hit.tokens;
  }
  const tokens = transcriptTokens(file);
  // Sin desalojo a propósito: `claudeTokens` recorre TODOS los transcripts del proyecto en
  // cada pasada, así que cualquier tope por debajo de ese número relee los desalojados en
  // cada sondeo (medido con 500 ficheros y tope 400: 501 lecturas por pasada).
  transcriptCache.set(file, { sig, tokens });
  return tokens;
}

/** Fecha de modificación del fichero; 0 si no se puede leer. */
function fileTime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** El transcript más nuevo de cada subagente de una sesión, por nombre de agente. */
function subagentTokens(sessionDir: string): Map<string, number> {
  const dir = path.join(sessionDir, "subagents");
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Map(); // Sesión sin subagentes.
  }
  const newest = new Map<string, { at: number; tokens: number }>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const stem = entry.name.slice(0, -".jsonl".length);
    // El meta es el que dice a qué agente pertenece el transcript.
    const agent = readJson(path.join(dir, `${stem}.meta.json`))?.agentType;
    if (typeof agent !== "string" || !agent.trim()) {
      continue;
    }
    const file = path.join(dir, entry.name);
    const at = fileTime(file);
    const prev = newest.get(agent);
    if (prev && prev.at >= at) {
      continue;
    }
    // Solo se leen los transcripts que ganan: uno por agente.
    newest.set(agent, { at, tokens: cachedTranscriptTokens(file) });
  }
  return new Map([...newest].map(([agent, item]) => [agent, item.tokens]));
}

/**
 * Tokens del proyecto de Claude: el histórico, el de su sesión más reciente y el último
 * transcript de cada subagente. Cacheado por firma de fichero.
 */
export function claudeTokens(projectRoot: string | undefined): ClaudeTokens {
  const dir = projectRoot ? projectSessionsDir(projectRoot) : undefined;
  // shortcut: el histórico suma los transcripts de sesión (raíz de la carpeta), no los de
  // subagente: sumarlos costaría releer una veintena de ficheros por sesión en cada sondeo.
  const files = dir ? sessionFiles(dir) : [];
  let total = 0;
  for (const file of files) {
    total += cachedTranscriptTokens(file);
  }
  return {
    total,
    session: files.length > 0 ? cachedTranscriptTokens(files[0]) : 0,
    byAgent:
      dir && files.length > 0
        ? subagentTokens(path.join(dir, path.basename(files[0], ".jsonl")))
        : new Map(),
  };
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
 * Agentes en marcha ahora mismo: la sesión principal (`CLAUDE`) si su registro está
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
      add("CLAUDE", writtenRecently(path.join(dir, `${session.sessionId}.jsonl`)));
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

/** Suelta `model` y `env.ANTHROPIC_MODEL`: manda lo que diga el entorno o el proveedor. */
export async function clearClaudeModel(): Promise<void> {
  const file = settingsFile();
  await modifyJsonFile(file, ["env", "ANTHROPIC_MODEL"], undefined);
  await modifyJsonFile(file, ["model"], undefined);
}

/** Fija el modelo de los subagentes en `env`; sin valor, heredan del principal. */
export async function setClaudeSubagentModel(id: string | undefined): Promise<void> {
  const prefix = "claude/";
  const raw = (id ?? "").trim();
  const model = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  await modifyJsonFile(settingsFile(), ["env", "CLAUDE_CODE_SUBAGENT_MODEL"], model || undefined);
}

/* ---------------------------- agentes (subagentes) --------------------------- */

/** Paleta de Claude: el CLI solo pinta nombres, un hex no se ve. */
export const CLAUDE_AGENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

/** Herramientas del CLI que se ofrecen por defecto; los MCP van como `mcp__servidor__*`. */
export const CLAUDE_AGENT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "PowerShell",
  "Glob",
  "Grep",
  "LSP",
  "WebFetch",
  "WebSearch",
  "Agent",
  "TodoWrite",
  "NotebookEdit",
  "Skill",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "TaskStop",
  "SendMessage",
  "Artifact",
  "ListAgents",
] as const;

const CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
  "manual",
] as const;

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Claves que escribe este editor; el resto del frontmatter se conserva tal cual. */
const CLAUDE_MANAGED_KEYS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "color",
  "permissionMode",
  "effort",
  "maxTurns",
  "skills",
  "memory",
  "isolation",
  "omitClaudeMd",
  "background",
]);

export interface ClaudeAgentFields {
  description: string;
  /** Tal cual: admite `mcp__servidor__*` y `Agent(tipo1, tipo2)`. */
  tools: string[];
  /** "", sonnet, opus, haiku, fable, id completo o inherit. */
  model: string;
  /** "", o un nombre de `CLAUDE_AGENT_COLORS`. */
  color: string;
  permissionMode: string;
  effort: string;
  /** Número válido o el texto tecleado, para que la validación pueda señalarlo. */
  maxTurns?: number | string;
  skills: string[];
  memory: string;
  isolation: string;
  omitClaudeMd: boolean;
  background: boolean;
}

export interface ClaudeAgentData {
  file: string;
  name: string;
  /** El original completo, con las claves que este editor no gestiona. */
  frontmatter: AgentFrontmatter;
  prompt: string;
  fields: ClaudeAgentFields;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Lista de `tools`/`skills`: array YAML o cadena separada por comas. Las comas dentro
 * de paréntesis (`Agent(explore, general)`) no separan entradas.
 */
function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(trimmed).filter((item) => item !== "");
  }
  const text = trimmed(value);
  if (!text) {
    return [];
  }
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * `maxTurns` del YAML o del panel: número válido, o el texto tal cual (aunque no sea
 * numérico) para que el editor lo muestre y la validación lo marque. Nunca `NaN`.
 */
function maxTurnsOf(value: unknown): number | string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** Lee un fichero de agente de Claude y normaliza los campos gestionables. */
export function readClaudeAgent(file: string): ClaudeAgentData {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No existe el fichero del agente ${path.basename(file)}.`);
  }
  let parsed: ReturnType<typeof parseAgentFile>;
  try {
    parsed = parseAgentFile(text);
  } catch (err) {
    throw new Error(
      `${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const fm = parsed.frontmatter;
  return {
    file,
    name: trimmed(fm.name) || path.basename(file, ".md"),
    frontmatter: fm,
    prompt: parsed.prompt,
    fields: {
      description: trimmed(fm.description),
      tools: splitList(fm.tools),
      model: trimmed(fm.model),
      color: trimmed(fm.color),
      permissionMode: trimmed(fm.permissionMode),
      effort: trimmed(fm.effort),
      maxTurns: maxTurnsOf(fm.maxTurns),
      skills: splitList(fm.skills),
      memory: trimmed(fm.memory),
      isolation: trimmed(fm.isolation),
      omitClaudeMd: fm.omitClaudeMd === true,
      background: fm.background === true,
    },
  };
}

/** Alias oficiales con su mapeo actual (`ANTHROPIC_DEFAULT_*_MODEL`), para el desplegable. */
export function claudeModelAliases(): { alias: string; mapped: string }[] {
  const settings = readJson(settingsFile());
  return CLAUDE_ALIASES.map((alias) => ({
    alias,
    mapped: envModel(settings, `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`),
  }));
}

/** Valida nombre y campos; `file` excluye el propio fichero de la comprobación de duplicados. */
export function validateClaudeAgent(
  name: string,
  fields: ClaudeAgentFields,
  scope: ClaudeScope,
  projectRoot: string | undefined,
  file?: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const key = trimmed(name);

  if (!key) {
    issues.push({ level: "error", field: "name", message: "El nombre es obligatorio." });
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(key)) {
    issues.push({
      level: "error",
      field: "name",
      message: "Usa minúsculas, dígitos, punto, guion y guion bajo (sin espacios ni dos puntos).",
    });
  } else if (key.length > 256) {
    issues.push({
      level: "error",
      field: "name",
      message: "El nombre no puede pasar de 256 caracteres.",
    });
  } else {
    const existing = claudeAgentFile(key, scope, projectRoot);
    if (existing && existsSync(existing) && (!file || !isSamePath(existing, file))) {
      issues.push({
        level: "error",
        field: "name",
        message: `Ya existe un agente "${key}" en ese scope.`,
      });
    }
  }

  if (scope === "project" && !projectRoot) {
    issues.push({
      level: "error",
      field: "scope",
      message: "Abre una carpeta de proyecto para guardar un agente de proyecto.",
    });
  }

  if (!trimmed(fields.description)) {
    // Sin descripción, Claude descarta el agente y el fichero no sirve de nada.
    issues.push({
      level: "error",
      field: "description",
      message: "La descripción es obligatoria: sin ella, Claude omite el agente.",
    });
  }

  const color = trimmed(fields.color);
  if (color && !(CLAUDE_AGENT_COLORS as readonly string[]).includes(color)) {
    issues.push({
      level: "error",
      field: "color",
      message: `color debe ser uno de: ${CLAUDE_AGENT_COLORS.join(", ")}.`,
    });
  }

  const model = trimmed(fields.model);
  const knownModel =
    !model ||
    model === "inherit" ||
    (CLAUDE_ALIASES as readonly string[]).includes(model) ||
    model.startsWith("claude-");
  if (!knownModel) {
    issues.push({
      level: "warning",
      field: "model",
      message: `"${model}" no es un alias de Claude: se enviará tal cual al proveedor.`,
    });
  }

  const mode = trimmed(fields.permissionMode);
  if (mode && !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    issues.push({
      level: "warning",
      field: "permissionMode",
      message: "Claude no reconoce ese valor; se guardará tal cual.",
    });
  } else if (mode === "bypassPermissions" || mode === "dontAsk") {
    issues.push({
      level: "warning",
      field: "permissionMode",
      message: `"${mode}" no pregunta nada al usuario: el subagente actúa sin confirmación.`,
    });
  }

  const effort = trimmed(fields.effort);
  if (effort && !(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    issues.push({
      level: "warning",
      field: "effort",
      message: "Claude no reconoce ese valor; se guardará tal cual.",
    });
  }

  const turns = maxTurnsOf(fields.maxTurns);
  const validTurns =
    turns === undefined ||
    (typeof turns === "number"
      ? Number.isInteger(turns) && turns >= 1
      : /^\d+$/.test(turns) && Number(turns) > 0);
  if (!validTurns) {
    issues.push({
      level: "error",
      field: "maxTurns",
      message: "maxTurns debe ser un entero mayor o igual que 1.",
    });
  }

  const known = new Set<string>(CLAUDE_AGENT_TOOLS);
  for (const tool of splitList(fields.tools)) {
    if (!known.has(tool) && !tool.startsWith("mcp__") && !tool.includes("(")) {
      issues.push({
        level: "warning",
        field: "tools",
        message: `La herramienta "${tool}" no es del CLI ni un MCP: Claude la ignorará.`,
      });
    }
  }

  return issues;
}

/** Texto del fichero: claves no gestionadas del original + campos + prompt como cuerpo. */
export function claudeAgentText(
  name: string,
  original: AgentFrontmatter | undefined,
  fields: ClaudeAgentFields,
  prompt: string
): string {
  const fm: AgentFrontmatter = {};
  for (const [key, value] of Object.entries(original ?? {})) {
    if (!CLAUDE_MANAGED_KEYS.has(key)) {
      fm[key] = value;
    }
  }
  fm.name = name;
  fm.description = trimmed(fields.description);
  const tools = splitList(fields.tools);
  if (tools.length > 0) {
    fm.tools = tools.join(", ");
  }
  const model = trimmed(fields.model);
  if (model) {
    fm.model = model;
  }
  const color = trimmed(fields.color);
  if (color) {
    fm.color = color;
  }
  const mode = trimmed(fields.permissionMode);
  if (mode) {
    fm.permissionMode = mode;
  }
  const effort = trimmed(fields.effort);
  if (effort) {
    fm.effort = effort;
  }
  const turns = maxTurnsOf(fields.maxTurns);
  if (turns !== undefined) {
    fm.maxTurns = turns;
  }
  const skills = splitList(fields.skills);
  if (skills.length > 0) {
    fm.skills = skills;
  }
  const memory = trimmed(fields.memory);
  if (memory) {
    fm.memory = memory;
  }
  const isolation = trimmed(fields.isolation);
  if (isolation) {
    fm.isolation = isolation;
  }
  if (fields.omitClaudeMd === true) {
    fm.omitClaudeMd = true;
  }
  if (fields.background === true) {
    fm.background = true;
  }
  return serializeAgentFile(fm, prompt);
}

/** Guarda (crea, edita, renombra o mueve de scope); `createdDir` avisa si la carpeta nació aquí. */
export async function saveClaudeAgent(
  scope: ClaudeScope,
  name: string,
  fields: ClaudeAgentFields,
  prompt: string,
  projectRoot: string | undefined,
  currentFile?: string
): Promise<{ file: string; createdDir: boolean }> {
  const errors = validateClaudeAgent(name, fields, scope, projectRoot, currentFile).filter(
    (issue) => issue.level === "error"
  );
  if (errors.length > 0) {
    throw new Error(errors.map((issue) => issue.message).join(" "));
  }
  const target = claudeAgentFile(name.trim(), scope, projectRoot);
  if (!target) {
    throw new Error("Abre una carpeta de proyecto para guardar un agente de proyecto.");
  }
  if (existsSync(target) && (!currentFile || !isSamePath(target, currentFile))) {
    throw new Error(`Ya existe un agente "${name.trim()}" en ese scope.`);
  }
  // Las claves no gestionadas (hooks, mcpServers, disallowedTools…) viajan intactas.
  let original: AgentFrontmatter | undefined;
  if (currentFile && existsSync(currentFile)) {
    original = readClaudeAgent(currentFile).frontmatter;
  }
  const createdDir = !existsSync(path.dirname(target));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, claudeAgentText(name.trim(), original, fields, prompt));
  if (currentFile && !isSamePath(target, currentFile)) {
    await fs.rm(currentFile, { force: true });
  }
  return { file: target, createdDir };
}
