import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import {
  Agent,
  AgentFrontmatter,
  BUILTIN_AGENTS,
  Scope,
} from "./types";
import {
  configFileCandidates,
  globalAgentDirs,
  globalAgentsMdPath,
  opencodeAuthPath,
  opencodeDataDir,
  opencodeModelsCachePath,
  projectAgentDirs,
  projectAgentsMdPath,
  projectRoot,
} from "./paths";
import { parseAgentFile, serializeAgentFile } from "./parser";
import { buildConfigInfo, OpencodeConfigInfo, Registry } from "./config";
import { listDbFiles, openSqlite } from "../stats/opencodeStats";

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readDirMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(md|markdown)$/i.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function agentNameFromFile(file: string): string {
  return path.basename(file).replace(/\.(md|markdown)$/i, "");
}

/** First existing directory of the pair (agent / agents), or the first candidate. */
export async function preferredAgentDir(dirs: string[]): Promise<string> {
  for (const d of dirs) {
    if (await pathExists(d)) {
      return d;
    }
  }
  return dirs[0];
}

export async function loadScopeAgents(scope: Scope): Promise<Agent[]> {
  const dirs = scope === "global" ? globalAgentDirs() : projectAgentDirs();
  const dir = await preferredAgentDir(dirs);
  const files = await readDirMarkdown(dir);
  const agents: Agent[] = [];
  for (const file of files) {
    try {
      const text = await fs.readFile(file, "utf8");
      const { frontmatter, prompt } = parseAgentFile(text);
      agents.push({
        name: agentNameFromFile(file),
        scope,
        source: "file",
        filePath: file,
        dir,
        frontmatter,
        prompt,
        builtin: (BUILTIN_AGENTS as readonly string[]).includes(agentNameFromFile(file)),
      });
    } catch (err) {
      agents.push({
        name: agentNameFromFile(file),
        scope,
        source: "file",
        filePath: file,
        dir,
        frontmatter: {},
        prompt: "",
        builtin: false,
      });
      console.error(`[opencode-agents] no se pudo leer ${file}:`, err);
    }
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentList {
  global: Agent[];
  project: Agent[];
  builtins: Agent[];
}

export async function listAgents(includeBuiltins = true): Promise<AgentList> {
  const [global, project] = await Promise.all([
    loadScopeAgents("global"),
    loadScopeAgents("project"),
  ]);

  const projectNames = new Set(project.map((a) => a.name));
  for (const g of global) {
    g.shadowed = projectNames.has(g.name);
  }

  const builtins: Agent[] = [];
  if (includeBuiltins) {
    const definedNames = new Set([...global, ...project].map((a) => a.name));
    for (const name of BUILTIN_AGENTS) {
      const overriddenBy: Scope[] = [];
      if (global.some((a) => a.name === name)) {
        overriddenBy.push("global");
      }
      if (project.some((a) => a.name === name)) {
        overriddenBy.push("project");
      }
      builtins.push({
        name,
        scope: "global",
        source: "builtin",
        frontmatter: {},
        prompt: "",
        builtin: true,
        overriddenBy,
        shadowed: definedNames.has(name),
      });
    }
  }

  return { global, project, builtins };
}

export async function findAgent(name: string, scope: Scope): Promise<Agent | undefined> {
  const agents = await loadScopeAgents(scope);
  return agents.find((a) => a.name === name);
}

export async function writeAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

export async function saveAgent(
  scope: Scope,
  name: string,
  frontmatter: AgentFrontmatter,
  prompt: string,
  currentFilePath?: string
): Promise<string> {
  const dirs = scope === "global" ? globalAgentDirs() : projectAgentDirs();
  const dir = await preferredAgentDir(dirs);
  const file = path.join(dir, `${name}.md`);

  if (currentFilePath && path.basename(currentFilePath) !== `${name}.md`) {
    const newFile = path.join(path.dirname(currentFilePath), `${name}.md`);
    await writeAtomic(newFile, serializeAgentFile(frontmatter, prompt));
    if (path.normalize(newFile) !== path.normalize(currentFilePath)) {
      await fs.rm(currentFilePath, { force: true });
    }
    return newFile;
  }

  await writeAtomic(file, serializeAgentFile(frontmatter, prompt));
  return file;
}

export async function deleteAgent(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}

export async function renameAgentFile(filePath: string, newName: string): Promise<string> {
  const dir = path.dirname(filePath);
  const target = path.join(dir, `${newName}.md`);
  await fs.rename(filePath, target);
  return target;
}

export async function duplicateAgent(agent: Agent, targetScope: Scope): Promise<string> {
  const base = `${agent.name}-copy`;
  const dirs = targetScope === "global" ? globalAgentDirs() : projectAgentDirs();
  const dir = await preferredAgentDir(dirs);
  await ensureDir(dir);
  let name = base;
  let i = 2;
  while (await pathExists(path.join(dir, `${name}.md`))) {
    name = `${base}-${i++}`;
  }
  const file = path.join(dir, `${name}.md`);
  await writeAtomic(file, serializeAgentFile(agent.frontmatter, agent.prompt));
  return file;
}

export interface AgentsMdFile {
  file: string;
  exists: boolean;
  text: string;
  eol: "\r\n" | "\n";
}

/** Lee el AGENTS.md del scope. Si no existe devuelve texto vacío para poder crearlo. */
export async function readAgentsMd(scope: Scope): Promise<AgentsMdFile> {
  const file = scope === "project" ? projectAgentsMdPath() : globalAgentsMdPath();
  if (!file) {
    throw new Error("No hay carpeta de proyecto abierta.");
  }
  if (!(await pathExists(file))) {
    return { file, exists: false, text: "", eol: "\n" };
  }
  const text = await fs.readFile(file, "utf8");
  return { file, exists: true, text, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

/** Guarda el AGENTS.md del scope conservando los finales de línea que ya usaba el fichero. */
export async function saveAgentsMd(scope: Scope, text: string, eol: "\r\n" | "\n"): Promise<string> {
  const file = scope === "project" ? projectAgentsMdPath() : globalAgentsMdPath();
  if (!file) {
    throw new Error("No hay carpeta de proyecto abierta.");
  }
  const lf = text.replace(/\r\n?/g, "\n");
  await writeAtomic(file, eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf);
  return file;
}

export async function readConfigInfo(): Promise<OpencodeConfigInfo> {
  const candidates = configFileCandidates();
  const globalDir = globalAgentDirs()[0];
  const globalRoot = path.dirname(globalDir);
  const proj = projectRoot();

  const files: Array<{ path: string; scope: "global" | "project"; text?: string; error?: string }> = [];
  for (const file of candidates) {
    if (!(await pathExists(file))) {
      continue;
    }
    const scope: "global" | "project" =
      proj && file.toLowerCase().startsWith(proj.toLowerCase()) ? "project" : "global";
    try {
      const text = await fs.readFile(file, "utf8");
      files.push({ path: file, scope, text });
    } catch (err) {
      files.push({ path: file, scope, error: String(err) });
    }
  }
  void globalRoot;

  const [authProviders, registry] = await Promise.all([loadAuthProviders(), loadRegistry()]);
  const includeAllProviders = vscode.workspace
    .getConfiguration("opencodeAgents")
    .get<boolean>("showAllProviders", false);

  return buildConfigInfo(files, { authProviders, registry, includeAllProviders });
}

/**
 * Proveedores autenticados. opencode v1 los apunta en auth.json y v2 en la tabla `credential`
 * de su BD (p. ej. OpenCode Console, que en auth.json no aparece), así que se miran los dos.
 */
async function loadAuthProviders(): Promise<string[]> {
  const providers = new Set<string>();
  try {
    const text = await fs.readFile(opencodeAuthPath(), "utf8");
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const id of Object.keys(obj)) {
        providers.add(id);
      }
    }
  } catch {
    // sin auth.json: los proveedores salen de la BD
  }
  for (const file of listDbFiles(opencodeDataDir())) {
    const db = openSqlite(file);
    if (!db) {
      continue;
    }
    try {
      const rows = db.prepare("SELECT integration_id FROM credential").all() as Array<{
        integration_id: unknown;
      }>;
      for (const row of rows) {
        if (row.integration_id) {
          providers.add(String(row.integration_id));
        }
      }
    } catch {
      // BD sin tabla credential (esquema v1)
    } finally {
      db.close();
    }
  }
  return [...providers];
}

/** Catálogo models.dev tal cual lo cachea opencode v2 en `kv`, más fresco que el fichero. */
function readDbCatalog(dataDir: string): Registry | undefined {
  for (const file of listDbFiles(dataDir)) {
    const db = openSqlite(file);
    if (!db) {
      continue;
    }
    try {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get("models-dev:catalog") as
        | { value: unknown }
        | undefined;
      const wrapper = row?.value ? JSON.parse(String(row.value)) : undefined;
      const body = (wrapper as { body?: unknown } | undefined)?.body;
      if (typeof body === "string") {
        return JSON.parse(body) as Registry;
      }
    } catch {
      // sin tabla kv (esquema v1) o valor ilegible: se prueba con la siguiente BD
    } finally {
      db.close();
    }
  }
  return undefined;
}

let registryCache: { path: string; mtimeMs: number; data: Registry } | undefined;

/** models.dev: primero la BD (v2), después la caché en fichero (~/.cache/opencode/models.json). */
export async function loadRegistry(): Promise<Registry | undefined> {
  const fromDb = readDbCatalog(opencodeDataDir());
  if (fromDb) {
    return fromDb;
  }
  const file = opencodeModelsCachePath();
  try {
    const st = await fs.stat(file);
    if (registryCache && registryCache.path === file && registryCache.mtimeMs === st.mtimeMs) {
      return registryCache.data;
    }
    const text = await fs.readFile(file, "utf8");
    const data = JSON.parse(text) as Registry;
    registryCache = { path: file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return registryCache?.data;
  }
}

export { pathExists, ensureDir };
