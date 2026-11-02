/**
 * Panel del GENERADOR DE IMÁGENES: ComfyUI (texto a imagen e imagen a imagen) y OpenAI
 * (texto a imagen). Las imágenes se guardan en disco —en el proyecto si hay carpeta— y
 * el panel enseña la última y el historial. La clave de OpenAI vive en `secrets` y nunca
 * viaja al webview.
 *
 * El marcado está en `media/imageGen.html`: aquí solo se rellenan los huecos y se atiende
 * a las acciones del webview, que no es de fiar.
 */
import * as vscode from "vscode";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { catalog, generate as generateComfy, probe } from "../images/comfy";
import { generateImage, OPENAI_MODELS } from "../images/openai";
import {
  checkImageShare,
  clearImageShare,
  pngSize,
  readImageShare,
  readShot,
  savePng,
  shotFile,
  writeImageShare,
} from "../images/share";
import type { ImageShare } from "../images/share";
import { setActivity } from "./activity";
import { currentTheme, themeLinks, themeScript } from "./theme";

const execFileAsync = promisify(execFile);

const KEY_SETTINGS = "opencodeAgents.imageGen";
export const KEY_OPENAI = "opencodeAgents.imageGen.openaiKey";
/** Interruptor de «compartir con los agentes»: el fichero compartido vive en `%APPDATA%\voz`. */
const KEY_SHARE = "opencodeAgents.imageGen.share";
/** Tope del prompt y del negativo. */
const MAX_PROMPT = 4000;
/** Tope de LoRA por generación. */
const MAX_LORAS = 8;
/** Tope de la imagen de partida: más grande no merece el viaje. */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
/** Cuántas imágenes enseña el historial. */
const MAX_HISTORY = 20;
const MIN_SIDE = 64;
const MAX_SIDE = 2048;
const MIN_STEPS = 1;
const MAX_STEPS = 150;
const MIN_CFG = 1;
const MAX_CFG = 30;
/** Pasos y guía que usa ComfyUI cuando el webview no manda otros. */
const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 7;
/** El portapapeles de Windows se prepara con PowerShell; no puede quedarse colgado. */
const CLIPBOARD_TIMEOUT_MS = 15_000;

export type ImageProvider = "comfyui" | "openai";

/** Lo que el panel recuerda de una generación a la siguiente. */
export interface ImagePrefs {
  /** Checkpoint de ComfyUI elegido. */
  model: string;
  /** Id de OpenAI o de un servicio compatible. */
  openaiModel: string;
  /** Lo tecleado, entero 64..2048 (sin redondear a 8). */
  width: number;
  height: number;
  steps: number;
  cfg: number;
  /** Última semilla usada (0..4294967295). */
  seed: number;
  seedRandom: boolean;
}

export interface ImageGenSettings {
  provider: ImageProvider;
  url: string;
  port: number;
  /** Base de OpenAI o de un servicio compatible. */
  openaiUrl: string;
  prefs: ImagePrefs;
}

/** Imagen ya escrita en disco, servida al webview por URI. */
export interface GeneratedImage {
  url: string;
  file: string;
  width: number;
  height: number;
}

export interface ImageGenState {
  provider: ImageProvider;
  url: string;
  port: number;
  connected: boolean;
  status: string;
  models: string[];
  loras: string[];
  hasKey: boolean;
  /** Base del servicio compatible; el webview la enseña y la puede cambiar. */
  openaiUrl: string;
  prefs: ImagePrefs;
  source: { url: string; name: string } | null;
  current: GeneratedImage | null;
  history: GeneratedImage[];
  busy: boolean;
  progress: string;
  message: string;
  /** El generador está compartido con los agentes por el MCP. */
  share: boolean;
}

export type ImageGenAction =
  | { type: "setProvider"; provider: ImageProvider }
  | { type: "setServer"; url: string; port: number }
  | { type: "connect" }
  | { type: "setKey"; key: string }
  | { type: "refresh" }
  | { type: "pickSource" }
  | { type: "clearSource" }
  | {
      type: "generate";
      prompt: string;
      negative: string;
      model: string;
      /** Lados ya saneados: múltiplos de 8 y dentro de 64..2048. */
      width: number;
      height: number;
      /** Lo que pidió el webview, para avisar si hubo recorte. */
      requested: { width: number; height: number };
      loras: Array<{ name: string; weight: number }>;
      denoise: number;
      /** Semilla del KSampler ya saneada; si no llegaba una válida, se sorteó. */
      seed: number;
      /** Pasos y guía del KSampler, ya saneados (20 y 7 si no llegan). */
      steps: number;
      cfg: number;
    }
  | { type: "saveAs"; file: string }
  | { type: "copy"; file: string }
  | { type: "deleteImage"; file: string }
  | { type: "clearHistory" }
  | { type: "refreshHistory" }
  | { type: "setOpenAIURL"; url: string }
  | { type: "setPrefs"; prefs: ImagePrefs }
  | { type: "reloadModels" }
  | { type: "setShare"; on: boolean; model: string }
  | { type: "openFolder" };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "setProvider",
  "setServer",
  "connect",
  "setKey",
  "refresh",
  "pickSource",
  "clearSource",
  "generate",
  "saveAs",
  "copy",
  "deleteImage",
  "clearHistory",
  "refreshHistory",
  "setOpenAIURL",
  "setPrefs",
  "reloadModels",
  "setShare",
  "openFolder",
]);

