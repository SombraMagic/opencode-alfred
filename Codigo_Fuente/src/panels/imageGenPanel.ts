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
import { readFileSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { catalog, generate as generateComfy, probe } from "../images/comfy";
import { generateImage, OPENAI_MODELS } from "../images/openai";
import { writeAtomic } from "../pizarra/files";

const execFileAsync = promisify(execFile);

const KEY_SETTINGS = "opencodeAgents.imageGen";
const KEY_OPENAI = "opencodeAgents.imageGen.openaiKey";
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
/** El portapapeles de Windows se prepara con PowerShell; no puede quedarse colgado. */
const CLIPBOARD_TIMEOUT_MS = 15_000;

export type ImageProvider = "comfyui" | "openai";

export interface ImageGenSettings {
  provider: ImageProvider;
  url: string;
  port: number;
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
  source: { url: string; name: string } | null;
  current: GeneratedImage | null;
  history: GeneratedImage[];
  busy: boolean;
  progress: string;
  message: string;
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
    }
  | { type: "saveAs"; file: string }
  | { type: "copy"; file: string }
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
  "openFolder",
]);

const DEFAULT_SETTINGS: ImageGenSettings = { provider: "comfyui", url: "http://localhost", port: 8188 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Lado de la imagen: entero, múltiplo de 8 y dentro del rango admitido. */
function sanitizeSide(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 512;
  return clamp(Math.round(Math.round(value) / 8) * 8, MIN_SIDE, MAX_SIDE);
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
    case "pickSource":
    case "clearSource":
    case "openFolder":
      return { type: action.type };
    case "setProvider":
      return action.provider === "comfyui" || action.provider === "openai"
        ? { type: "setProvider", provider: action.provider }
        : undefined;
    case "setServer": {
      const typed = typeof action.url === "string" ? action.url.trim() : "";
      // Sin barras finales, pero «http://» a secas no puede quedarse en «http:».
      const url = typed.endsWith("://") ? typed : typed.replace(/\/+$/, "");
      const port = typeof action.port === "number" ? Math.round(action.port) : NaN;
      return /^https?:\/\//.test(url) && url.length <= 200 && port >= 1 && port <= 65535
        ? { type: "setServer", url, port }
        : undefined;
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
      };
    }
    case "saveAs":
    case "copy": {
      const file = typeof action.file === "string" ? action.file : "";
      return file ? { type: action.type, file } : undefined;
    }
  }
  return undefined;
}

/** Ajustes recordados entre sesiones; lo que no valga vuelve al defecto. */
function readSettings(context: vscode.ExtensionContext): ImageGenSettings {
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
  return { provider, url, port };
}

/** Nombre de la imagen: marca de tiempo local y cuatro hex para no pisar otra del mismo segundo. */
function imageName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `img-${stamp}-${randomBytes(2).toString("hex")}.png`;
}

/** Ancho y alto de un PNG desde su cabecera IHDR, sin leer la imagen entera. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24) {
      return { width: 0, height: 0 };
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

function mimeOf(name: string): string {
  const ext = name.toLowerCase().slice(name.lastIndexOf("."));
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
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
          if (this.last) {
            this.post({ type: "state", state: this.last });
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
        if (action.type === "generate" || action.type === "connect" || action.type === "refresh") {
          this.queue = this.queue.then(() => this.handle(action));
        } else {
          void this.handle(action);
        }
      },
      null,
      this.disposables
    );
  }

  /** Carpeta de imágenes: en el proyecto si hay, si no en el almacén global. */
  private dir(): string {
    return imagenesDir(this.context);
  }

  private async handle(action: ImageGenAction): Promise<void> {
    this.message = "";
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
        return;
      case "setServer":
        this.settings.url = action.url;
        this.settings.port = action.port;
        await this.context.globalState.update(KEY_SETTINGS, this.settings);
        await this.syncComfy();
        return;
      case "connect":
        await this.syncComfy();
        return;
      case "setKey":
        // La clave se queda en `secrets`: al webview solo vuelve `hasKey`.
        await this.context.secrets.store(KEY_OPENAI, action.key);
        this.message = "Clave de OpenAI guardada.";
        return;
      case "refresh":
        await this.syncComfy();
        return;
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
      case "openFolder":
        await this.openFolder();
        return;
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
    try {
      let bytes: Buffer;
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
        bytes = await generateImage({
          key,
          model: action.model,
          prompt: action.prompt,
          width: action.width,
          height: action.height,
        });
      }
      const file = await this.saveBytes(bytes);
      this.currentFile = file;
      this.message = "Imagen generada.";
      // Solo se avisa del recorte por el tope: redondear a múltiplos de 8 es lo normal.
      if (action.requested.width > MAX_SIDE || action.requested.height > MAX_SIDE) {
        this.message =
          `Imagen generada a ${action.width}×${action.height}. ` +
          `El tamaño pedido (${action.requested.width}×${action.requested.height}) se recortó al máximo de ${MAX_SIDE} por lado.`;
      }
    } finally {
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
    const dir = this.dir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, imageName());
    await writeAtomic(file, bytes);
    return file;
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

  /**
   * Solo se leen o copian PNG que estén de verdad dentro de la carpeta de imágenes: se
   * resuelven los enlaces y se exige una ruta relativa sin `..`. En Windows la comparación
   * va sin caja (la unidad puede venir con otra); en el resto, con caja.
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
      throw new Error("Solo se pueden copiar o guardar imágenes PNG.");
    }
    return target;
  }

  /** Imágenes de la carpeta, de la más reciente a la más vieja. */
  private async readHistory(): Promise<Array<{ file: string; width: number; height: number }>> {
    const dir = this.dir();
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".png"));
    } catch {
      return [];
    }
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
      source: this.source ? { url: this.source.url, name: this.source.name } : null,
      current: current ? this.toState(current) : null,
      history: history.map((entry) => this.toState(entry)),
      busy: this.busy,
      progress: this.progress,
      message: this.message,
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
      .replaceAll("%%TOKENS%%", uriIn("tokens.css"))
      .replaceAll("%%STYLE%%", uriIn("imageGen.css"))
      .replaceAll("%%SCRIPT%%", uriIn("imageGen.js"));
  }

  /** Suelta el singleton al cerrarse, sin volver a disponer el panel. */
  private release(): void {
    if (ImageGenPanel.current === this) {
      ImageGenPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

/** Carpeta de imágenes generadas: en el proyecto si hay carpeta abierta, si no en el almacén global. */
function imagenesDir(context: vscode.ExtensionContext): string {
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
