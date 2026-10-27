import * as fs from "fs/promises";
import { existsSync, type Dirent } from "fs";
import * as os from "os";
import * as path from "path";
import { applyEdits, FormattingOptions, modify, parse as parseJsonc, ParseError } from "jsonc-parser";
import { expandHome, globalOpencodeDir, projectRoot } from "./paths";
import { parseAgentFile } from "./parser";

export type ConfigScope = "global" | "project";

type JsonObject = Record<string, unknown>;

const FMT: FormattingOptions = { insertSpaces: true, tabSize: 2 };

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface RawConfig {
  path: string;
  scope: ConfigScope;
  text: string;
  obj?: JsonObject;
}

function globalConfigFiles(): string[] {
  const dir = globalOpencodeDir();
  return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
}

function projectConfigFiles(): string[] {
  const root = projectRoot();
  if (!root) {
    return [];
  }
  return [
    path.join(root, ".opencode", "opencode.json"),
    path.join(root, ".opencode", "opencode.jsonc"),
    path.join(root, "opencode.json"),
    path.join(root, "opencode.jsonc"),
  ];
}

/** Candidate config files in increasing precedence (project overrides global). */
function configSearchOrder(): Array<{ path: string; scope: ConfigScope }> {
  const out: Array<{ path: string; scope: ConfigScope }> = [];
  for (const p of globalConfigFiles()) {
    out.push({ path: p, scope: "global" });
  }
  for (const p of projectConfigFiles()) {
    out.push({ path: p, scope: "project" });
  }
  return out;
}

async function readConfig(file: string, scope: ConfigScope): Promise<RawConfig | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    return {
      path: file,
      scope,
      text,
      obj: errors.length === 0 ? asObject(parsed) : undefined,
    };
  } catch {
    return undefined;
  }
}

async function readAllConfigs(): Promise<RawConfig[]> {
  const out: RawConfig[] = [];
  for (const c of configSearchOrder()) {
    const rc = await readConfig(c.path, c.scope);
    if (rc) {
      out.push(rc);
    }
  }
  return out;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

async function modifyJson(
  file: string,
  keyPath: (string | number)[],
  value: unknown,
  fallback = "{}\n"
): Promise<void> {
  let text = fallback;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    /* create new */
  }
  const edits = modify(text, keyPath, value, { formattingOptions: FMT });
  await writeAtomic(file, applyEdits(text, edits));
}

/* ------------------------------ cli.json (TUI) ---------------------------- */

// cli.json es del cliente TUI, no del servidor: el ajuste no vive en opencode.json.
function cliConfigFile(): string {
  return path.join(globalOpencodeDir(), "cli.json");
}

/** `session.permissions` del TUI: "autoaccept" acepta sin preguntar. */
export async function loadAutoAccept(): Promise<boolean> {
  const config = await readConfig(cliConfigFile(), "global");
  return asObject(config?.obj?.session)?.permissions === "autoaccept";
}

export async function setAutoAccept(on: boolean): Promise<void> {
  await modifyJson(
    cliConfigFile(),
    ["session", "permissions"],
    on ? "autoaccept" : "prompt",
    `{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n`
  );
}

/* ------------------------------- MCP servers ------------------------------ */

export interface McpServer {
  name: string;
  scope: ConfigScope;
  type: string;
  target: string;
  enabled: boolean;
  filePath: string;
  /** Key path prefix in the config file (["mcp"] for v1, ["mcp","servers"] for v2). */
  keyPath: string[];
  /**
   * Which field opencode honors for this shape. opencode v2 (nested under `mcp.servers`)
   * only recognizes `disabled: true`; v1 (servers directly under `mcp`) uses `enabled`.
   */
  usesDisabledFlag: boolean;
}

/**
 * true when the server entry should be treated as disabled.
 * v2 nests servers under `mcp.servers` and only honors `disabled`; `enabled` is not a
 * recognized field there ("use disabled, not an enabled field"). v1 uses `enabled`.
 * We still read a stray `enabled` in v2 configs so old files keep rendering sensibly.
 */
function isDisabled(entry: JsonObject, v2: boolean): boolean {
  if (v2 && typeof entry.disabled === "boolean") {
    return entry.disabled;
  }
  if (typeof entry.enabled === "boolean") {
    return !entry.enabled;
  }
  return false;
}

