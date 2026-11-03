/**
 * Panel COMPARAR MODELOS: dos fichas de modelo enfrentadas con los datos del catálogo vivo de
 * opencode y del registro models.dev que opencode guarda. Es de solo lectura: no escribe `model:`
 * en ningún agente ni toca la config de opencode.
 *
 * El marcado está en `media/modelCompare.html` (lo escribe `interfaz`): aquí solo se rellenan los
 * huecos `%%CSP%% %%NONCE%% %%THEME_LINKS%% %%THEME_SCRIPT%% %%STYLE%% %%SCRIPT%%` (los mismos del
 * chatbot) y se atiende al webview, que no es de fiar.
 *
 * PROTOCOLO
 * webview → host
 *   {type:"ready"}
 *   {type:"action", action:{type:"compare", keys:[string,string]}}   dos claves (modelo sin proveedor)
 *   {type:"action", action:{type:"setAlias", key, alias}}             alias de BenchLM; "" lo borra
 *   {type:"action", action:{type:"benchlmKey"}}                       pedir y guardar la clave
 *   {type:"action", action:{type:"openBenchlm"}}                      BenchLM en el navegador
 * host → webview
 *   {type:"theme", theme}
 *   {type:"init", payload:{models:[{key,id,name,provider,free}], cache:Record<clave,ficha>,
 *                          benchlmKey:boolean, aliases:Record<clave,alias>}}
 *   {type:"busy", on}
 *   {type:"compared", sheets:[ficha|null], error?}   sheets[0] = primera key, sheets[1] = segunda
 *   {type:"aliased", key, alias, sheet}              el alias quedó guardado ("" = borrado)
 *
 * Las puntuaciones de examen vienen de BenchLM (`data.benchlm.ai`), en `ficha.benchlm`. La clave
 * vive solo en `context.secrets`: al webview viaja `benchlmKey`, un booleano, nunca la clave.
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryModel } from "../agents/config";
import { MAX_ALIAS, slugify } from "../benchlm/aliases";
import type { BenchlmScore } from "../benchlm/scores";
import { currentTheme, themeLinks, themeScript } from "./theme";

/** Puntuaciones de BenchLM de un modelo: es lo más visible de la ficha. */
export interface BenchlmExam {
  boardId: string;
  /** Nombre legible del examen, sacado de `boards[]`. */
  name: string;
  category: string;
  score: number;
  /** Unidad del examen cuando la publica (porcentaje, segundos…). */
  unit?: string;
}

export interface BenchlmData {
  slug: string;
  name: string;
  dataAsOf?: string;
  overall?: BenchlmScore;
  /** Superficies aparte: `agentic`, `coding`, `knowledge`. */
  categories?: Record<string, BenchlmScore>;
  exams: BenchlmExam[];
  fetchedAt: number;
  /** Motivo en español cuando no hay datos (sin coincidencia, clave rechazada, red…). */
  error?: string;
}

/** Ficha de un modelo: lo que opencode vive + lo que models.dev sabe de él. */
export interface ModelSheet {
  /** Nombre de modelo SIN proveedor: clave de la caché y de la lista izquierda. */
  key: string;
  /** `provider/model` resuelto (primera entrada viva). */
  id: string;
  name: string;
  provider: string;
  free: boolean;
  /** Epoch ms de la toma. */
  fetchedAt: number;
  /** USD por millón de tokens. */
  cost?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
  limit?: { context?: number; output?: number };
  status?: string;
  releaseDate?: string;
  lastUpdated?: string;
  toolCall?: boolean;
  reasoningModel?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  /** Puntuaciones de BenchLM; ausente si no hay clave guardada. */
  benchlm?: BenchlmData;
}

/** Entrada de la lista izquierda: lo justo para elegir y rotular. */
export interface CompareModel {
  key: string;
  id: string;
  name: string;
  provider: string;
  free: boolean;
}

export interface CompareInit {
  models: CompareModel[];
  cache: Record<string, ModelSheet>;
  /** Hay clave de BenchLM guardada: el panel ofrece consultar y muestra la que hay. */
  benchlmKey: boolean;
  /** Alias de BenchLM guardados por clave de modelo (la que se escribe a mano cuando el slug falla). */
  aliases: Record<string, string>;
}

