import * as fs from "fs/promises";
import * as path from "path";
import {
  applyEdits,
  findNodeAtLocation,
  FormattingOptions,
  modify,
  parse as parseJsonc,
  parseTree,
} from "jsonc-parser";
import type { Node } from "jsonc-parser";
import { Registry, RegistryModel } from "./config";
import { configFileCandidates, globalOpencodeDir } from "./paths";
import { loadRegistry, pathExists, writeAtomic } from "./store";

export type OpencodeApi = (method: string, route: string, body?: unknown) => Promise<string>;
export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;

export interface ConnectorFormField {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  placeholder?: string;
  default?: FormValue;
  options?: { value: string; label: string; description?: string }[];
  when?: { key: string; op: "eq" | "neq"; value: string | number | boolean };
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  custom?: boolean;
  url?: string;
}

export interface ConnectorMethod {
  id: string;
  type: "key" | "oauth" | "external" | "command" | "env";
  label: string;
  fields: ConnectorFormField[];
  envNames?: string[];
}

export interface ConnectorConnection {
  type: "credential" | "env";
  label: string;
  method?: string;
  status?: string;
  message?: string;
}

export interface ConnectorEntry {
  id: string;
  name: string;
  providerId: string;
  modelCount: number;
  configured: boolean;
  enabled: boolean;
  toggleable: boolean;
  source: "catalog" | "custom";
  connections: ConnectorConnection[];
  methods: ConnectorMethod[];
  configFiles: string[];
}

export interface ConnectorModel {
  id: string;
  name: string;
  description?: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  free?: boolean;
  context?: number;
  output?: number;
  status?: string;
  release?: string;
  tools?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  live?: boolean;
}

export interface ConnectorsData {
  connectors: ConnectorEntry[];
  selected: string;
  search: string;
  models: ConnectorModel[];
  configuredCount: number;
  note?: string;
}

export interface ConnectorAttempt {
  id: string;
  attemptID: string;
  kind: "oauth" | "command";
  status: "pending" | "complete" | "failed" | "expired" | "cancelled";
  message?: string;
  url?: string;
  instructions?: string;
  mode?: "auto" | "code";
}

export interface ConnectorRemoveResult {
  credentialsRemoved: number;
  configFilesChanged: string[];
  envKept: string[];
  errors: string[];
}

export interface PolicyStatement {
  action: string;
  resource: string;
  effect: string;
}

type JsonObject = Record<string, unknown>;

interface RawIntegration {
  id?: string;
  name?: string;
  methods?: RawMethod[];
  connections?: RawConnection[];
}

interface RawMethod {
  id?: string;
  type?: string;
  label?: string;
  names?: unknown;
  form?: JsonObject[];
}

interface RawConnection {
  type?: string;
  id?: string;
  name?: string;
  label?: string;
  method?: string;
  status?: unknown;
  message?: string;
}

interface RawProvider {
  id?: string;
  integrationID?: string;
  name?: string;
  activation?: string;
}

interface RawCostTier {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

interface RawModel {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
  enabled?: boolean;
  cost?: RawCostTier[];
  limit?: { context?: number; output?: number };
  status?: string;
  time?: { released?: number };
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
}

const FIELD_TYPES: ConnectorFormField["type"][] = [
  "string",
  "number",
  "integer",
  "boolean",
  "multiselect",
  "external",
];

const METHOD_LABELS: Record<"key" | "oauth" | "external" | "command", string> = {
  key: "Clave de API",
  oauth: "Iniciar sesión",
  external: "Credenciales externas",
  command: "Conectar por comando",
};

const SCHEMA_SKELETON = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

function formValue(value: unknown): FormValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

function detailOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim().slice(0, 300) || "opencode no respondió";
}

function requireId(value: string, what: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    throw new Error(`Falta el ${what}.`);
  }
  return id;
}

/** opencode devuelve `{data: ...}`; una respuesta sin esa forma es un fallo de la API. */
function parseData<T>(raw: string): T {
  try {
    const parsed = JSON.parse(raw) as { data?: T };
    if (parsed && typeof parsed === "object" && parsed.data !== undefined) {
      return parsed.data;
    }
  } catch {
    // cae al error de abajo
  }
  throw new Error("Respuesta ilegible de opencode.");
}

function readList<T>(
  result: PromiseSettledResult<string>,
  what: string,
  notes: string[]
): T[] {
  if (result.status === "rejected") {
    notes.push(`No se pudo leer ${what}.`);
    return [];
  }
  try {
    const parsed = JSON.parse(result.value) as { data?: unknown };
    return Array.isArray(parsed.data) ? (parsed.data as T[]) : [];
  } catch {
    notes.push(`Respuesta ilegible de ${what}.`);
    return [];
  }
}

