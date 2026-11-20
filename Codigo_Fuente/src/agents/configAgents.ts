import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { applyEdits, FormattingOptions, modify, parse as parseJsonc, ParseError } from "jsonc-parser";
import { Agent, AgentFrontmatter, Permission, PermissionAction, Scope } from "./types";

/**
 * Agentes declarados dentro de `opencode.json(c)` en vez de en un `.md`. Vive sin `vscode`
 * (lo usa el editor y el tablero de asignación), así que las rutas entran por `ConfigRoots`.
 */

/** Clave del config: `agent` en opencode v1, `agents` en v2. */
export type ConfigAgentKey = "agent" | "agents";

export interface ConfigAgentEntry {
  name: string;
  scope: Scope;
  /** Ruta del `opencode.json(c)` que declara la entrada. */
  filePath: string;
  key: ConfigAgentKey;
  /** Fichero del prompt cuando la entrada usa `{file:ruta}`. */
  promptFile?: string;
  promptText: string;
  frontmatter: AgentFrontmatter;
}

/** Raíces donde buscar la config. Sin `projectRoot` solo se lee la global. */
export interface ConfigRoots {
  globalDir?: string;
  projectRoot?: string;
  /** Lee solo ese ámbito; sin él se devuelven los dos. */
  scope?: Scope;
}

type JsonObject = Record<string, unknown>;

const FMT: FormattingOptions = { insertSpaces: true, tabSize: 2 };

const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"];

/**
 * Claves que ya tienen campo propio en `AgentFrontmatter` (o que se leen aparte): el resto
 * de claves del JSON se conservan como opciones del proveedor y se reescriben tal cual.
 */
const HANDLED = new Set([
  "name",
  "model",
  "variant",
  "temperature",
  "top_p",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "options",
  "permission",
  "disable",
  "prompt",
  "system",
  "permissions",
  "request",
  "disabled",
  "tools",
  "maxSteps",
]);

/** Claves v2 propias: no se vuelcan como opciones del proveedor. */
const V2_KEYS = new Set([
  "name",
  "model",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
]);

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Ficheros de config en orden creciente de precedencia (el último gana). */
function configFileOrder(roots: ConfigRoots): Array<{ path: string; scope: Scope }> {
  const out: Array<{ path: string; scope: Scope }> = [];
  const globalDir = roots.globalDir ?? path.join(os.homedir(), ".config", "opencode");
  for (const name of CONFIG_NAMES) {
    out.push({ path: path.join(globalDir, name), scope: "global" });
  }
  if (roots.projectRoot) {
    for (const base of [path.join(roots.projectRoot, ".opencode"), roots.projectRoot]) {
      for (const name of CONFIG_NAMES) {
        out.push({ path: path.join(base, name), scope: "project" });
      }
    }
  }
  return out;
}

interface RawConfig {
  path: string;
  scope: Scope;
  obj?: JsonObject;
}

async function readConfig(file: string, scope: Scope): Promise<RawConfig | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    return {
      path: file,
      scope,
      obj: errors.length === 0 ? asObject(parsed) : undefined,
    };
  } catch {
    return undefined;
  }
}

/* ---------------------------- lectura: JSON -> modelo ---------------------------- */

const FILE_REF = /^\s*\{file:([^}]+)\}\s*$/;

/** Texto del prompt y, si es `{file:ruta}`, el fichero al que apunta (resuelto). */
async function resolvePrompt(
  raw: string | undefined,
  configDir: string
): Promise<{ text: string; file?: string }> {
  if (raw === undefined) {
    return { text: "" };
  }
  const match = FILE_REF.exec(raw);
  if (!match) {
    return { text: raw };
  }
  const ref = expandHome(match[1].trim());
  const file = path.isAbsolute(ref) ? path.normalize(ref) : path.resolve(configDir, ref);
  try {
    return { text: await fs.readFile(file, "utf8"), file };
  } catch {
    // Como opencode: un fichero que falta sustituye a cadena vacía.
    return { text: "", file };
  }
}

/** v1: el JSON es casi el frontmatter; `prompt` es el cuerpo y `name` es la clave. */
function v1Frontmatter(raw: JsonObject): AgentFrontmatter {
  const fm: AgentFrontmatter = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "prompt" || k === "name" || v === undefined || v === null) {
      continue;
    }
    fm[k] = v;
  }
  return fm;
}

