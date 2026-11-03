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
 * host → webview
 *   {type:"theme", theme}
 *   {type:"init", payload:{models:[{key,id,name,provider,free}], cache:Record<clave,ficha>}}
 *   {type:"busy", on}
 *   {type:"compared", sheets:[ficha|null], error?}   sheets[0] = primera key, sheets[1] = segunda
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistryModel } from "../agents/config";
import { currentTheme, themeLinks, themeScript } from "./theme";

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
}

export interface CompareResult {
  sheets: Array<ModelSheet | null>;
  error?: string;
}

export interface ModelCompareHandlers {
  /** Lista y caché persistida, tal como hay que pintarlas. */
  getInit(): CompareInit;
  /** Resuelve las dos fichas y guarda la caché. */
  onCompare(keys: [string, string]): Promise<CompareResult>;
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

/** Longitud máxima de una clave: por encima de esto no hay modelo que valga. */
const MAX_KEY = 300;

/** El webview no es de fiar: solo pasa la acción compare con sus dos claves. */
function parseAction(raw: unknown): { type: "compare"; keys: [string, string] } | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
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
      ModelComparePanel.current.sendInit();
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
          this.sendInit();
          return;
        }
        if (message?.type !== "action") {
          return;
        }
        const action = parseAction(message.action);
        if (!action) {
          return;
        }
        // Serial: dos comparaciones en vuelo pisarían la caché y el `busy`. El `catch` corta la
        // cadena de promesas: sin él, un eslabón rechazado dejaría el panel sin cola para siempre.
        this.queue = this.queue.then(() => this.compare(action.keys)).catch(() => {});
      },
      null,
      this.disposables
    );
  }

  /** Lista y caché vigentes. */
  sendInit(): void {
    this.post({ type: "init", payload: this.handlers.getInit() });
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
    this.sendInit();
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