function mapField(raw: JsonObject): ConnectorFormField | undefined {
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!key) {
    return undefined;
  }
  const type = FIELD_TYPES.includes(raw.type as ConnectorFormField["type"])
    ? (raw.type as ConnectorFormField["type"])
    : "string";
  const field: ConnectorFormField = { key, type };
  if (typeof raw.title === "string") {
    field.title = raw.title;
  }
  if (typeof raw.description === "string") {
    field.description = raw.description;
  }
  if (typeof raw.required === "boolean") {
    field.required = raw.required;
  }
  if (typeof raw.hidden === "boolean") {
    field.hidden = raw.hidden;
  }
  if (typeof raw.placeholder === "string") {
    field.placeholder = raw.placeholder;
  }
  const def = formValue(raw.default);
  if (def !== undefined) {
    field.default = def;
  }
  if (Array.isArray(raw.options)) {
    const options = raw.options
      .map(asObject)
      .filter((o): o is JsonObject => !!o && typeof o.value === "string" && typeof o.label === "string")
      .map((o) => ({
        value: o.value as string,
        label: o.label as string,
        ...(typeof o.description === "string" ? { description: o.description } : {}),
      }));
    if (options.length > 0) {
      field.options = options;
    }
  }
  // La API manda `when` como lista; el panel solo necesita la primera condición.
  const whenRaw = Array.isArray(raw.when) ? raw.when[0] : raw.when;
  const when = asObject(whenRaw);
  if (when && typeof when.key === "string" && (when.op === "eq" || when.op === "neq")) {
    const value = formValue(when.value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      field.when = { key: when.key, op: when.op, value };
    }
  }
  for (const bound of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"] as const) {
    if (typeof raw[bound] === "number") {
      field[bound] = raw[bound] as number;
    }
  }
  if (typeof raw.pattern === "string") {
    field.pattern = raw.pattern;
  }
  if (typeof raw.format === "string") {
    field.format = raw.format;
  }
  if (typeof raw.custom === "boolean") {
    field.custom = raw.custom;
  }
  if (typeof raw.url === "string") {
    field.url = raw.url;
  }
  return field;
}

function mapMethod(raw: RawMethod): ConnectorMethod | undefined {
  if (raw.type === "env") {
    return {
      id: "env",
      type: "env",
      label: "Variables de entorno",
      fields: [],
      envNames: stringList(raw.names),
    };
  }
  if (raw.type !== "key" && raw.type !== "oauth" && raw.type !== "external" && raw.type !== "command") {
    return undefined;
  }
  const id = raw.type === "key" ? "key" : typeof raw.id === "string" && raw.id ? raw.id : raw.type;
  const fields = Array.isArray(raw.form)
    ? raw.form
        .map(asObject)
        .filter((f): f is JsonObject => !!f)
        .map(mapField)
        .filter((f): f is ConnectorFormField => !!f)
    : [];
  return {
    id,
    type: raw.type,
    label: typeof raw.label === "string" && raw.label ? raw.label : METHOD_LABELS[raw.type],
    fields,
  };
}

/** La API anida el estado de la conexión (`{status,message,url}`); algunas versiones lo mandan plano. */
function connectionState(connection: RawConnection): { status?: string; message?: string } {
  const nested = asObject(connection.status);
  const status =
    typeof connection.status === "string"
      ? connection.status
      : typeof nested?.status === "string"
        ? nested.status
        : undefined;
  const message =
    typeof connection.message === "string"
      ? connection.message
      : typeof nested?.message === "string"
        ? nested.message
        : undefined;
  return {
    ...(status ? { status } : {}),
    ...(message ? { message } : {}),
  };
}

/** Las credenciales nunca llevan su id a la UI. */
function mapConnections(raw: RawIntegration | undefined): ConnectorConnection[] {
  const out: ConnectorConnection[] = [];
  for (const connection of raw?.connections ?? []) {
    if (connection.type === "credential") {
      out.push({
        type: "credential",
        label: typeof connection.label === "string" && connection.label ? connection.label : "Credencial",
        ...(typeof connection.method === "string" ? { method: connection.method } : {}),
        ...connectionState(connection),
      });
    } else if (connection.type === "env") {
      out.push({
        type: "env",
        label: typeof connection.name === "string" ? connection.name : "",
        ...connectionState(connection),
      });
    }
  }
  return out;
}

function mapMethods(raw: RawIntegration | undefined): ConnectorMethod[] {
  return (raw?.methods ?? [])
    .map(mapMethod)
    .filter((m): m is ConnectorMethod => !!m);
}

/* ------------------------------- Políticas -------------------------------- */