export async function loadMcpServers(): Promise<McpServer[]> {
  const configs = await readAllConfigs();
  const map = new Map<string, McpServer>();
  for (const c of configs) {
    if (!c.obj) {
      continue;
    }
    const mcp = asObject(c.obj.mcp);
    if (!mcp) {
      continue;
    }
    // opencode v2 nests servers under `mcp.servers`; v1 lists them directly under `mcp`.
    const wrapped = asObject(mcp.servers);
    const v2 = wrapped !== undefined;
    const keyPath = v2 ? ["mcp", "servers"] : ["mcp"];
    const entries = wrapped
      ? Object.entries(wrapped)
      : Object.entries(mcp).filter(([key]) => key !== "servers" && key !== "timeout");
    for (const [name, raw] of entries) {
      const v = asObject(raw);
      if (!v) {
        continue;
      }
      const prev = map.get(name);
      const type = typeof v.type === "string" ? v.type : prev?.type ?? "";
      let target = prev?.target ?? "";
      if (Array.isArray(v.command)) {
        target = v.command.map(String).join(" ");
      } else if (typeof v.url === "string") {
        target = v.url;
      }
      map.set(name, {
        name,
        scope: c.scope,
        type,
        target,
        enabled: !isDisabled(v, v2),
        filePath: c.path,
        keyPath,
        usesDisabledFlag: v2,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name)
  );
}

export async function setMcpEnabled(server: McpServer, enabled: boolean): Promise<void> {
  if (server.usesDisabledFlag) {
    // opencode v2 ignores `enabled`; `disabled` is the authoritative flag. Drop the
    // stale `enabled` key so the file no longer contradicts the real state.
    await modifyJson(
      server.filePath,
      [...server.keyPath, server.name, "disabled"],
      enabled ? undefined : true
    );
    await modifyJson(server.filePath, [...server.keyPath, server.name, "enabled"], undefined);
    return;
  }
  await modifyJson(server.filePath, [...server.keyPath, server.name, "enabled"], enabled);
}

/* --------------------------------- Skills --------------------------------- */

export interface SkillInfo {
  name: string;
  description: string;
  scope: ConfigScope;
  dir: string;
  filePath: string;
  root: string;
  enabled: boolean;
}

interface SkillRule {
  pattern: string;
  action: string;
}

function collectSkillRules(configs: RawConfig[]): SkillRule[] {
  const rules: SkillRule[] = [];
  for (const c of configs) {
    if (!c.obj) {
      continue;
    }
    const skill = asObject(asObject(c.obj.permission)?.skill);
    if (!skill) {
      continue;
    }
    for (const [pattern, action] of Object.entries(skill)) {
      if (typeof action === "string") {
        rules.push({ pattern, action });
      }
    }
  }
  return rules;
}

function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(name);
  } catch {
    return pattern === name;
  }
}

function evaluateSkill(rules: SkillRule[], name: string): boolean {
  let action = "allow";
  for (const rule of rules) {
    if (globMatch(rule.pattern, name)) {
      action = rule.action;
    }
  }
  return action !== "deny";
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

async function readSkillDir(dir: string): Promise<Omit<SkillInfo, "scope" | "root" | "enabled"> | undefined> {
  const file = path.join(dir, "SKILL.md");
  try {
    const text = await fs.readFile(file, "utf8");
    const { frontmatter } = parseAgentFile(text);
    const rawName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description.replace(/\s+/g, " ").trim() : "";
    return {
      name: rawName || path.basename(dir),
      description,
      dir,
      filePath: file,
    };
  } catch {
    return undefined;
  }
}

function projectSkillRoots(): string[] {
  const root = projectRoot();
  if (!root) {
    return [];
  }
  const out: string[] = [];
  let dir = root;
  for (let i = 0; i < 10; i++) {
    out.push(path.join(dir, ".opencode", "skills"));
    out.push(path.join(dir, ".claude", "skills"));
    out.push(path.join(dir, ".agents", "skills"));
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    // stop when the current dir is the git worktree root
    if (existsSync(path.join(dir, ".git"))) {
      break;
    }
    dir = parent;
  }
  return out;
}

export async function loadSkills(): Promise<SkillInfo[]> {
  const configs = await readAllConfigs();
  const rules = collectSkillRules(configs);
  const byName = new Map<string, SkillInfo>();

  const addRoot = async (root: string, scope: ConfigScope): Promise<void> => {
    for (const dir of await listSkillDirs(root)) {
      const info = await readSkillDir(dir);
      if (!info) {
        continue;
      }
      byName.set(info.name, {
        ...info,
        scope,
        root,
        enabled: evaluateSkill(rules, info.name),
      });
    }
  };

  const globalRoots = [
    path.join(globalOpencodeDir(), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  for (const root of globalRoots) {
    await addRoot(root, "global");
  }
  for (const c of configs) {
    if (c.scope !== "global") {
      continue;
    }
    for (const p of configSkillPaths(c)) {
      await addRoot(p, "global");
    }
  }
  for (const root of await pluginSkillRoots()) {
    await addRoot(root, "global");
  }

  for (const root of projectSkillRoots()) {
    await addRoot(root, "project");
  }
  for (const c of configs) {
    if (c.scope !== "project") {
      continue;
    }
    for (const p of configSkillPaths(c)) {
      await addRoot(p, "project");
    }
  }

  return [...byName.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name)
  );
}

function configSkillPaths(config: RawConfig): string[] {
  if (!config.obj) {
    return [];
  }
  const skills = asObject(config.obj.skills);
  const paths = skills?.paths;
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => path.normalize(expandHome(p.trim())));
}

/** Find directories named "skills" under opencode's plugin cache (bounded BFS). */
async function findNamedDirs(root: string, name: string, maxDepth: number, cap: number): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < cap) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    visited += 1;
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(current.dir, entry.name);
      if (entry.name === name) {
        out.push(full);
      } else if (current.depth < maxDepth) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return out;
}