const DEFAULT_PREFS: ImagePrefs = {
  model: "",
  openaiModel: "gpt-image-1",
  width: 512,
  height: 512,
  steps: DEFAULT_STEPS,
  cfg: DEFAULT_CFG,
  seed: 0,
  seedRandom: true,
};

const DEFAULT_SETTINGS: ImageGenSettings = {
  provider: "comfyui",
  url: "http://localhost",
  port: 8188,
  openaiUrl: "https://api.openai.com",
  prefs: DEFAULT_PREFS,
};
/** Semilla de 32 bits sin signo. */
const MAX_SEED = 4294967295;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Lado de la imagen: entero, múltiplo de 8 y dentro del rango admitido. */
function sanitizeSide(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 512;
  return clamp(Math.round(Math.round(value) / 8) * 8, MIN_SIDE, MAX_SIDE);
}

/** Semilla del muestreador: entero de 32 bits; si no llega una válida, se sortea. */
function sanitizeSeed(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : NaN;
  return Number.isFinite(value) ? clamp(value, 0, MAX_SEED) : Math.floor(Math.random() * 2 ** 32);
}

/** Lado recordado: entero de 64..2048, tal cual se tecleó (sin llevar a múltiplos de 8). */
function prefSide(raw: unknown, fallback: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
  return clamp(value, MIN_SIDE, MAX_SIDE);
}

/** Pasos del KSampler: entero de 1..150; sin número válido, los de ComfyUI. */
function sanitizeSteps(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_STEPS;
  return clamp(value, MIN_STEPS, MAX_STEPS);
}

/** Guía del KSampler con un decimal (7.25 se guarda como 7.3); sin número válido, 7. */
function sanitizeCfg(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_CFG;
  return clamp(Math.round(value * 10) / 10, MIN_CFG, MAX_CFG);
}

/** Semilla recordada: entero de 32 bits; sin número válido, 0 (aquí no se sortea). */
function savedSeed(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return clamp(value, 0, MAX_SEED);
}

/** Nombre de modelo: texto no vacío y dentro del tope; si no, el defecto. */
function prefModel(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text && text.length <= 200 ? text : fallback;
}

/** Preferencias del panel: cada campo con su rango y lo que no valga vuelve al defecto. */
function sanitizePrefs(raw: unknown): ImagePrefs {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    model: prefModel(data.model, DEFAULT_PREFS.model),
    openaiModel: prefModel(data.openaiModel, DEFAULT_PREFS.openaiModel),
    width: prefSide(data.width, DEFAULT_PREFS.width),
    height: prefSide(data.height, DEFAULT_PREFS.height),
    steps: sanitizeSteps(data.steps),
    cfg: sanitizeCfg(data.cfg),
    seed: savedSeed(data.seed),
    seedRandom: data.seedRandom !== false,
  };
}

