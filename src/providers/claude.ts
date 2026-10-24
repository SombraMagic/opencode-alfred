import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { applyEdits, FormattingOptions, modify, parse as parseJsonc, ParseError } from "jsonc-parser";
import { parseAgentFile } from "../agents/parser";
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

function readMcpFile(file: string): Array<{ name: string; entry: JsonObject }> {
  const servers = asObject(readJson(file)?.mcpServers);
  if (!servers) {
    return [];
  }
  return Object.entries(servers)
    .map(([name, entry]) => ({ name, entry: asObject(entry) }))
    .filter((item): item is { name: string; entry: JsonObject } => item.entry !== undefined);
}

function readMcp(projectRoot: string | undefined): ExplorerCatalogItem[] {
  const out: ExplorerCatalogItem[] = [];
  const globalFile = globalStateFile();
  for (const { name, entry } of readMcpFile(globalFile)) {
    out.push({
      name,
      scope: "global",
      enabled: true,
      detail: mcpDetail(entry),
      filePath: globalFile,
      // Los MCP globales viven en ~/.claude.json, que también guarda credenciales: solo se leen.
      toggleable: false,
    });
  }
  if (!projectRoot) {
    return out;
  }
  const file = projectMcpFile(projectRoot);
  const disabled = readJson(projectLocalSettingsFile(projectRoot))?.disabledMcpjsonServers;
  const disabledNames = Array.isArray(disabled) ? disabled.filter((n) => typeof n === "string") : [];
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

export function claudeExplorer(projectRoot: string | undefined): ClaudeExplorer {
  const settings = readJson(settingsFile());
  const defaultMode = asObject(settings?.permissions)?.defaultMode;
  return {
    agents: {
      project: projectRoot ? readAgents(projectAgentsDir(projectRoot), "project") : [],
      global: readAgents(path.join(claudeHome(), "agents"), "global"),
      builtin: [],
    },
    mcp: readMcp(projectRoot),
    skills: [
      ...readSkills(path.join(claudeHome(), "skills"), "global"),
      ...(projectRoot ? readSkills(projectSkillsDir(projectRoot), "project") : []),
    ],
    plugins: readPlugins(settings),
    autoAccept: defaultMode === "acceptEdits" || defaultMode === "bypassPermissions",
  };
}

/* --------------------------------- modelos -------------------------------- */

export interface ClaudeModels {
  models: ModelEntry[];
  /** `settings.model` como `claude/<modelo>`; vacío si no hay ninguno configurado. */
  currentModel: string;
}

/** `deepseek-flash[1m]` y `deepseek-flash` son el mismo modelo: el sufijo no cuenta. */
const MODEL_SUFFIX = /\[[^\]]*\]$/;

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
 * Claude no publica catálogo local: los modelos salen de los que ya usaron las
 * sesiones de este proyecto. Sin carpeta ni sesiones queda solo el configurado.
 */
export function claudeModels(projectRoot: string | undefined): ClaudeModels {
  const configured = readJson(settingsFile())?.model;
  const current = typeof configured === "string" ? configured.trim() : "";
  const seen = new Set<string>();
  const models: ModelEntry[] = [];
  const add = (name: string): void => {
    const key = name.replace(MODEL_SUFFIX, "");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    models.push({ id: `claude/${name}`, provider: "claude", model: name, name, free: false });
  };
  // El configurado va primero: al deduplicar se queda con su forma exacta.
  if (current) {
    add(current);
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
      if (typeof model !== "string") {
        continue;
      }
      const name = model.trim();
      if (!name || name === "<synthetic>") {
        continue;
      }
      add(name);
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
  const configured = readJson(settingsFile())?.model;
  const name =
    typeof configured === "string" && configured.trim().replace(MODEL_SUFFIX, "") === model
      ? configured.trim()
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
  // Al desactivar se borra la clave: el CLI vuelve a su modo por defecto, no a "default".
  await modifyJsonFile(settingsFile(), ["permissions", "defaultMode"], on ? "acceptEdits" : undefined);
}

/** Escribe `model` en settings.json: Claude lo lee al arrancar cada sesión. */
export async function setClaudeModel(id: string): Promise<void> {
  const prefix = "claude/";
  if (!id.startsWith(prefix)) {
    throw new Error("Ese modelo no es de Claude.");
  }
  const model = id.slice(prefix.length);
  if (!model.trim()) {
    throw new Error("Falta el nombre del modelo.");
  }
  await modifyJsonFile(settingsFile(), ["model"], model);
}