export interface CompareResult {
  sheets: Array<ModelSheet | null>;
  error?: string;
}

/** Resultado de guardar un alias: `alias` es el normalizado que quedó ("" si se borró). */
export interface CompareAliasResult {
  key: string;
  alias: string;
  sheet: ModelSheet;
}

export interface ModelCompareHandlers {
  /** Lista, caché persistida, si hay clave de BenchLM y los alias guardados. */
  getInit(): Promise<CompareInit>;
  /** Resuelve las dos fichas (BenchLM incluido si hay clave) y guarda la caché. */
  onCompare(keys: [string, string]): Promise<CompareResult>;
  /** Guarda (o borra, con alias vacío) el alias de BenchLM del modelo y devuelve su ficha. */
  onAlias(key: string, alias: string): Promise<CompareAliasResult | undefined>;
  /** Pide la clave de BenchLM, la valida y la guarda en el almacén de secretos. */
  onBenchlmKey(): Promise<void>;
  /** Abre BenchLM en el navegador. */
  onOpenBenchlm(): void;
}

/**
 * Ficha pura: fusiona la entrada viva del catálogo con el registro models.dev.
 * Sale de aquí en vez de `extension.ts` para poder probarla sin vscode.
 */
export function buildModelSheet(
  entry: { id: string; provider: string; model: string; name: string; free: boolean; cost?: { input: number; output: number } },
  reg: RegistryModel | undefined,
  key: string
): ModelSheet {
  const sheet: ModelSheet = {
    key,
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    free: entry.free,
    fetchedAt: Date.now(),
  };
  // La tarifa viva manda en entrada/salida; models.dev la completa y aporta el resto.
  const cost: ModelSheet["cost"] = {
    input: entry.cost?.input ?? reg?.cost?.input,
    output: entry.cost?.output ?? reg?.cost?.output,
    reasoning: reg?.cost?.reasoning,
    cacheRead: reg?.cost?.cache_read,
    cacheWrite: reg?.cost?.cache_write,
  };
  if (Object.values(cost).some((value) => value !== undefined)) {
    sheet.cost = cost;
  }
  const limit: ModelSheet["limit"] = { context: reg?.limit?.context, output: reg?.limit?.output };
  if (limit.context !== undefined || limit.output !== undefined) {
    sheet.limit = limit;
  }
  if (reg?.status) sheet.status = reg.status;
  if (reg?.release_date) sheet.releaseDate = reg.release_date;
  if (reg?.last_updated) sheet.lastUpdated = reg.last_updated;
  if (typeof reg?.tool_call === "boolean") sheet.toolCall = reg.tool_call;
  if (typeof reg?.reasoning === "boolean") sheet.reasoningModel = reg.reasoning;
  if (typeof reg?.attachment === "boolean") sheet.attachment = reg.attachment;
  if (reg?.modalities) sheet.modalities = reg.modalities;
  return sheet;
}