/** Skill folders shipped inside opencode plugin packages (~/.cache/opencode/packages). */
async function pluginSkillRoots(): Promise<string[]> {
  const base = path.join(os.homedir(), ".cache", "opencode", "packages");
  if (!(await pathExists(base))) {
    return [];
  }
  return findNamedDirs(base, "skills", 8, 5000);
}

async function ensureScopeConfig(scope: ConfigScope): Promise<string> {
  const candidates = scope === "global" ? globalConfigFiles().reverse() : projectConfigFiles();
  for (const file of candidates) {
    if (await pathExists(file)) {
      return file;
    }
  }
  const root = scope === "global" ? globalOpencodeDir() : projectRoot();
  if (!root) {
    throw new Error("No hay carpeta de proyecto abierta.");
  }
  const target =
    scope === "global"
      ? path.join(root, "opencode.jsonc")
      : path.join(root, ".opencode", "opencode.json");
  if (!(await pathExists(target))) {
    await writeAtomic(target, `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`);
  }
  return target;
}

export async function setSkillEnabled(skill: SkillInfo, enabled: boolean): Promise<void> {
  const file = await ensureScopeConfig(skill.scope);
  await modifyJson(file, ["permission", "skill", skill.name], enabled ? "allow" : "deny");
}

/* --------------------------------- Plugins -------------------------------- */

export interface PluginInfo {
  name: string;
  /** Package spec or directory path exactly as written in the config. */
  spec: string;
  scope: ConfigScope;
  filePath: string;
  enabled: boolean;
  /** Cargado por opencode solo por estar en el directorio plugins/, sin aparecer en la config. */
  discovered: boolean;
}

/** A plugin removed from the config but remembered so it can be re-enabled. */
export interface DisabledPlugin {
  spec: string;
  scope: ConfigScope;
  filePath: string;
}

/** opencode v2 lists plugins under `plugins`; v1 under `plugin`. */
function pluginArrayKey(obj: JsonObject | undefined): "plugins" | "plugin" | undefined {
  if (Array.isArray(obj?.plugins)) {
    return "plugins";
  }
  if (Array.isArray(obj?.plugin)) {
    return "plugin";
  }
  return undefined;
}

/** Una entrada es una spec, una tupla `[spec, options]` o un objeto `{ package, options }`. */
function pluginSpec(entry: unknown): string | undefined {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  if (typeof spec === "string") {
    return spec.trim() ? spec : undefined;
  }
  const pkg = asObject(spec)?.package;
  return typeof pkg === "string" && pkg.trim() ? pkg : undefined;
}

/** Ficheros que hacen que una carpeta dentro de plugins/ sea un paquete de plugin. */
const PLUGIN_MARKERS = ["package.json", "index.js", "index.ts", "server.js", "server.ts"];

/** Directorios de descubrimiento automático de plugins: el global y, si hay, el del proyecto. */
function pluginSearchDirs(): Array<{ dir: string; scope: ConfigScope }> {
  const out: Array<{ dir: string; scope: ConfigScope }> = [
    { dir: path.join(globalOpencodeDir(), "plugins"), scope: "global" },
  ];
  const root = projectRoot();
  if (root) {
    out.push({ dir: path.join(root, ".opencode", "plugins"), scope: "project" });
  }
  return out;
}