/** Rutas iguales; en Windows la unidad puede venir con otra caja. */
function samePath(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Base de un servicio HTTP: sin barras finales, salvo que sea «http://» a secas. */
function cleanBaseUrl(raw: unknown): string {
  const typed = typeof raw === "string" ? raw.trim() : "";
  const url = typed.endsWith("://") ? typed : typed.replace(/\/+$/, "");
  return /^https?:\/\//.test(url) && url.length <= 200 ? url : "";
}

/** El webview no es de fiar: nada llega al cliente sin pasar por aquí. */
function parseAction(raw: unknown): ImageGenAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
  if (typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  switch (action.type) {
    case "connect":
    case "refresh":
    case "reloadModels":
    case "pickSource":
    case "clearSource":
    case "clearHistory":
    case "refreshHistory":
    case "openFolder":
      return { type: action.type };
    case "setProvider":
      return action.provider === "comfyui" || action.provider === "openai"
        ? { type: "setProvider", provider: action.provider }
        : undefined;
    case "setServer": {
      const url = cleanBaseUrl(action.url);
      const port = typeof action.port === "number" ? Math.round(action.port) : NaN;
      return url && port >= 1 && port <= 65535 ? { type: "setServer", url, port } : undefined;
    }
    case "setOpenAIURL": {
      const url = cleanBaseUrl(action.url);
      return url ? { type: "setOpenAIURL", url } : undefined;
    }
    case "setPrefs":
      return { type: "setPrefs", prefs: sanitizePrefs(action.prefs) };
    case "setShare": {
      if (typeof action.on !== "boolean") {
        return undefined;
      }
      const model = typeof action.model === "string" ? action.model.trim() : "";
      return model.length <= 200 ? { type: "setShare", on: action.on, model } : undefined;
    }
    case "setKey": {
      const key = typeof action.key === "string" ? action.key.trim() : "";
      return key && key.length <= 400 ? { type: "setKey", key } : undefined;
    }
    case "generate": {
      const prompt = typeof action.prompt === "string" ? action.prompt.trim() : "";
      if (!prompt || prompt.length > MAX_PROMPT) {
        return undefined;
      }
      const negative =
        typeof action.negative === "string" ? action.negative.trim().slice(0, MAX_PROMPT) : "";
      const model = typeof action.model === "string" ? action.model.trim() : "";
      if (!model || model.length > 200) {
        return undefined;
      }
      const loras: Array<{ name: string; weight: number }> = [];
      if (Array.isArray(action.loras)) {
        for (const raw of (action.loras as unknown[]).slice(0, MAX_LORAS)) {
          const item = raw as { name?: unknown; weight?: unknown } | undefined;
          const name = typeof item?.name === "string" ? item.name.trim() : "";
          if (!name || name.length > 200) {
            continue;
          }
          const weight =
            typeof item?.weight === "number" && Number.isFinite(item.weight)
              ? clamp(item.weight, 0, 2)
              : 1;
          loras.push({ name, weight });
        }
      }
      const denoise =
        typeof action.denoise === "number" && Number.isFinite(action.denoise) ? action.denoise : 0.6;
      return {
        type: "generate",
        prompt,
        negative,
        model,
        width: sanitizeSide(action.width),
        height: sanitizeSide(action.height),
        requested: {
          width: typeof action.width === "number" && Number.isFinite(action.width) ? Math.round(action.width) : 512,
          height: typeof action.height === "number" && Number.isFinite(action.height) ? Math.round(action.height) : 512,
        },
        loras,
        denoise: clamp(denoise, 0.1, 1),
        seed: sanitizeSeed(action.seed),
        steps: sanitizeSteps(action.steps),
        cfg: sanitizeCfg(action.cfg),
      };
    }
    case "saveAs":
    case "copy":
    case "deleteImage": {
      const file = typeof action.file === "string" ? action.file : "";
      return file ? { type: action.type, file } : undefined;
    }
  }
  return undefined;
}

/** Ajustes recordados entre sesiones; lo que no valga vuelve al defecto. */
export function readSettings(context: vscode.ExtensionContext): ImageGenSettings {
  const raw = context.globalState.get<Partial<ImageGenSettings>>(KEY_SETTINGS);
  const provider = raw?.provider === "openai" ? "openai" : "comfyui";
  const url =
    typeof raw?.url === "string" && /^https?:\/\//.test(raw.url)
      ? raw.url
      : DEFAULT_SETTINGS.url;
  const port =
    typeof raw?.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535
      ? raw.port
      : DEFAULT_SETTINGS.port;
  const openaiUrl =
    typeof raw?.openaiUrl === "string" && /^https?:\/\//.test(raw.openaiUrl) && raw.openaiUrl.length <= 200
      ? raw.openaiUrl
      : DEFAULT_SETTINGS.openaiUrl;
  const prefs = sanitizePrefs(raw?.prefs);
  // Sin modelo guardado vale el que ya usa el fichero compartido: así no se pierde el actual.
  // Solo si el compartido es de ComfyUI: con OpenAI ese `model` es un id del servicio.
  const shared = readImageShare();
  if (!prefs.model && shared?.provider === "comfyui") {
    prefs.model = shared.model;
  }
  return { provider, url, port, openaiUrl, prefs };
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

/** Oyentes del interruptor de compartir: Control se repinta sin esperar al sondeo. */
const shareListeners = new Set<(on: boolean) => void>();

function emitShare(on: boolean): void {
  for (const listener of shareListeners) {
    listener(on);
  }
}

/** ¿Está compartido el generador? Solo dice el flag: que siga vivo lo resuelve `refreshImageShare`. */
export function isImageShareEnabled(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(KEY_SHARE, false);
}

export function onImageShareChange(listener: (on: boolean) => void): vscode.Disposable {
  shareListeners.add(listener);
  return new vscode.Disposable(() => shareListeners.delete(listener));
}

/**
 * Ajustes actuales, con la clave de `secrets` y el modelo del fichero si no llega uno: es
 * lo que ven el MCP y el panel al encender o al revalidar. La clave solo viaja con OpenAI.
 */
async function shareNow(context: vscode.ExtensionContext, model?: string): Promise<ImageShare> {
  const settings = readSettings(context);
  const key = await context.secrets.get(KEY_OPENAI);
  const disk = readImageShare();
  return {
    enabled: true,
    provider: settings.provider,
    url: settings.url,
    port: settings.port,
    openaiUrl: settings.openaiUrl,
    openaiKey: settings.provider === "openai" ? key ?? undefined : undefined,
    model: (model ?? "").trim() || disk?.model || "",
    imagenesDir: imagenesDir(context),
    updatedAt: Date.now(),
  };
}

/** Alta o baja del compartir; si el chequeo falla no se comparte nada. */
export async function setImageShare(
  context: vscode.ExtensionContext,
  on: boolean,
  model?: string
): Promise<{ on: boolean; detail: string }> {
  if (!on) {
    await context.globalState.update(KEY_SHARE, false);
    await clearImageShare();
    emitShare(false);
    return { on: false, detail: "Compartir apagado." };
  }
  const share = await shareNow(context, model);
  const status = await checkImageShare(share);
  if (!status.ok) {
    await context.globalState.update(KEY_SHARE, false);
    await clearImageShare();
    emitShare(false);
    return { on: false, detail: status.detail };
  }
  await writeImageShare(share);
  await context.globalState.update(KEY_SHARE, true);
  emitShare(true);
  return { on: true, detail: status.detail };
}

/**
 * Revalida lo compartido con los ajustes de ahora (el sondeo de 5 s y cada cambio del
 * panel). Apagado no escribe nada; encendido y roto se apaga y deja el motivo.
 */
export async function refreshImageShare(
  context: vscode.ExtensionContext
): Promise<{ on: boolean; detail: string }> {
  if (!isImageShareEnabled(context)) {
    return { on: false, detail: "" };
  }
  const share = await shareNow(context);
  const status = await checkImageShare(share);
  if (!status.ok) {
    await context.globalState.update(KEY_SHARE, false);
    await clearImageShare();
    emitShare(false);
    return { on: false, detail: status.detail };
  }
  await writeImageShare(share);
  return { on: true, detail: status.detail };
}

export class ImageGenPanel {
  public static current: ImageGenPanel | undefined;
  private static readonly viewType = "opencodeAgents.imageGen";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];
  private last?: ImageGenState;
  private settings: ImageGenSettings;
  private models: string[] = [];
  private loras: string[] = [];
  private comfyVersion = "";
  private connected = false;
  private busy = false;
  /** Hay una generación en cola o en marcha: un segundo clic no encola otra. */
  private pendingGenerate = false;
  private progress = "";
  private message = "";
  private source?: { bytes: Buffer; name: string; url: string };
  private currentFile = "";
  /** Último disparo del MCP ya aplicado: el vigilante no repite prompts. */
  private lastShotId = "";
  /** Prompts del agente que esperan a que el webview avise de que está listo. */
  private pendingShot?: { prompt: string; negative: string };
  /** Las acciones van de una en una: dos generaciones a la vez no caben. */
  private queue: Promise<void> = Promise.resolve();

  static async open(context: vscode.ExtensionContext): Promise<ImageGenPanel> {
    if (ImageGenPanel.current) {
      ImageGenPanel.current.panel.reveal(vscode.ViewColumn.Active);
      await ImageGenPanel.current.update();
      return ImageGenPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ImageGenPanel.viewType,
      "Generador de imágenes IA",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
          vscode.Uri.file(imagenesDir(context)),
        ],
      }
    );
    const created = new ImageGenPanel(panel, context);
    ImageGenPanel.current = created;
    await created.update();
    return created;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.settings = readSettings(context);
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: unknown }) => {
        if (message?.type === "ready") {
          this.postTheme();
          if (this.last) {
            this.post({ type: "state", state: this.last });
          }
          // Los prompts del agente pueden haber llegado con el webview aún sin cargar.
          if (this.pendingShot) {
            this.post({ type: "agentShot", ...this.pendingShot });
          }
          return;
        }
        const action = parseAction(message?.action);
        if (!action) {
          return;
        }
        // Un segundo clic en GENERAR mientras hay una en curso o en cola no hace nada.
        if (action.type === "generate") {
          if (this.pendingGenerate || this.busy) {
            return;
          }
          this.pendingGenerate = true;
        }
        // Solo lo que ocupa minutos espera turno. Copiar, guardar o cambiar de servidor
        // tiene que responder aunque haya una imagen a medio hacer.
        if (
          action.type === "generate" ||
          action.type === "connect" ||
          action.type === "refresh" ||
          action.type === "reloadModels"
        ) {
          this.queue = this.queue.then(() => this.handle(action));
        } else {
          void this.handle(action);
        }
      },
      null,
      this.disposables
    );

    // El MCP corre en otro proceso: publica cada imagen y aquí se reflejan los prompts.
    watchFile(shotFile(), { interval: 1000 }, () => void this.applyShot());
    void this.applyLastShot();

    // PNG añadidos o borrados desde fuera (el Explorador, el MCP u otra aplicación): se
    // relee el historial sin esperar a que el usuario pulse nada. `watchFile` sobre un
    // directorio sondea su mtime; el renombrado atómico de Windows no siempre avisa con
    // `fs.watch`. Si la carpeta aún no existe no falla: empieza a avisar cuando se cree.
    watchFile(this.dir(), { interval: 1500 }, () => void this.update());

    // Al abrir la pestaña se prueba ComfyUI sin pulsar CONECTAR; el catálogo llega con el
    // estado. Con OpenAI `syncComfy` sale sin sondear nada.
    void this.syncComfy().then(() => this.update());
  }

  /** Disparo del MCP: si la imagen está en la carpeta, pasa a ser la actual y se pintan los prompts. */
  private async applyShot(): Promise<void> {
    const shot = readShot();
    if (!shot || shot.id === this.lastShotId) {
      return;
    }
    this.lastShotId = shot.id;
    try {
      this.currentFile = await this.insideImages(shot.file);
    } catch {
      // Un evento que no apunta a la carpeta de imágenes no se aplica.
      return;
    }
    this.pendingShot = { prompt: shot.prompt, negative: shot.negative };
    this.post({ type: "agentShot", prompt: shot.prompt, negative: shot.negative });
    await this.update();
  }

  /**
   * Al abrir: el último disparo solo cuenta si su PNG es la imagen más reciente. Si después
   * hubo una generación manual, los prompts del agente ya no son los de esa imagen.
   */
  private async applyLastShot(): Promise<void> {
    const shot = readShot();
    if (!shot) {
      return;
    }
    const history = await this.readHistory();
    if (!history.length || !samePath(history[0].file, shot.file)) {
      return;
    }
    this.lastShotId = shot.id;
    this.currentFile = history[0].file;
    this.pendingShot = { prompt: shot.prompt, negative: shot.negative };
    // Puede que el webview ya esté listo y no vuelva a pedir nada: se manda también aquí.
    this.post({ type: "agentShot", prompt: shot.prompt, negative: shot.negative });
    await this.update();
  }

  /** Repinta el estado: lo llaman el sondeo y el vigilante de la extensión. */
  public notifyChanged(): void {
    void this.update();
  }

  /** Carpeta de imágenes: en el proyecto si hay, si no en el almacén global. */
  private dir(): string {
    return imagenesDir(this.context);
  }

  private async handle(action: ImageGenAction): Promise<void> {
    // Cambiar una preferencia no se lleva por delante el aviso de la acción anterior.
    if (action.type !== "setPrefs") {
      this.message = "";
    }
    try {
      await this.dispatch(action);
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    } finally {
      // El progreso lo lleva la generación: una acción corta no lo puede borrar por debajo.
      await this.update().catch(() => undefined);
    }
  }

  private async dispatch(action: ImageGenAction): Promise<void> {
    switch (action.type) {
      case "setProvider":
        this.settings.provider = action.provider;
        await this.context.globalState.update(KEY_SETTINGS, this.settings);
        await this.syncComfy();
        if (action.provider === "openai" && !(await this.context.secrets.get(KEY_OPENAI))) {
          this.message = "Falta la clave de OpenAI: guárdala para generar.";
        }
        // Al final: si el cambio deja de compartir, ese aviso manda sobre el de la clave.
        await this.refreshShared();
        return;
      case "setServer":
        this.settings.url = action.url;
        this.settings.port = action.port;
        await this.context.globalState.update(KEY_SETTINGS, this.settings);
        await this.syncComfy();
        await this.refreshShared();
        return;
      case "setOpenAIURL":
        this.settings.openaiUrl = action.url;
        await this.context.globalState.update(KEY_SETTINGS, this.settings);
        await this.refreshShared();
        return;
      case "setPrefs":
        this.settings.prefs = action.prefs;
        await this.context.globalState.update(KEY_SETTINGS, this.settings);
        // Compartido, el MCP generará con el modelo elegido aquí (el del proveedor activo).
        if (isImageShareEnabled(this.context)) {
          const model =
            this.settings.provider === "comfyui" ? action.prefs.model : action.prefs.openaiModel;
          if (model) {
            await writeImageShare({ model });
          }
        }
        return;
      case "connect":
      case "reloadModels":
        await this.syncComfy();
        return;
      case "setKey":
        // La clave se queda en `secrets`: al webview solo vuelve `hasKey`.
        await this.context.secrets.store(KEY_OPENAI, action.key);
        this.message = "Clave de OpenAI guardada.";
        await this.refreshShared();
        return;
      case "refresh":
        await this.syncComfy();
        return;
      case "setShare": {
        const result = await setImageShare(this.context, action.on, action.model);
        this.message = !action.on
          ? result.detail
          : result.on
            ? `Compartido con los agentes: ${result.detail}`
            : `No se pudo compartir: ${result.detail}`;
        return;
      }
      case "pickSource":
        await this.pickSource();
        return;
      case "clearSource":
        this.source = undefined;
        return;
      case "generate":
        await this.generate(action);
        return;
      case "saveAs":
        await this.saveAs(action.file);
        return;
      case "copy":
        await this.copy(action.file);
        return;
      case "deleteImage":
        await this.deleteImage(action.file);
        return;
      case "clearHistory":
        await this.clearHistory();
        return;
      case "refreshHistory":
        // El `finally` de `handle` ya llama a `update()`: basta con releer la carpeta.
        // `buildState` conserva `currentFile` si sigue en el historial.
        this.message = "Historial recargado.";
        return;
      case "openFolder":
        await this.openFolder();
        return;
    }
  }

  /** Tras tocar un ajuste, revalida lo compartido: si dejó de responder, se apaga y se avisa. */
  private async refreshShared(): Promise<void> {
    if (!isImageShareEnabled(this.context)) {
      return;
    }
    const result = await refreshImageShare(this.context);
    if (!result.on) {
      this.message = "Se dejó de compartir: " + result.detail;
    }
  }

  /** Sondea el servidor y recarga el catálogo. Con OpenAI no hay nada que sondear. */
  private async syncComfy(): Promise<void> {
    if (this.settings.provider !== "comfyui") {
      return;
    }
    this.connected = false;
    this.comfyVersion = "";
    this.models = [];
    this.loras = [];
    try {
      this.comfyVersion = await probe({ url: this.settings.url, port: this.settings.port });
      this.connected = true;
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
      return;
    }
    try {
      const data = await catalog({ url: this.settings.url, port: this.settings.port });
      this.models = data.models;
      this.loras = data.loras;
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    }
  }

  private async pickSource(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Usar como imagen de partida",
      filters: { Imágenes: ["png", "jpg", "jpeg", "webp"] },
    });
    const uri = picked?.[0];
    if (!uri) {
      return;
    }
    const info = await stat(uri.fsPath);
    if (info.size > MAX_SOURCE_BYTES) {
      throw new Error("La imagen de partida pasa de 12 MB.");
    }
    const bytes = await readFile(uri.fsPath);
    this.source = {
      bytes,
      name: basename(uri.fsPath),
      url: `data:${mimeOf(uri.fsPath)};base64,${bytes.toString("base64")}`,
    };
  }

  private async generate(action: Extract<ImageGenAction, { type: "generate" }>): Promise<void> {
    if (this.busy) {
      // No debería pasar (el segundo clic se descarta al encolar), pero el flag no se
      // puede quedar encendido para siempre.
      this.pendingGenerate = false;
      return;
    }
    this.busy = true;
    setActivity("imagen-panel", true, "GENERANDO IMAGEN", "imagen");
    // Lo usado queda recordado: la sesión siguiente abre con el mismo tamaño y ajustes.
    const prefs = this.settings.prefs;
    prefs.width = prefSide(action.requested.width, DEFAULT_PREFS.width);
    prefs.height = prefSide(action.requested.height, DEFAULT_PREFS.height);
    prefs.steps = action.steps;
    prefs.cfg = action.cfg;
    prefs.seed = action.seed;
    if (this.settings.provider === "comfyui") {
      prefs.model = action.model;
    } else {
      prefs.openaiModel = action.model;
    }
    await this.context.globalState.update(KEY_SETTINGS, this.settings);
    try {
      let bytes: Buffer;
      let note = "";
      if (this.settings.provider === "comfyui") {
        this.postProgress("Conectando…");
        // La imagen de partida solo cuenta en ComfyUI; en OpenAI se ignora.
        bytes = await generateComfy({
          url: this.settings.url,
          port: this.settings.port,
          prompt: action.prompt,
          negative: action.negative,
          model: action.model,
          width: action.width,
          height: action.height,
          loras: action.loras,
          seed: action.seed,
          steps: action.steps,
          cfg: action.cfg,
          source: this.source?.bytes,
          denoise: action.denoise,
          onProgress: (text) => this.postProgress(text),
        });
      } else {
        const key = await this.context.secrets.get(KEY_OPENAI);
        if (!key) {
          throw new Error("Falta la clave de OpenAI. Guárdala en el panel para generar.");
        }
        this.postProgress("Generando…");
        const result = await generateImage({
          key,
          model: action.model,
          prompt: action.prompt,
          width: action.width,
          height: action.height,
          baseUrl: this.settings.openaiUrl,
        });
        bytes = result.bytes;
        note = result.message;
      }
      const file = await this.saveBytes(bytes);
      this.currentFile = file;
      // Una generación manual manda sobre los prompts que dejó el agente.
      this.pendingShot = undefined;
      this.message = note || "Imagen generada.";
      // Solo se avisa del recorte por el tope: redondear a múltiplos de 8 es lo normal.
      if (action.requested.width > MAX_SIDE || action.requested.height > MAX_SIDE) {
        this.message =
          `Imagen generada a ${action.width}×${action.height}. ` +
          `El tamaño pedido (${action.requested.width}×${action.requested.height}) se recortó al máximo de ${MAX_SIDE} por lado.`;
      }
      // El MCP usará el modelo que acaba de funcionar aquí si no le piden otro.
      if (isImageShareEnabled(this.context)) {
        await writeImageShare({ model: action.model });
      }
    } finally {
      setActivity("imagen-panel", false, "GENERANDO IMAGEN", "imagen");
      this.busy = false;
      this.pendingGenerate = false;
      this.postProgress("");
    }
  }

  /**
   * Aviso ligero de fase: el estado completo lleva la imagen de partida en data URL y no
   * se puede reenviar en cada paso de la generación.
   */
  private postProgress(text: string): void {
    this.progress = text;
    this.post({ type: "progress", busy: this.busy, progress: text });
  }

  /** Escribe el PNG con nombre único en la carpeta de imágenes (tmp + rename). */
  private async saveBytes(bytes: Buffer): Promise<string> {
    return savePng(this.dir(), bytes);
  }

  private async saveAs(file: string): Promise<void> {
    const source = await this.insideImages(file);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(source),
      filters: { "Imagen PNG": ["png"] },
      saveLabel: "Guardar",
    });
    if (!target) {
      return;
    }
    await copyFile(source, target.fsPath);
    this.message = `Imagen guardada en ${target.fsPath}`;
  }

  private async copy(file: string): Promise<void> {
    const source = await this.insideImages(file);
    // `-STA` lo exige `Clipboard::SetImage`; `-NonInteractive`, que nada pregunte en consola.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      `$img = [System.Drawing.Image]::FromFile('${source.replace(/'/g, "''")}')`,
      "try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }",
    ].join("; ");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, timeout: CLIPBOARD_TIMEOUT_MS }
    );
    this.message = "Imagen copiada al portapapeles.";
  }

  private async openFolder(): Promise<void> {
    const dir = this.dir();
    await mkdir(dir, { recursive: true });
    await vscode.env.openExternal(vscode.Uri.file(dir));
  }

  /** Borra un PNG del historial; si era el actual, `current` pasa a la más reciente. */
  private async deleteImage(file: string): Promise<void> {
    const target = await this.insideImages(file);
    await unlink(target);
    if (samePath(target, this.currentFile)) {
      // Sin `currentFile`, el estado cae a la imagen más reciente que quede (o a ninguna).
      this.currentFile = "";
    }
    this.message = "Imagen borrada.";
  }

  /** Borra todo el historial tras confirmarlo: no hay deshacer. */
  private async clearHistory(): Promise<void> {
    const names = await this.pngNames();
    if (!names.length) {
      this.message = "El historial ya está vacío.";
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `Se van a borrar ${names.length} imágenes del historial. No se puede deshacer.`,
      { modal: true },
      "Borrar"
    );
    if (pick !== "Borrar") {
      return;
    }
    let failed = 0;
    for (const name of names) {
      try {
        await unlink(await this.insideImages(join(this.dir(), name)));
      } catch {
        // Una imagen que no pasa el filtro o que está en uso se queda; sigue el resto.
        failed++;
      }
    }
    this.currentFile = "";
    this.message = failed
      ? `Historial borrado, pero ${failed} imágenes no se pudieron borrar.`
      : "Historial borrado.";
  }

  /** Nombres de los PNG de la carpeta de imágenes. */
  private async pngNames(): Promise<string[]> {
    try {
      return (await readdir(this.dir())).filter((name) => name.toLowerCase().endsWith(".png"));
    } catch {
      return [];
    }
  }

  /**
   * Solo se leen, copian o borran PNG que estén de verdad dentro de la carpeta de imágenes:
   * se resuelven los enlaces y se exige una ruta relativa sin `..`. En Windows la
   * comparación va sin caja (la unidad puede venir con otra); en el resto, con caja.
   */
  private async insideImages(file: string): Promise<string> {
    let root: string;
    let target: string;
    try {
      root = await realpath(this.dir());
      target = await realpath(file);
    } catch {
      throw new Error("Esa imagen no está en la carpeta de imágenes.");
    }
    const win = process.platform === "win32";
    const inside = relative(win ? root.toLowerCase() : root, win ? target.toLowerCase() : target);
    if (inside === "" || isAbsolute(inside) || inside.split(sep).includes("..")) {
      throw new Error("Esa imagen no está en la carpeta de imágenes.");
    }
    if (!target.toLowerCase().endsWith(".png")) {
      throw new Error("Solo se pueden copiar, guardar o borrar imágenes PNG.");
    }
    return target;
  }

  /** Imágenes de la carpeta, de la más reciente a la más vieja. */
  private async readHistory(): Promise<Array<{ file: string; width: number; height: number }>> {
    const dir = this.dir();
    const names = await this.pngNames();
    // Primero se ordena por fecha con `stat` (barato); la cabecera solo se abre de las 20
    // que quedan, y de una en una, para no agotar descriptores en carpetas grandes.
    const scanned = await Promise.all(
      names.map(async (name) => {
        const file = join(dir, name);
        try {
          const info = await stat(file);
          return info.isFile() ? { file, mtime: info.mtimeMs } : undefined;
        } catch {
          // Un fichero que se borró entre el listado y el `stat` se queda fuera.
          return undefined;
        }
      })
    );
    const recent = scanned
      .filter((entry): entry is { file: string; mtime: number } => Boolean(entry))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_HISTORY);

    const history: Array<{ file: string; width: number; height: number }> = [];
    for (const entry of recent) {
      try {
        const size = await pngSize(entry.file);
        history.push({ file: entry.file, width: size.width, height: size.height });
      } catch {
        // Igual que arriba: si desaparece entre el `stat` y la cabecera, no entra.
      }
    }
    return history;
  }

  private toState(entry: { file: string; width: number; height: number }): GeneratedImage {
    return {
      url: this.panel.webview.asWebviewUri(vscode.Uri.file(entry.file)).toString(),
      file: entry.file,
      width: entry.width,
      height: entry.height,
    };
  }

  private async buildState(): Promise<ImageGenState> {
    const hasKey = Boolean(await this.context.secrets.get(KEY_OPENAI));
    const history = await this.readHistory();
    if (!history.some((entry) => entry.file === this.currentFile)) {
      this.currentFile = history[0]?.file ?? "";
    }
    const current = history.find((entry) => entry.file === this.currentFile);
    const comfy = this.settings.provider === "comfyui";
    let status = "Falta la clave de OpenAI";
    if (comfy) {
      status = this.connected ? `Conectado a ComfyUI ${this.comfyVersion}` : "Sin conexión";
    } else if (hasKey) {
      status = "OpenAI listo";
    }
    return {
      provider: this.settings.provider,
      url: this.settings.url,
      port: this.settings.port,
      connected: comfy ? this.connected : hasKey,
      status,
      models: comfy ? this.models : Object.keys(OPENAI_MODELS),
      loras: comfy ? this.loras : [],
      hasKey,
      openaiUrl: this.settings.openaiUrl,
      prefs: { ...this.settings.prefs },
      source: this.source ? { url: this.source.url, name: this.source.name } : null,
      current: current ? this.toState(current) : null,
      history: history.map((entry) => this.toState(entry)),
      busy: this.busy,
      progress: this.progress,
      message: this.message,
      share: isImageShareEnabled(this.context),
    };
  }

  private async update(): Promise<void> {
    const state = await this.buildState();
    this.last = state;
    this.post({ type: "state", state });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /** Avisa al webview del estilo visual vigente. */
  postTheme(): void {
    void this.panel.webview.postMessage({ type: "theme", theme: currentTheme() });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uriIn = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();

    // El marcado vive en media/imageGen.html: la extensión solo rellena los huecos. Su CSP
    // necesita `img-src %%CSP%% data:` para el preview, el historial y la imagen de partida.
    const template = readFileSync(
      join(this.context.extensionUri.fsPath, "media", "imageGen.html"),
      "utf8"
    );
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%THEME_LINKS%%", themeLinks(this.context.extensionUri, webview, []))
      .replaceAll("%%THEME_SCRIPT%%", themeScript(this.context.extensionUri, webview, nonce))
      .replaceAll("%%STYLE%%", uriIn("imageGen.css"))
      .replaceAll("%%SCRIPT%%", uriIn("imageGen.js"));
  }

  /** Suelta el singleton al cerrarse, sin volver a disponer el panel. */
  private release(): void {
    unwatchFile(shotFile());
    unwatchFile(this.dir());
    if (ImageGenPanel.current === this) {
      ImageGenPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/** Carpeta de imágenes generadas: en el proyecto si hay carpeta abierta, si no en el almacén global. */
export function imagenesDir(context: vscode.ExtensionContext): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? join(root, ".alfred", "imagenes") : join(context.globalStorageUri.fsPath, "imagenes");
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