/** Reglas v2 (`[{action, resource, effect}]`) al mapa de permisos v1. */
function permissionFromRules(rules: unknown): Permission | undefined {
  if (!Array.isArray(rules)) {
    return undefined;
  }
  const byAction = new Map<string, Array<{ resource: string; effect: string }>>();
  for (const item of rules) {
    const rule = asObject(item);
    if (!rule) {
      continue;
    }
    const action = typeof rule.action === "string" ? rule.action : "";
    const resource = typeof rule.resource === "string" ? rule.resource : "*";
    const effect = typeof rule.effect === "string" ? rule.effect : "";
    if (!action || !effect) {
      continue;
    }
    const list = byAction.get(action) ?? [];
    list.push({ resource, effect });
    byAction.set(action, list);
  }
  if (byAction.size === 0) {
    return undefined;
  }
  const permission: Permission = {};
  for (const [action, list] of byAction) {
    if (list.length === 1 && list[0].resource === "*") {
      permission[action] = list[0].effect as PermissionAction;
      continue;
    }
    const map: Record<string, PermissionAction> = {};
    for (const rule of list) {
      map[rule.resource] = rule.effect as PermissionAction;
    }
    permission[action] = map;
  }
  return permission;
}

/** v2: se invierte la migración (request.body, permissions, disabled, system). */
function v2Frontmatter(raw: JsonObject): AgentFrontmatter {
  const fm: AgentFrontmatter = {};
  const model = raw.model;
  if (typeof model === "string") {
    const hash = model.indexOf("#");
    if (hash === -1) {
      fm.model = model;
    } else {
      fm.model = model.slice(0, hash);
      const variant = model.slice(hash + 1);
      if (variant) {
        fm.variant = variant;
      }
    }
  } else {
    const obj = asObject(model);
    const provider = obj && typeof obj.providerID === "string" ? obj.providerID : "";
    const id = obj && typeof obj.model === "string" ? obj.model : "";
    if (provider && id) {
      fm.model = `${provider}/${id}`;
    }
    if (obj && typeof obj.variant === "string" && obj.variant) {
      fm.variant = obj.variant;
    }
  }
  const body = asObject(asObject(raw.request)?.body);
  if (body) {
    if (typeof body.temperature === "number") {
      fm.temperature = body.temperature;
    }
    if (typeof body.top_p === "number") {
      fm.top_p = body.top_p;
    }
    const rest: JsonObject = { ...body };
    delete rest.temperature;
    delete rest.top_p;
    if (Object.keys(rest).length > 0) {
      fm.options = rest;
    }
  }
  if (typeof raw.description === "string") {
    fm.description = raw.description;
  }
  if (raw.mode === "primary" || raw.mode === "subagent" || raw.mode === "all") {
    fm.mode = raw.mode;
  }
  if (typeof raw.hidden === "boolean") {
    fm.hidden = raw.hidden;
  }
  if (typeof raw.color === "string") {
    fm.color = raw.color;
  }
  if (typeof raw.steps === "number") {
    fm.steps = raw.steps;
  }
  if (raw.disabled === true) {
    fm.disable = true;
  }
  const permission = permissionFromRules(raw.permissions);
  if (permission) {
    fm.permission = permission;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (V2_KEYS.has(k) || v === undefined || v === null) {
      continue;
    }
    fm[k] = v;
  }
  return fm;
}

/**
 * Agentes inline de los ficheros de config, en orden creciente de precedencia: un nombre
 * repetido se queda con el del fichero que manda. `scope` filtra por ámbito (cada llamada de
 * `loadScopeAgents` pide el suyo); sin él se devuelven los dos juntos.
 */