export async function loadPlugins(disabled: DisabledPlugin[]): Promise<PluginInfo[]> {
  const configs = await readAllConfigs();
  const map = new Map<string, PluginInfo>();
  // Nombres desactivados por la config con el prefijo "-".
  const denied = new Set<string>();
  // Specs de ruta ("./plugins/x") ya listadas, por ámbito: apuntan a la carpeta de abajo.
  const listedPaths = new Set<string>();
  for (const c of configs) {
    const key = pluginArrayKey(c.obj);
    if (!key || !c.obj) {
      continue;
    }
    for (const entry of c.obj[key] as unknown[]) {
      const spec = pluginSpec(entry);
      if (!spec) {
        continue;
      }
      if (spec.startsWith("-")) {
        // shortcut: "-<nombre>" es coincidencia exacta; "*" y ".*" de opencode no se evalúan.
        denied.add(spec.slice(1));
        continue;
      }
      if (spec.startsWith(".")) {
        listedPaths.add(`${c.scope}|${path.basename(spec.replace(/[\\/]+$/, ""))}`);
      }
      map.set(`${c.scope}|${spec}`, {
        name: spec,
        spec,
        scope: c.scope,
        filePath: c.path,
        enabled: true,
        discovered: false,
      });
    }
  }
  // opencode carga también lo inmediato de <config>/plugins/: ficheros .js/.ts y carpetas de paquete.
  for (const dir of pluginSearchDirs()) {
    let items: Dirent[];
    try {
      items = await fs.readdir(dir.dir, { withFileTypes: true });
    } catch {
      continue; // sin carpeta plugins/ en este ámbito
    }
    for (const item of items) {
      if (!item.name || item.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir.dir, item.name);
      let name: string | undefined;
      if (item.isFile()) {
        const ext = path.extname(item.name);
        if (ext === ".js" || ext === ".ts") {
          name = path.basename(item.name, ext);
        }
      } else if (item.isDirectory()) {
        for (const marker of PLUGIN_MARKERS) {
          if (await pathExists(path.join(full, marker))) {
            name = item.name;
            break;
          }
        }
      }
      // La config manda: ni lo ya listado por spec se pisa, ni lo listado por ruta se repite.
      if (name && !map.has(`${dir.scope}|${name}`) && !listedPaths.has(`${dir.scope}|${name}`)) {
        map.set(`${dir.scope}|${name}`, {
          name,
          spec: name,
          scope: dir.scope,
          filePath: full,
          enabled: !denied.has(name),
          discovered: true,
        });
      }
    }
  }
  for (const d of disabled) {
    const key = `${d.scope}|${d.spec}`;
    if (!map.has(key)) {
      map.set(key, {
        name: d.spec,
        spec: d.spec,
        scope: d.scope,
        filePath: d.filePath,
        enabled: false,
        discovered: false,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.spec.localeCompare(b.spec)
  );
}

/** Add or remove a plugin spec in the config of the given scope. Returns the file written. */
export async function setPluginEnabled(
  spec: string,
  scope: ConfigScope,
  enabled: boolean,
  filePath?: string
): Promise<string> {
  const file = filePath && (await pathExists(filePath)) ? filePath : await ensureScopeConfig(scope);
  let key: "plugins" | "plugin" = "plugins";
  let entries: unknown[] = [];
  try {
    const obj = asObject(
      parseJsonc(await fs.readFile(file, "utf8"), [], {
        allowTrailingComma: true,
        disallowComments: false,
      })
    );
    key = pluginArrayKey(obj) ?? "plugins";
    const current = obj?.[key];
    if (Array.isArray(current)) {
      entries = current;
    }
  } catch {
    /* file does not exist yet: start from an empty list */
  }
  const next = entries.filter((entry) => pluginSpec(entry) !== spec);
  if (enabled) {
    next.push(spec);
  }
  await modifyJson(file, [key], next);
  return file;
}

/**
 * opencode carga lo que hay en plugins/ sin estar listado: para apagar un plugin descubierto se
 * añade "-<nombre>" al array de la config, y al encenderlo se quita esa entrada.
 */
export async function setDiscoveredPluginEnabled(
  name: string,
  scope: ConfigScope,
  enabled: boolean
): Promise<string> {
  const file = await ensureScopeConfig(scope);
  let key: "plugins" | "plugin" = "plugins";
  let entries: unknown[] = [];
  try {
    const obj = asObject(
      parseJsonc(await fs.readFile(file, "utf8"), [], {
        allowTrailingComma: true,
        disallowComments: false,
      })
    );
    key = pluginArrayKey(obj) ?? "plugins";
    const current = obj?.[key];
    if (Array.isArray(current)) {
      entries = current;
    }
  } catch {
    /* fichero sin crear o ilegible: se parte de una lista vacía */
  }
  const deny = `-${name}`;
  const next = entries.filter((entry) => pluginSpec(entry) !== deny);
  if (!enabled) {
    next.push(deny);
  }
  await modifyJson(file, [key], next);
  return file;
}