function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`).test(name);
  } catch {
    return pattern === name;
  }
}

/** Última regla que casa, como hace opencode (el global va después del proyecto). */
export function policyDenied(statements: PolicyStatement[], providerId: string): boolean {
  let effect: string | undefined;
  for (const statement of statements) {
    if (statement.action === "provider.use" && globMatch(statement.resource, providerId)) {
      effect = statement.effect;
    }
  }
  return effect === "deny";
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function formatting(text: string): FormattingOptions {
  return { insertSpaces: true, tabSize: 2, eol: detectEol(text) };
}

function nodeValue(text: string, node: Node): unknown {
  return parseJsonc(text.slice(node.offset, node.offset + node.length), [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
}

/** Inserta una sentencia al final del array sin reescribir el resto del fichero. */
function insertStatement(
  text: string,
  array: Node,
  statement: PolicyStatement,
  eol: string
): string {
  const close = array.offset + array.length - 1;
  const children = array.children ?? [];
  const lineStart = text.lastIndexOf("\n", close - 1) + 1;
  const beforeClose = text.slice(lineStart, close);
  const indentation = /^[ \t]*/.exec(beforeClose)?.[0] ?? "";

  const elementIndent = `${indentation}  `;
  const pretty = JSON.stringify(statement, null, 2).replace(/\n/g, `${eol}${elementIndent}`);

  // Array vacío en una sola línea (`"policies": []`): se rellena antes del corchete.
  if (children.length === 0) {
    if (beforeClose.trim() !== "") {
      return text.slice(0, close) + JSON.stringify(statement) + text.slice(close);
    }
    // Array vacío con el corchete en su propia línea.
    return text.slice(0, lineStart) + `${elementIndent}${pretty}${eol}` + text.slice(lineStart);
  }

  // Arrays de una sola línea (`"policies": [{...}]`): se añade en la misma línea.
  if (beforeClose.trim() !== "") {
    const inline = JSON.stringify(statement);
    const prefix = beforeClose.trim().endsWith(",") ? " " : ", ";
    return text.slice(0, close) + prefix + inline + text.slice(close);
  }

  const last = children[children.length - 1];
  const lastEnd = last.offset + last.length;
  const between = text
    .slice(lastEnd, close)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const edits: { offset: number; length: number; content: string }[] = [];
  if (!between.includes(",")) {
    edits.push({ offset: lastEnd, length: 0, content: "," });
  }
  edits.push({ offset: lineStart, length: 0, content: `${elementIndent}${pretty}${eol}` });
  return applyEdits(text, edits);
}

/**
 * Añade `{action:"provider.use", ...}` al array `policies` (o a `experimental.policies` si
 * solo existe ahí) conservando comentarios, comas finales y el resto del texto.
 */
export function appendPolicyStatement(
  text: string,
  statement: { action: "provider.use"; resource: string; effect: "allow" | "deny" }
): string {
  const eol = detectEol(text);
  const tree = parseTree(text);
  const plain = tree ? findNodeAtLocation(tree, ["policies"]) : undefined;
  if (plain?.type === "array") {
    return insertStatement(text, plain, statement, eol);
  }
  const legacy = tree ? findNodeAtLocation(tree, ["experimental", "policies"]) : undefined;
  if (legacy?.type === "array") {
    return insertStatement(text, legacy, statement, eol);
  }
  const base = text.trim() ? text : SCHEMA_SKELETON;
  return applyEdits(base, modify(base, ["policies"], [statement], { formattingOptions: formatting(base) }));
}

/** Rango que borra un hijo del array sin tocar los demás ni sus comentarios. */
function childEdit(array: Node, index: number) {
  const children = array.children ?? [];
  const child = children[index];
  if (index > 0) {
    const previous = children[index - 1];
    return { offset: previous.offset + previous.length, length: child.offset + child.length - (previous.offset + previous.length), content: "" };
  }
  if (children.length > 1) {
    const next = children[1];
    return { offset: child.offset, length: next.offset - child.offset, content: "" };
  }
  return { offset: child.offset, length: child.length, content: "" };
}

function removeMatchingChildren(
  text: string,
  keyPath: string[],
  matches: (value: unknown) => boolean
): string {
  let result = text;
  // Cada borrado se aplica sobre el texto ya recortado para no arrastrar offsets.
  for (let guard = 0; guard < 200; guard++) {
    const tree = parseTree(result);
    const array = tree ? findNodeAtLocation(tree, keyPath) : undefined;
    if (!array || array.type !== "array") {
      return result;
    }
    const index = (array.children ?? []).findIndex((child) => matches(nodeValue(result, child)));
    if (index < 0) {
      return result;
    }
    result = applyEdits(result, [childEdit(array, index)]);
  }
  return result;
}

/** Quita las reglas exactas de ese proveedor; las demás y los comentarios se quedan. */
export function removePolicyStatements(text: string, providerId: string): string {
  const matches = (value: unknown): boolean => {
    const statement = asObject(value);
    return statement?.action === "provider.use" && statement?.resource === providerId;
  };
  let result = removeMatchingChildren(text, ["policies"], matches);
  result = removeMatchingChildren(result, ["experimental", "policies"], matches);
  return result;
}

function deleteKey(text: string, keyPath: string[]): string {
  const tree = parseTree(text);
  if (!tree) {
    return text;
  }
  const parent = findNodeAtLocation(tree, keyPath.slice(0, -1));
  if (!parent || parent.type !== "object") {
    return text;
  }
  const key = keyPath[keyPath.length - 1];
  const children = parent.children ?? [];
  const index = children.findIndex((child) => {
    const keyNode = child.type === "property" ? child.children?.[0] : undefined;
    return keyNode ? nodeValue(text, keyNode) === key : false;
  });
  if (index < 0) {
    return text;
  }
  const child = children[index];
  let start = child.offset;
  let end = child.offset + child.length;
  // La coma que separa: la de después si la hay, si no la de antes.
  const trailing = /^[ \t]*,/.exec(text.slice(end));
  if (trailing) {
    end += trailing[0].length;
  } else if (index > 0) {
    const previousEnd = children[index - 1].offset + children[index - 1].length;
    const comma = text.lastIndexOf(",", start);
    if (comma < previousEnd) {
      return text;
    }
    start = comma;
  }
  // Si la clave ocupa su línea entera, se lleva también el salto de línea.
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline < 0 ? text.length : newline;
  const prefix = text.slice(lineStart, start);
  const suffix = text.slice(end, lineEnd);
  if (prefix.trim() === "" && suffix.trim() === "") {
    start = lineStart;
    end = newline < 0 ? text.length : newline + 1;
  }
  return text.slice(0, start) + text.slice(end);
}

/** Quita `provider.<id>`, `providers.<id>` y el id de `disabled_providers`. */
export function removeProviderEntries(text: string, providerId: string): string {
  let result = deleteKey(text, ["provider", providerId]);
  result = deleteKey(result, ["providers", providerId]);
  return removeMatchingChildren(
    result,
    ["disabled_providers"],
    (value) => typeof value === "string" && value === providerId
  );
}

/* -------------------------------- Ficheros -------------------------------- */

interface ConfigSnapshot {
  /** id de proveedor → ficheros que lo declaran bajo `provider` o `providers`. */
  providerFiles: Map<string, string[]>;
  /** Reglas de todos los candidatos, en su orden (el global al final). */
  policies: PolicyStatement[];
}

async function readConfigSnapshot(): Promise<ConfigSnapshot> {
  const providerFiles = new Map<string, string[]>();
  const policies: PolicyStatement[] = [];
  for (const file of configFileCandidates()) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const obj = asObject(parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false }));
    if (!obj) {
      continue;
    }
    for (const key of ["provider", "providers"] as const) {
      const bag = asObject(obj[key]);
      if (!bag) {
        continue;
      }
      for (const id of Object.keys(bag)) {
        const files = providerFiles.get(id) ?? [];
        files.push(file);
        providerFiles.set(id, files);
      }
    }
    for (const raw of [obj.policies, asObject(obj.experimental)?.policies]) {
      if (!Array.isArray(raw)) {
        continue;
      }
      for (const item of raw) {
        const statement = asObject(item);
        if (
          typeof statement?.action === "string" &&
          typeof statement.resource === "string" &&
          typeof statement.effect === "string"
        ) {
          policies.push({
            action: statement.action,
            resource: statement.resource,
            effect: statement.effect,
          });
        }
      }
    }
  }
  return { providerFiles, policies };
}

/** Fichero global donde se escriben las políticas: jsonc si existe, luego json, si no se crea. */
async function globalPolicyFile(): Promise<string> {
  const dir = globalOpencodeDir();
  const jsonc = path.join(dir, "opencode.jsonc");
  if (await pathExists(jsonc)) {
    return jsonc;
  }
  const json = path.join(dir, "opencode.json");
  if (await pathExists(json)) {
    return json;
  }
  return jsonc;
}

function costFromCatalog(cost: RegistryModel["cost"]): ConnectorModel["cost"] {
  if (!cost) {
    return undefined;
  }
  const out: NonNullable<ConnectorModel["cost"]> = {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cache_read,
    cacheWrite: cost.cache_write,
  };
  return [out.input, out.output, out.cacheRead, out.cacheWrite].some((v) => typeof v === "number")
    ? out
    : undefined;
}

/** Gratis solo si hay tarifa y todo lo declarado está a cero. */
function isFree(cost: ConnectorModel["cost"]): boolean | undefined {
  if (!cost) {
    return undefined;
  }
  const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].filter(
    (v): v is number => typeof v === "number"
  );
  return values.length > 0 && values.every((v) => v === 0);
}

function releaseOf(released: number | undefined): string | undefined {
  if (!released || !Number.isFinite(released)) {
    return undefined;
  }
  try {
    return new Date(released).toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

function buildModels(registry: Registry, live: RawModel[], providerId: string): ConnectorModel[] {
  const models = new Map<string, ConnectorModel>();
  const provider = registry[providerId];
  for (const [key, raw] of Object.entries(provider?.models ?? {})) {
    // El catálogo conserva versiones retiradas; no se ofrecen ni cuentan.
    if (raw.status === "deprecated") {
      continue;
    }
    const id = typeof raw.id === "string" && raw.id ? raw.id : key;
    const cost = costFromCatalog(raw.cost);
    models.set(id, {
      id,
      name: raw.name || id,
      ...(raw.description ? { description: raw.description } : {}),
      ...(cost ? { cost, free: isFree(cost) } : {}),
      ...(typeof raw.limit?.context === "number" ? { context: raw.limit.context } : {}),
      ...(typeof raw.limit?.output === "number" ? { output: raw.limit.output } : {}),
      ...(raw.status ? { status: raw.status } : {}),
      ...(raw.release_date ? { release: raw.release_date } : {}),
      ...(typeof raw.tool_call === "boolean" ? { tools: raw.tool_call } : {}),
      ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
      vision: raw.modalities?.input?.includes("image") === true || raw.attachment === true,
    });
  }

  for (const raw of live) {
    if (raw.providerID !== providerId || raw.enabled === false) {
      continue;
    }
    const id = raw.modelID || raw.id;
    if (!id) {
      continue;
    }
    const tier = raw.cost?.[0];
    const cost = tier
      ? {
          input: tier.input,
          output: tier.output,
          cacheRead: tier.cache?.read,
          cacheWrite: tier.cache?.write,
        }
      : undefined;
    const known = models.get(id);
    if (known) {
      // El catálogo manda; de la API solo se rellena lo que falte.
      if (!known.cost && cost) {
        known.cost = cost;
        known.free = isFree(cost);
      }
      known.context ??= raw.limit?.context;
      known.output ??= raw.limit?.output;
      known.status ??= raw.status;
      known.release ??= releaseOf(raw.time?.released);
      known.tools ??= raw.capabilities?.tools;
      known.vision ??= raw.capabilities?.input?.includes("image");
      continue;
    }
    const release = releaseOf(raw.time?.released);
    const tools = raw.capabilities?.tools;
    models.set(id, {
      id,
      name: raw.name || id,
      ...(cost ? { cost, free: isFree(cost) } : {}),
      ...(typeof raw.limit?.context === "number" ? { context: raw.limit.context } : {}),
      ...(typeof raw.limit?.output === "number" ? { output: raw.limit.output } : {}),
      ...(raw.status ? { status: raw.status } : {}),
      ...(release ? { release } : {}),
      ...(typeof tools === "boolean" ? { tools } : {}),
      vision: raw.capabilities?.input?.includes("image") === true,
      live: true,
    });
  }

  return [...models.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

/* --------------------------------- Servicio -------------------------------- */

interface Snapshot {
  entries: ConnectorEntry[];
  models: Map<string, ConnectorModel[]>;
}

export class ConnectorService {
  private cache?: { snapshot: Snapshot; configuredCount: number; note?: string };
  private catalog?: Registry;

  constructor(private readonly api: OpencodeApi) {}

  /** refresh=false reutiliza la última copia y solo cambia la selección/búsqueda. */
  async collect(opts: { selected: string; search: string; refresh?: boolean }): Promise<ConnectorsData> {
    if (opts.refresh || !this.cache) {
      this.cache = await this.load();
    }
    const { entries, models } = this.cache.snapshot;
    const chosen =
      entries.find((entry) => entry.id === opts.selected) ??
      entries.find((entry) => entry.configured) ??
      entries[0];
    return {
      connectors: entries,
      selected: chosen?.id ?? "",
      search: opts.search,
      models: chosen ? models.get(chosen.providerId) ?? [] : [],
      configuredCount: this.cache.configuredCount,
      ...(this.cache.note ? { note: this.cache.note } : {}),
    };
  }

  /** on=true quita la denegación; on=false la añade. Escribe en la config global. */
  async toggle(id: string, on: boolean): Promise<void> {
    const providerId = await this.resolveProviderId(requireId(id, "conector"));
    if (!providerId) {
      throw new Error("Ese conector no es un proveedor: no se puede encender ni apagar.");
    }
    const snapshot = await readConfigSnapshot();
    const denied = policyDenied(snapshot.policies, providerId);
    if (on === !denied) {
      return; // ya está en el estado pedido
    }
    const file = await globalPolicyFile();
    let text = SCHEMA_SKELETON;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      // no existe: se crea con el esquema
    }
    if (!text.trim()) {
      text = SCHEMA_SKELETON;
    }
    const next = appendPolicyStatement(removePolicyStatements(text, providerId), {
      action: "provider.use",
      resource: providerId,
      effect: on ? "allow" : "deny",
    });
    await writeAtomic(file, next);
    this.cache = undefined;
  }

  /** Borra credenciales, entradas de proveedor y políticas exactas de ese conector. */
  async remove(id: string): Promise<ConnectorRemoveResult> {
    const target = requireId(id, "conector");
    const errors: string[] = [];
    let integration: RawIntegration | undefined;
    try {
      const raw = await this.api("GET", "/api/integration");
      const data = parseData<RawIntegration[]>(raw);
      integration = Array.isArray(data) ? data.find((item) => item.id === target) : undefined;
    } catch (err) {
      errors.push(`No se pudo leer la integración: ${detailOf(err)}`);
    }

    const credentials = (integration?.connections ?? []).filter(
      (connection) => connection.type === "credential" && typeof connection.id === "string" && connection.id
    );
    let credentialsRemoved = 0;
    for (const [index, credential] of credentials.entries()) {
      try {
        await this.api("DELETE", `/api/credential/${encodeURIComponent(credential.id as string)}`);
        credentialsRemoved += 1;
      } catch {
        // Sin detalle: el error del CLI puede repetir el id de la credencial.
        errors.push(`No se pudo borrar la credencial ${index + 1} de ${credentials.length}.`);
      }
    }

    const envKept = (integration?.connections ?? [])
      .filter((connection) => connection.type === "env" && typeof connection.name === "string" && connection.name)
      .map((connection) => connection.name as string);

    const providerId = await this.resolveProviderId(target).catch(() => "");
    const ids = new Set([target]);
    if (providerId) {
      ids.add(providerId);
    }
    const changed: string[] = [];
    for (const file of configFileCandidates()) {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const before = text;
      for (const candidate of ids) {
        text = removePolicyStatements(text, candidate);
        text = removeProviderEntries(text, candidate);
      }
      if (text === before) {
        continue;
      }
      try {
        await writeAtomic(file, text);
        changed.push(file);
      } catch (err) {
        errors.push(`No se pudo escribir ${path.basename(file)}: ${detailOf(err)}`);
      }
    }
    this.cache = undefined;
    return { credentialsRemoved, configFilesChanged: changed, envKept, errors };
  }

  async connectKey(id: string, key: string, answer?: FormAnswer): Promise<void> {
    const integration = requireId(id, "conector");
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("La clave no puede estar vacía.");
    }
    if (key.length > 4096) {
      throw new Error("La clave no puede superar los 4096 caracteres.");
    }
    try {
      await this.api("POST", `/api/integration/${encodeURIComponent(integration)}/connect/key`, {
        key,
        answer: answerBody(answer),
        label: null,
      });
    } catch (err) {
      // El detalle del CLI no debe devolver la clave al panel.
      const detail = detailOf(err);
      const safe = key.length >= 8 ? detail.split(key).join("***") : "revisa la clave y vuelve a intentarlo";
      throw new Error(`No se pudo guardar la clave: ${safe}`);
    }
    this.cache = undefined;
  }

  async connectExternal(id: string, methodID: string, answer?: FormAnswer): Promise<void> {
    const integration = requireId(id, "conector");
    const method = requireId(methodID, "método de conexión");
    await this.call(
      "POST",
      `/api/integration/${encodeURIComponent(integration)}/connect/external`,
      { methodID: method, answer: answerBody(answer), label: null },
      "No se pudo conectar con esas credenciales"
    );
    this.cache = undefined;
  }

  async startOauth(id: string, methodID: string, answer?: FormAnswer): Promise<ConnectorAttempt> {
    const integration = requireId(id, "conector");
    const method = requireId(methodID, "método de conexión");
    const raw = await this.call(
      "POST",
      `/api/integration/${encodeURIComponent(integration)}/connect/oauth`,
      { methodID: method, answer: answerBody(answer) },
      "No se pudo iniciar el inicio de sesión"
    );
    const data = parseData<{ attemptID?: string; url?: string; instructions?: string; mode?: string }>(raw);
    if (!data.attemptID) {
      throw new Error("opencode no devolvió el identificador del intento.");
    }
    const mode = data.mode === "auto" || data.mode === "code" ? data.mode : undefined;
    return {
      id: integration,
      attemptID: data.attemptID,
      kind: "oauth",
      status: "pending",
      ...(data.url ? { url: data.url } : {}),
      ...(data.instructions ? { instructions: data.instructions } : {}),
      ...(mode ? { mode } : {}),
    };
  }

  async completeOauth(id: string, attemptID: string, code?: string): Promise<void> {
    const integration = requireId(id, "conector");
    const attempt = requireId(attemptID, "intento de conexión");
    await this.call(
      "POST",
      `/api/integration/${encodeURIComponent(integration)}/connect/oauth/${encodeURIComponent(attempt)}/complete`,
      { code: typeof code === "string" && code.trim() ? code.trim() : null },
      "No se pudo completar el inicio de sesión"
    );
    this.cache = undefined;
  }

  async cancelOauth(id: string, attemptID: string): Promise<void> {
    const integration = requireId(id, "conector");
    const attempt = requireId(attemptID, "intento de conexión");
    await this.call(
      "DELETE",
      `/api/integration/${encodeURIComponent(integration)}/connect/oauth/${encodeURIComponent(attempt)}`,
      undefined,
      "No se pudo cancelar el inicio de sesión"
    );
  }

  async cancelCommand(id: string, attemptID: string): Promise<void> {
    const integration = requireId(id, "conector");
    const attempt = requireId(attemptID, "intento de conexión");
    await this.call(
      "DELETE",
      `/api/integration/${encodeURIComponent(integration)}/connect/command/${encodeURIComponent(attempt)}`,
      undefined,
      "No se pudo cancelar la conexión por comando"
    );
  }

  async startCommand(id: string, methodID: string): Promise<ConnectorAttempt> {
    const integration = requireId(id, "conector");
    const method = requireId(methodID, "método de conexión");
    const raw = await this.call(
      "POST",
      `/api/integration/${encodeURIComponent(integration)}/connect/command`,
      { methodID: method },
      "No se pudo iniciar la conexión por comando"
    );
    const data = parseData<{ attemptID?: string }>(raw);
    if (!data.attemptID) {
      throw new Error("opencode no devolvió el identificador del intento.");
    }
    return { id: integration, attemptID: data.attemptID, kind: "command", status: "pending" };
  }

  async oauthStatus(id: string, attemptID: string): Promise<ConnectorAttempt> {
    return this.attemptStatus("oauth", id, attemptID);
  }

  async commandStatus(id: string, attemptID: string): Promise<ConnectorAttempt> {
    return this.attemptStatus("command", id, attemptID);
  }

  /* ------------------------------- Interno -------------------------------- */

  private async attemptStatus(
    kind: "oauth" | "command",
    id: string,
    attemptID: string
  ): Promise<ConnectorAttempt> {
    const integration = requireId(id, "conector");
    const attempt = requireId(attemptID, "intento de conexión");
    const route =
      kind === "oauth"
        ? `/api/integration/${encodeURIComponent(integration)}/connect/oauth/${encodeURIComponent(attempt)}`
        : `/api/integration/${encodeURIComponent(integration)}/connect/command/${encodeURIComponent(attempt)}`;
    const raw = await this.call("GET", route, undefined, "No se pudo consultar la conexión");
    const data = parseData<{ status?: string; message?: string }>(raw);
    const status = data.status;
    if (status === "pending" || status === "complete" || status === "failed" || status === "expired") {
      return {
        id: integration,
        attemptID: attempt,
        kind,
        status,
        ...(data.message ? { message: data.message } : {}),
      };
    }
    return {
      id: integration,
      attemptID: attempt,
      kind,
      status: "failed",
      message: data.message || (status ? `Estado desconocido: ${status}` : "Estado desconocido."),
    };
  }

  private async call(
    method: string,
    route: string,
    body: unknown,
    action: string
  ): Promise<string> {
    try {
      return await this.api(method, route, body);
    } catch (err) {
      throw new Error(`${action}: ${detailOf(err)}`);
    }
  }

  private async resolveProviderId(id: string): Promise<string> {
    const cached = this.cache?.snapshot.entries.find((entry) => entry.id === id);
    if (cached) {
      return cached.providerId;
    }
    const [integrationsResult, providersResult] = await Promise.allSettled([
      this.api("GET", "/api/integration"),
      this.api("GET", "/api/provider"),
    ]);
    const integrations = readList<RawIntegration>(integrationsResult, "las integraciones", []);
    const providers = readList<RawProvider>(providersResult, "los proveedores", []);
    const integration = integrations.find((item) => item.id === id);
    const provider =
      providers.find((item) => item.id === id) ??
      (integration ? providers.find((item) => item.integrationID === id) : undefined);
    if (provider?.id) {
      return provider.id;
    }
    // Sin `/api/provider` (p. ej. denegado) la config o una política siguen identificándolo.
    const snapshot = await readConfigSnapshot();
    if (
      snapshot.providerFiles.has(id) ||
      snapshot.policies.some(
        (statement) => statement.action === "provider.use" && statement.resource === id
      )
    ) {
      return id;
    }
    // Sin introspección no se puede distinguir: se usa el id tal cual.
    if (integrationsResult.status === "rejected" && providersResult.status === "rejected") {
      return id;
    }
    return integration ? "" : id;
  }

  private async loadCatalog(): Promise<Registry> {
    if (this.catalog) {
      return this.catalog;
    }
    try {
      this.catalog = (await loadRegistry()) ?? {};
    } catch {
      this.catalog = {};
    }
    return this.catalog;
  }

  private async load(): Promise<{ snapshot: Snapshot; configuredCount: number; note?: string }> {
    const notes: string[] = [];
    const [integrationsResult, providersResult, modelsResult] = await Promise.allSettled([
      this.api("GET", "/api/integration"),
      this.api("GET", "/api/provider"),
      this.api("GET", "/api/model"),
    ]);
    const [snapshot, registry] = await Promise.all([readConfigSnapshot(), this.loadCatalog()]);
    const integrations = readList<RawIntegration>(integrationsResult, "las integraciones", notes);
    const providers = readList<RawProvider>(providersResult, "los proveedores", notes);
    const live = readList<RawModel>(modelsResult, "los modelos disponibles", notes);
    if (Object.keys(registry).length === 0) {
      notes.push("No se encontró el catálogo de models.dev: solo salen los proveedores en vivo.");
    }

    const integrationById = new Map<string, RawIntegration>();
    for (const integration of integrations) {
      if (typeof integration.id === "string" && integration.id) {
        integrationById.set(integration.id, integration);
      }
    }
    const providerById = new Map<string, RawProvider>();
    const providerByIntegration = new Map<string, RawProvider>();
    for (const provider of providers) {
      if (typeof provider.id !== "string" || !provider.id) {
        continue;
      }
      providerById.set(provider.id, provider);
      if (typeof provider.integrationID === "string" && provider.integrationID) {
        providerByIntegration.set(provider.integrationID, provider);
      }
    }

    const ids = new Set<string>(integrationById.keys());
    const linkedProviderIds = new Set<string>();
    for (const provider of providers) {
      if (typeof provider.id !== "string" || !provider.id) {
        continue;
      }
      // Si la integración ya lo cubre, no se duplica la fila.
      const linked =
        typeof provider.integrationID === "string" &&
        provider.integrationID !== "" &&
        integrationById.has(provider.integrationID);
      if (linked) {
        linkedProviderIds.add(provider.id);
      } else {
        ids.add(provider.id);
      }
    }
    for (const id of [...Object.keys(registry), ...snapshot.providerFiles.keys()]) {
      if (!linkedProviderIds.has(id)) {
        ids.add(id);
      }
    }

    const modelCache = new Map<string, ConnectorModel[]>();
    const modelsFor = (providerId: string): ConnectorModel[] => {
      const cached = modelCache.get(providerId);
      if (cached) {
        return cached;
      }
      const built = buildModels(registry, live, providerId);
      modelCache.set(providerId, built);
      return built;
    };

    const entries: ConnectorEntry[] = [];
    for (const id of ids) {
      const integration = integrationById.get(id);
      const provider = providerById.get(id) ?? providerByIntegration.get(id);
      const inConfig = snapshot.providerFiles.has(id);
      // Un proveedor denegado desaparece de `/api/provider`; su política aún lo delata como
      // proveedor (y permite volver a encenderlo) aunque no esté en el catálogo ni en la config.
      const mentioned = snapshot.policies.some(
        (statement) => statement.action === "provider.use" && statement.resource === id
      );
      const providerId = provider?.id ?? (registry[id] || inConfig || mentioned ? id : "");
      const models = providerId ? modelsFor(providerId) : [];
      const configFiles = [
        ...new Set([
          ...(snapshot.providerFiles.get(providerId) ?? []),
          ...(snapshot.providerFiles.get(id) ?? []),
        ]),
      ];
      const activation = provider?.activation;
      entries.push({
        id,
        name:
          (integration && typeof integration.name === "string" && integration.name) ||
          (provider && typeof provider.name === "string" && provider.name) ||
          registry[providerId]?.name ||
          registry[id]?.name ||
          id,
        providerId,
        modelCount: models.length,
        configured:
          (integration?.connections ?? []).length > 0 || configFiles.length > 0 || activation === "enabled",
        enabled: !(providerId && policyDenied(snapshot.policies, providerId)) && activation !== "disabled",
        toggleable: providerId !== "",
        source: registry[id] || registry[providerId] ? "catalog" : "custom",
        connections: mapConnections(integration),
        methods: mapMethods(integration),
        configFiles,
      });
    }

    entries.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
    return {
      snapshot: { entries, models: modelCache },
      configuredCount: entries.filter((entry) => entry.configured).length,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }
}

function answerBody(answer?: FormAnswer): FormAnswer | null {
  return answer && Object.keys(answer).length > 0 ? answer : null;
}