export async function loadConfigAgents(roots: ConfigRoots = {}): Promise<ConfigAgentEntry[]> {
  const byName = new Map<string, ConfigAgentEntry>();
  for (const candidate of configFileOrder(roots)) {
    if (roots.scope && candidate.scope !== roots.scope) {
      continue;
    }
    const config = await readConfig(candidate.path, candidate.scope);
    if (!config?.obj) {
      continue;
    }
    // v2 manda si el fichero declara `agents`; si no, v1 (`agent`).
    const v2 = asObject(config.obj.agents);
    const key: ConfigAgentKey = v2 ? "agents" : "agent";
    const entries = v2 ?? asObject(config.obj.agent);
    if (!entries) {
      continue;
    }
    const configDir = path.dirname(config.path);
    for (const [name, value] of Object.entries(entries)) {
      const raw = asObject(value);
      if (!raw) {
        continue;
      }
      const promptRaw =
        typeof raw.prompt === "string"
          ? raw.prompt
          : typeof raw.system === "string"
            ? raw.system
            : undefined;
      const prompt = await resolvePrompt(promptRaw, configDir);
      byName.set(name, {
        name,
        scope: config.scope,
        filePath: config.path,
        key,
        ...(prompt.file ? { promptFile: prompt.file } : {}),
        promptText: prompt.text,
        frontmatter: key === "agents" ? v2Frontmatter(raw) : v1Frontmatter(raw),
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Entrada de config de un agente inline ya cargado por el store. */
export function configEntryOf(agent: Agent): ConfigAgentEntry {
  return {
    name: agent.name,
    scope: agent.scope,
    filePath: agent.filePath ?? "",
    key: agent.configKey ?? "agent",
    ...(agent.promptFile ? { promptFile: agent.promptFile } : {}),
    promptText: agent.prompt,
    frontmatter: agent.frontmatter,
  };
}

/* ---------------------------- escritura: modelo -> JSON ---------------------------- */

/** Modelo v2 en la forma que ya usaba el fichero (cadena o `{providerID, model, variant}`). */
function v2ModelValue(model: string, variant: string | undefined, rawModel: unknown): unknown {
  const hash = model.indexOf("#");
  const base = hash === -1 ? model : model.slice(0, hash);
  let selected = hash === -1 ? variant : model.slice(hash + 1);
  const raw = asObject(rawModel);
  if (raw) {
    const slash = base.indexOf("/");
    if (slash > 0) {
      const providerID = base.slice(0, slash);
      const id = base.slice(slash + 1);
      if (
        !selected &&
        providerID === raw.providerID &&
        id === raw.model &&
        typeof raw.variant === "string"
      ) {
        selected = raw.variant;
      }
      const out: JsonObject = { providerID, model: id };
      if (selected) {
        out.variant = selected;
      }
      return out;
    }
  }
  return selected ? `${base}#${selected}` : base;
}

/** Mapa de permisos v1 a las reglas v2 (la acción se usa tal cual). */
function permissionRules(permission: unknown): JsonObject[] {
  const map = asObject(permission);
  if (!map) {
    return [];
  }
  const out: JsonObject[] = [];
  for (const [action, value] of Object.entries(map)) {
    if (typeof value === "string") {
      out.push({ action, resource: "*", effect: value });
      continue;
    }
    const patterns = asObject(value);
    if (!patterns) {
      continue;
    }
    for (const [resource, effect] of Object.entries(patterns)) {
      if (typeof effect === "string") {
        out.push({ action, resource, effect });
      }
    }
  }
  return out;
}

/**
 * Campos del JSON que produce un frontmatter: es el inverso exacto de la lectura, así que
 * comparar los campos del frontmatter viejo con los del nuevo deja intactas las claves
 * que esta extensión no conoce.
 */
function entryFields(
  key: ConfigAgentKey,
  frontmatter: AgentFrontmatter,
  prompt: string,
  promptRef: string | undefined,
  raw: JsonObject
): JsonObject {
  const out: JsonObject = {};
  const take = (name: string): void => {
    const value = frontmatter[name];
    if (value !== undefined && value !== null) {
      out[name] = value;
    }
  };
  const promptValue = promptRef ?? (prompt !== "" ? prompt : undefined);

  if (key === "agent") {
    for (const name of [
      "model",
      "variant",
      "temperature",
      "top_p",
      "description",
      "mode",
      "hidden",
      "color",
      "steps",
      "options",
      "permission",
      "disable",
      "tools",
      "maxSteps",
    ]) {
      take(name);
    }
    if (promptValue !== undefined) {
      out.prompt = promptValue;
    }
  } else {
    for (const name of ["description", "mode", "hidden", "color", "steps"]) {
      take(name);
    }
    if (typeof frontmatter.model === "string" && frontmatter.model !== "") {
      out.model = v2ModelValue(
        frontmatter.model,
        typeof frontmatter.variant === "string" ? frontmatter.variant : undefined,
        raw.model
      );
    }
    const body: JsonObject = {};
    if (typeof frontmatter.temperature === "number") {
      body.temperature = frontmatter.temperature;
    }
    if (typeof frontmatter.top_p === "number") {
      body.top_p = frontmatter.top_p;
    }
    const options = asObject(frontmatter.options);
    if (options) {
      Object.assign(body, options);
    }
    const request: JsonObject = asObject(raw.request) ? { ...(raw.request as JsonObject) } : {};
    if (Object.keys(body).length > 0) {
      request.body = body;
    } else {
      delete request.body;
    }
    if (Object.keys(request).length > 0) {
      out.request = request;
    }
    if (frontmatter.disable === true) {
      out.disabled = true;
    }
    const rules = permissionRules(frontmatter.permission);
    if (rules.length > 0) {
      out.permissions = rules;
    }
    if (promptValue !== undefined) {
      out.system = promptValue;
    }
  }

  for (const [name, value] of Object.entries(frontmatter)) {
    if (HANDLED.has(name) || value === undefined || value === null) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Entrada cruda del JSON, leída fresca del disco para no pisar cambios de otros campos. */
function rawEntryOf(text: string, key: ConfigAgentKey, name: string, filePath: string): JsonObject {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  const raw = asObject(asObject(asObject(parsed)?.[key])?.[name]);
  if (!raw) {
    throw new Error(`La entrada "${name}" ya no está en ${filePath}.`);
  }
  return raw;
}

/** Conserva los finales de línea del fichero del prompt (no reescribe todo con LF). */
async function writePromptFile(file: string, text: string): Promise<void> {
  let eol: "\r\n" | "\n" = "\n";
  try {
    const current = await fs.readFile(file, "utf8");
    eol = current.includes("\r\n") ? "\r\n" : "\n";
  } catch {
    // todavía no existe: se crea con LF
  }
  const lf = text.replace(/\r\n?/g, "\n");
  await writeAtomic(file, eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf);
}

/**
 * Guarda un agente inline: parchea solo las claves gestionadas de su entrada y deja
 * intactas las desconocidas, los comentarios y el resto del fichero. Con `promptFile` el
 * texto va a ese fichero y la referencia `{file:...}` se queda como estaba.
 */
export async function saveConfigAgent(
  entry: ConfigAgentEntry,
  next: { name: string; frontmatter: AgentFrontmatter; prompt: string }
): Promise<string> {
  const text = await fs.readFile(entry.filePath, "utf8");
  const raw = rawEntryOf(text, entry.key, entry.name, entry.filePath);
  const promptRef = entry.promptFile
    ? typeof raw.prompt === "string"
      ? raw.prompt
      : typeof raw.system === "string"
        ? raw.system
        : undefined
    : undefined;

  const before = entryFields(entry.key, entry.frontmatter, entry.promptText, promptRef, raw);
  const after = entryFields(entry.key, next.frontmatter, next.prompt, promptRef, raw);

  let result = text;
  if (next.name !== entry.name) {
    // Al renombrar se borra la clave vieja y se escribe la entrada entera en la nueva.
    result = applyEdits(
      result,
      modify(result, [entry.key, entry.name], undefined, { formattingOptions: FMT })
    );
    const entryObject: JsonObject = { ...raw };
    for (const name of Object.keys(before)) {
      if (!(name in after)) {
        delete entryObject[name];
      }
    }
    for (const [name, value] of Object.entries(after)) {
      entryObject[name] = value;
    }
    result = applyEdits(
      result,
      modify(result, [entry.key, next.name], entryObject, { formattingOptions: FMT })
    );
  } else {
    // Solo se tocan las claves cuyo valor cambia: así una entrada a medio tocar no se reindenta.
    for (const name of Object.keys(before)) {
      if (!(name in after)) {
        result = applyEdits(
          result,
          modify(result, [entry.key, next.name, name], undefined, { formattingOptions: FMT })
        );
      }
    }
    for (const [name, value] of Object.entries(after)) {
      if (JSON.stringify(before[name]) === JSON.stringify(value)) {
        continue;
      }
      result = applyEdits(
        result,
        modify(result, [entry.key, next.name, name], value, { formattingOptions: FMT })
      );
    }
  }

  if (entry.promptFile) {
    await writePromptFile(entry.promptFile, next.prompt);
  }
  await writeAtomic(entry.filePath, result);
  return entry.filePath;
}

/** Quita la entrada del JSON. El fichero del prompt se conserva. */
export async function deleteConfigAgent(entry: ConfigAgentEntry): Promise<string> {
  const text = await fs.readFile(entry.filePath, "utf8");
  const result = applyEdits(
    text,
    modify(text, [entry.key, entry.name], undefined, { formattingOptions: FMT })
  );
  await writeAtomic(entry.filePath, result);
  return entry.filePath;
}

/** Fija el `model` de la entrada (o lo borra con ""). Devuelve la ruta del JSON. */
export async function setConfigAgentModel(
  entry: ConfigAgentEntry,
  model: string
): Promise<string> {
  const text = await fs.readFile(entry.filePath, "utf8");
  const raw = rawEntryOf(text, entry.key, entry.name, entry.filePath);
  // Solo la clave `model`: el resto de la entrada se queda como estaba, comentarios incluidos.
  const value: unknown =
    model === ""
      ? undefined
      : entry.key === "agents"
        ? v2ModelValue(model, undefined, raw.model)
        : model;
  const result = applyEdits(
    text,
    modify(text, [entry.key, entry.name, "model"], value, { formattingOptions: FMT })
  );
  await writeAtomic(entry.filePath, result);
  return entry.filePath;
}