/** BenchLM: una ficha ya consultada sirve durante 7 días sin volver a gastar lecturas. */
export const BENCHLM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** La ficha BenchLM cacheada sigue siendo válida (también la que acabó con `error`). */
export function benchlmIsFresh(data: BenchlmData | undefined, now = Date.now()): boolean {
  return !!data && now - data.fetchedAt < BENCHLM_TTL_MS;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Candidatos de slug para un modelo, en orden: el nombre legible primero y el id del modelo
 * después («Claude Sonnet 4.5» → `claude-sonnet-4-5`, `gpt-5.1` → `gpt-5-1`). Sin vacíos y sin
 * duplicados.
 */
export function benchlmSlugs(name: string, model: string): string[] {
  const out: string[] = [];
  for (const value of [name, model]) {
    const slug = slugify(typeof value === "string" ? value : "");
    if (slug && !out.includes(slug)) {
      out.push(slug);
    }
  }
  return out;
}

/** Lo que `rankings/current` dice de un modelo, antes de saber sus exámenes. */
export interface BenchlmComposites {
  slug: string;
  name: string;
  dataAsOf?: string;
  overall?: BenchlmScore;
  categories?: Record<string, BenchlmScore>;
}

/** Composites de `rankings/current`: solo el slug, el nombre, la fecha y las cuatro superficies. */
export function readBenchlmRankings(json: unknown): BenchlmComposites | undefined {
  const root = asRecord(json);
  const model = asRecord(root?.model);
  const slug = asString(model?.slug);
  if (!slug) {
    return undefined;
  }
  const found: BenchlmComposites = { slug, name: asString(model?.name) ?? slug };
  const dataAsOf = asString(root?.dataAsOf);
  if (dataAsOf) {
    found.dataAsOf = dataAsOf;
  }
  const categories: Record<string, { rank: number; score: number }> = {};
  for (const item of Array.isArray(root?.rankings) ? root.rankings : []) {
    const ranking = asRecord(item);
    const surface = asString(ranking?.surface);
    const rank = asNumber(ranking?.rank);
    const score = asNumber(ranking?.score);
    if (!surface || rank === undefined || score === undefined) {
      continue;
    }
    if (surface === "overall") {
      found.overall = { rank, score };
    } else if (surface === "agentic" || surface === "coding" || surface === "knowledge") {
      categories[surface] = { rank, score };
    }
  }
  if (Object.keys(categories).length) {
    found.categories = categories;
  }
  return found;
}

/**
 * Exámenes de `benchmarks/results/current`: el nombre y la unidad salen de `boards[]` casando
 * `boardId`. Se ignora `pagination.nextOffset`: un modelo trae unas doce filas y cada página
 * gasta lecturas.
 */
export function readBenchlmResults(json: unknown): BenchlmExam[] {
  const root = asRecord(json);
  const boards = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(root?.boards) ? root.boards : []) {
    const board = asRecord(item);
    const id = asString(board?.id);
    if (board && id) {
      boards.set(id, board);
    }
  }
  const exams: BenchlmExam[] = [];
  for (const item of Array.isArray(root?.items) ? root.items : []) {
    const result = asRecord(item);
    const boardId = asString(result?.boardId);
    const score = asNumber(result?.score);
    if (!boardId || score === undefined) {
      continue;
    }
    const board = boards.get(boardId);
    const metric = asRecord(board?.metric);
    const exam: BenchlmExam = {
      boardId,
      name: asString(board?.name) ?? asString(board?.benchmarkKey) ?? boardId,
      category: asString(board?.category) ?? "",
      score,
    };
    const unit = asString(metric?.unit);
    if (unit) {
      exam.unit = unit;
    }
    exams.push(exam);
  }
  return exams.sort(
    (a, b) => a.category.localeCompare(b.category, "es") || a.name.localeCompare(b.name, "es")
  );
}

/** Respuesta de una lectura de BenchLM: `json` si vale, `error` en español si no, `notFound` en el 404. */
export interface BenchlmRead {
  json?: unknown;
  error?: string;
  notFound?: boolean;
}

const BENCHLM_BASE = "https://data.benchlm.ai/v1";
const BENCHLM_TIMEOUT_MS = 15_000;

/** Cabeceras de BenchLM. La clave aparece aquí y en ningún otro sitio: ni ficheros, ni webview, ni log. */
function benchlmHeaders(secret: string): Record<string, string> {
  return { Accept: "application/json", Authorization: `Bearer ${secret}` };
}

/** Una lectura GET de BenchLM. Nunca lanza: los fallos salen por `error`, en español. */
export async function benchlmGet(secret: string, path: string): Promise<BenchlmRead> {
  let res: Response;
  try {
    res = await fetch(`${BENCHLM_BASE}${path}`, {
      headers: benchlmHeaders(secret),
      signal: AbortSignal.timeout(BENCHLM_TIMEOUT_MS),
    });
  } catch {
    return { error: "no se pudo consultar BenchLM" };
  }
  // El 404 de `rankings` es un slug que no está, no un fallo: no gasta lectura.
  if (res.status === 404) {
    return { notFound: true };
  }
  if (res.status === 401) {
    return { error: "clave de BenchLM rechazada" };
  }
  if (res.status === 429) {
    return { error: "límite de lecturas de BenchLM" };
  }
  if (!res.ok) {
    return { error: "no se pudo consultar BenchLM" };
  }
  try {
    return { json: await res.json() };
  } catch {
    return { error: "no se pudo consultar BenchLM" };
  }
}

