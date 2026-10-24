import { existsSync, readdirSync, readFileSync, type Dirent } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { applyEdits, FormattingOptions, modify, parse as parseJsonc, ParseError } from "jsonc-parser";
import { parseAgentFile } from "../agents/parser";
import { writeAtomic } from "../agents/store";
import type { ExplorerAgent, ExplorerCatalogItem } from "../panels/explorerPanel";

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