/** Comprueba la clave con `usage`, que no consume lectura. */
export async function checkBenchlmKey(secret: string): Promise<"ok" | "no" | "red"> {
  try {
    const res = await fetch(`${BENCHLM_BASE}/usage`, {
      headers: benchlmHeaders(secret),
      signal: AbortSignal.timeout(BENCHLM_TIMEOUT_MS),
    });
    return res.status === 200 ? "ok" : res.status === 401 ? "no" : "red";
  } catch {
    return "red";
  }
}

/**
 * Puntuaciones de BenchLM del modelo. Reutiliza la ficha cacheada si tiene menos de 7 días (salvo
 * `force`) y prueba los slugs candidatos en orden. Con `alias`, ese es el único candidato: si no
 * existe es «sin coincidencia», sin caer a los automáticos. Nunca lanza: un fallo viaja como
 * `error` en la ficha.
 */
export async function benchlmFor(
  sheet: ModelSheet,
  secret: string,
  alias?: string,
  force = false
): Promise<BenchlmData> {
  const now = Date.now();
  if (!force && benchlmIsFresh(sheet.benchlm, now)) {
    return sheet.benchlm!; // también la que acabó con `error`: 7 días son 7 días
  }
  const failed = (error: string): BenchlmData => ({ slug: "", name: "", exams: [], fetchedAt: now, error });
  for (const slug of alias ? [alias] : benchlmSlugs(sheet.name, sheet.key)) {
    const rankings = await benchlmGet(secret, `/models/${encodeURIComponent(slug)}/rankings/current`);
    if (rankings.notFound) {
      continue;
    }
    if (rankings.error) {
      return failed(rankings.error);
    }
    const model = readBenchlmRankings(rankings.json);
    if (!model) {
      continue;
    }
    const results = await benchlmGet(
      secret,
      `/benchmarks/results/current?modelKey=${encodeURIComponent(model.slug)}&limit=100`
    );
    if (results.error) {
      return failed(results.error);
    }
    return {
      slug: model.slug,
      name: model.name,
      dataAsOf: model.dataAsOf,
      overall: model.overall,
      categories: model.categories,
      exams: results.notFound ? [] : readBenchlmResults(results.json),
      fetchedAt: now,
    };
  }
  return failed("sin coincidencia en BenchLM");
}

/** Longitud máxima de una clave: por encima de esto no hay modelo que valga. */
const MAX_KEY = 300;

/** Acción del mando: comparar dos fichas, fijar el alias de BenchLM, pedir la clave o abrir BenchLM. */
type CompareAction =
  | { type: "compare"; keys: [string, string] }
  | { type: "setAlias"; key: string; alias: string }
  | { type: "benchlmKey" }
  | { type: "openBenchlm" };

/** El webview no es de fiar: solo pasan las acciones del panel, con su forma exacta. */
function parseAction(raw: unknown): CompareAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
  if (action.type === "benchlmKey" || action.type === "openBenchlm") {
    return { type: action.type };
  }
  if (action.type === "setAlias") {
    const key = typeof action.key === "string" ? action.key.trim() : "";
    // Vacío en el alias es válido: significa borrar el que hubiera.
    const alias = typeof action.alias === "string" ? action.alias.trim() : "";
    if (!key || key.length > MAX_KEY || alias.length > MAX_ALIAS) {
      return undefined;
    }
    return { type: "setAlias", key, alias };
  }
  if (action.type !== "compare" || !Array.isArray(action.keys) || action.keys.length !== 2) {
    return undefined;
  }
  const keys = action.keys.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (keys.some((key) => !key || key.length > MAX_KEY)) {
    return undefined;
  }
  return { type: "compare", keys: [keys[0], keys[1]] };
}

export class ModelComparePanel {
  public static current: ModelComparePanel | undefined;
  private static readonly viewType = "opencodeAgents.modelCompare";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: ModelCompareHandlers;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  static open(context: vscode.ExtensionContext, handlers: ModelCompareHandlers): ModelComparePanel {
    if (ModelComparePanel.current) {
      ModelComparePanel.current.handlers = handlers;
      ModelComparePanel.current.panel.reveal(vscode.ViewColumn.Active);
      void ModelComparePanel.current.sendInit();
      return ModelComparePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ModelComparePanel.viewType,
      "Comparar modelos",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // El trabajo es releer catálogo y registro: no merece la pena conservar el webview oculto.
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    ModelComparePanel.current = new ModelComparePanel(panel, context.extensionUri, handlers);
    return ModelComparePanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    handlers: ModelCompareHandlers
  ) {
    this.panel = panel;
    this.handlers = handlers;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: unknown }) => {
        if (message?.type === "ready") {
          this.postTheme();
          void this.sendInit();
          return;
        }
        if (message?.type !== "action") {
          return;
        }
        const action = parseAction(message.action);
        if (!action) {
          return;
        }
        if (action.type === "benchlmKey") {
          void this.guard(() => this.handlers.onBenchlmKey());
          return;
        }
        if (action.type === "openBenchlm") {
          void this.guard(() => this.handlers.onOpenBenchlm());
          return;
        }
        // Serial: dos comparaciones en vuelo pisarían la caché y el `busy`. El `catch` corta la
        // cadena de promesas: sin él, un eslabón rechazado dejaría el panel sin cola para siempre.
        this.queue = this.queue
          .then(() =>
            action.type === "setAlias" ? this.alias(action.key, action.alias) : this.compare(action.keys)
          )
          .catch(() => {});
      },
      null,
      this.disposables
    );
  }

  /** Lista, caché persistida y si hay clave de BenchLM. */
  async sendInit(): Promise<void> {
    try {
      this.post({ type: "init", payload: await this.handlers.getInit() });
    } catch {
      // Sin datos no hay nada que pintar: el próximo `ready` lo vuelve a intentar.
    }
  }

  /** Lo instantáneo (clave, navegador) no pasa por la cola: el fallo se ignora, ya avisa el handler. */
  private async guard(fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // El handler ya escribe su propio mensaje en pantalla.
    }
  }

  private async compare(keys: [string, string]): Promise<void> {
    this.post({ type: "busy", on: true });
    let result: CompareResult;
    try {
      result = await this.handlers.onCompare(keys);
    } catch (err) {
      result = {
        sheets: [null, null],
        error: `No se pudo comparar: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    this.post({ type: "compared", sheets: result.sheets, error: result.error });
    this.post({ type: "busy", on: false });
    // La caché acaba de cambiar: se reenvía para que lista y fichas guardadas queden sincronizadas.
    await this.sendInit();
  }

  /** Guarda el alias y repinta solo esa ficha: la caché puede haber cambiado, pero la lista no. */
  private async alias(key: string, alias: string): Promise<void> {
    let result: CompareAliasResult | undefined;
    try {
      result = await this.handlers.onAlias(key, alias);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo guardar el alias de BenchLM: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    // Modelo que ya no está en el catálogo vivo: no hay ficha que devolver.
    if (!result) {
      return;
    }
    this.post({ type: "aliased", key: result.key, alias: result.alias, sheet: result.sheet });
  }

  private post(message: unknown): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /** Avisa al webview del estilo visual vigente. */
  postTheme(): void {
    this.post({ type: "theme", theme: currentTheme() });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const media = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file)).toString();
    let template: string;
    try {
      template = readFileSync(join(this.extensionUri.fsPath, "media", "modelCompare.html"), "utf8");
    } catch {
      return '<!DOCTYPE html><html lang="es"><body>No se encontró media/modelCompare.html.</body></html>';
    }
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%THEME_LINKS%%", themeLinks(this.extensionUri, webview, []))
      .replaceAll("%%THEME_SCRIPT%%", themeScript(this.extensionUri, webview, nonce))
      .replaceAll("%%STYLE%%", media("modelCompare.css"))
      .replaceAll("%%SCRIPT%%", media("modelCompare.js"));
  }

  /** Suelta el singleton y sus oyentes al cerrarse. */
  private release(): void {
    this.disposed = true;
    if (ModelComparePanel.current === this) {
      ModelComparePanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
