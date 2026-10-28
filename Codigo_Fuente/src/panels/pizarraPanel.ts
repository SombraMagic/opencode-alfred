/**
 * Panel de PIZARRA: editor de imagen por capas (fondo, imágenes pegadas, trazos y
 * textos) sobre un lienzo de alto fijo 1024 px y ancho según el aspecto del panel, o
 * fijado al tamaño exacto de la imagen traída del portapapeles (con tope de 4096 por
 * lado), que es el que se exporta.
 *
 * Lo que importa de fuera es el PNG aplanado. Cada cambio se guarda como copia de
 * trabajo en la carpeta de adjuntos (la misma del dictado), de modo que otro panel
 * pueda pedirla con `PizarraPanel.requestPng()` sin tener que abrir esta pestaña.
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

/** La misma cota que los adjuntos del dictado. */
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
/** Nombre del fichero con la copia de trabajo, dentro de la carpeta de adjuntos. */
const WORK_FILE = "pizarra-ultima.png";
/** Dónde guardó el PNG la última vez (ámbito de ventana). */
const KEY_LAST_URI = "opencodeAgents.pizarra.lastUri";
/** Cuánto espera `requestPng` al webview antes de conformarse con lo que haya. */
const CAPTURE_TIMEOUT_MS = 5000;
/** Cabecera de todo PNG: lo que manda el webview tiene que ser de verdad una imagen. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
/** Cuánto espera el puerto del portapapeles antes de darlo por vacío. */
const CLIPBOARD_TIMEOUT_MS = 5000;

/** Escribe de forma atómica (tmp + rename), como hace agents/store.ts con el texto. */
async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** Copia de trabajo: en el proyecto si hay, si no en el almacén global (igual que el dictado). */
function workFile(context: vscode.ExtensionContext): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root
    ? join(root, ".alfred", "adjuntos", WORK_FILE)
    : join(context.globalStorageUri.fsPath, "adjuntos", WORK_FILE);
}

/** Descifra el base64 que manda el webview, con el mismo tope que los adjuntos. */
function decodePng(raw: unknown): Buffer | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  // El webview no es de fiar: se corta antes de decodificar (base64 ≈ 4/3 del binario).
  if (!base64 || base64.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4) {
    return undefined;
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 8 || bytes.length > MAX_SNAPSHOT_BYTES || !bytes.subarray(0, 4).equals(PNG_MAGIC)) {
    return undefined;
  }
  return bytes;
}

export class PizarraPanel {
  public static current: PizarraPanel | undefined;
  private static readonly viewType = "opencodeAgents.pizarra";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pending: unknown[] = [];
  /** Último PNG aplanado que mandó el webview. */
  private lastSnapshot?: Buffer;
  /** Promesas de `capture` esperando su instantánea. */
  private waiters: ((bytes: Buffer | undefined) => void)[] = [];
  /** Escrituras de una en una: dos instantáneas seguidas pisarían el mismo `.tmp`. */
  private cola: Promise<void> = Promise.resolve();
  /**
   * El init pendiente. `capture` lo espera: si se salta por delante, el webview aún no tiene
   * la copia de trabajo cargada y exportaría un lienzo en blanco por encima de lo ya dibujado.
   */
  private iniciado: Promise<void> = Promise.resolve();

  /** Escribe la copia de trabajo esperando a las escrituras pendientes. */
  private guardarCopia(bytes: Buffer): Promise<void> {
    const trabajo = this.cola
      .then(() => writeAtomic(workFile(this.context), bytes))
      .catch(() => {
        // La copia es una comodidad: si el disco falla, el PNG vive en el panel igual.
      });
    this.cola = trabajo;
    return trabajo;
  }

  static async open(context: vscode.ExtensionContext): Promise<void> {
    if (PizarraPanel.current) {
      PizarraPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PizarraPanel.viewType,
      "Pizarra",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    const instance = new PizarraPanel(panel, context);
    PizarraPanel.current = instance;
    // Se anota antes de esperar: una `capture` que llegue de otra mano durante la apertura
    // tiene que quedarse detrás del init.
    instance.iniciado = instance.sendInit();
    // Si el init falla (p. ej. falta pizarra.html en desarrollo), la apertura no deja
    // un rejection sin manejar: `capture` ya cae a la copia de trabajo por su catch.
    await instance.iniciado.catch(() => undefined);
  }

  /**
   * PNG de la pizarra sin abrir la pestaña: si está abierta se pide una instantánea
   * fresca; si no, o si el webview no contesta, vale la copia de trabajo.
   * No lanza: sin nada guardado devuelve null.
   */
  static async requestPng(context: vscode.ExtensionContext): Promise<Buffer | null> {
    const panel = PizarraPanel.current;
    if (panel) {
      // `capture` puede rechazar si la webview se liberó mientras esperaba: aquí vale leer la copia.
      const fresh = await panel.capture().catch(() => undefined);
      if (fresh) {
        return fresh;
      }
    }
    try {
      const bytes = await readFile(workFile(context));
      return bytes.length ? bytes : null;
    } catch {
      // Sin copia de trabajo: todavía no se ha dibujado nada.
      return null;
    }
  }

  /** Pide una instantánea y espera el `snapshot` con tope. */
  private async capture(): Promise<Buffer | undefined> {
    // Primero el init: sin él, el webview contestaría con el lienzo todavía sin cargar.
    await this.iniciado;
    return new Promise((resolve) => {
      let done = false;
      const settle = (bytes: Buffer | undefined) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== settle);
        resolve(bytes ?? this.lastSnapshot);
      };
      const timer = setTimeout(() => settle(undefined), CAPTURE_TIMEOUT_MS);
      this.waiters.push(settle);
      this.post({ type: "capture" });
    });
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; png?: unknown }) => void this.onMessage(message),
      null,
      this.disposables
    );
  }

  /** Lee la copia de trabajo y manda el estado inicial en cuanto el webview esté listo. */
  private async sendInit(): Promise<void> {
    let png: string | null = null;
    try {
      const bytes = await readFile(workFile(this.context));
      if (bytes.length && bytes.length <= MAX_SNAPSHOT_BYTES) {
        png = `data:image/png;base64,${bytes.toString("base64")}`;
      }
    } catch {
      // Sin copia: lienzo en blanco.
    }
    this.post({ type: "init", png });
  }

  /**
   * Imagen del portapapeles leída con PowerShell: la webview no la puede coger con un clic.
   * Devuelve la data URL o undefined si no hay imagen. Al webview sólo llega la data URL, ni
   * la ruta transitoria ni los bytes crudos.
   */
  private async readClipboard(): Promise<string | undefined> {
    const script = join(this.context.extensionUri.fsPath, "resources", "pizarra-clipboard.ps1");
    const tmp = join(tmpdir(), `pizarra-clipboard-${process.pid}-${Date.now()}.png`);
    try {
      // `-STA` lo exige `Clipboard::GetImage`; `-NonInteractive`, que nada pregunte en consola.
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script, "-OutPath", tmp],
        { windowsHide: true, timeout: CLIPBOARD_TIMEOUT_MS }
      );
      const bytes = await readFile(tmp);
      // El PNG_MAGIC corta también el fichero truncado: si PowerShell no escribió, no llega.
      if (bytes.length < 8 || bytes.length > MAX_SNAPSHOT_BYTES || !bytes.subarray(0, 4).equals(PNG_MAGIC)) {
        return undefined;
      }
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      // Sin imagen, PowerShell cortado o transitorio ausente: todo vale «portapapeles vacío».
      return undefined;
    } finally {
      // El transitorio no se queda en el disco.
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async onMessage(message: { type?: string; png?: unknown }): Promise<void> {
    switch (message?.type) {
      case "ready":
        this.ready = true;
        this.flush();
        return;
      case "clipboardBg": {
        const src = await this.readClipboard();
        this.post(src ? { type: "clipboardImage", src } : { type: "clipboardEmpty" });
        return;
      }
      case "snapshot": {
        const bytes = decodePng(message.png);
        if (!bytes) {
          return;
        }
        this.lastSnapshot = bytes;
        // Primero la copia escrita: quien llama por `requestPng` debe ver lo mismo en disco.
        await this.guardarCopia(bytes);
        this.settleWaiters(bytes);
        return;
      }
      case "save":
        await this.saveToDisk(decodePng(message.png));
        return;
    }
  }

  private settleWaiters(bytes: Buffer | undefined): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(bytes);
  }

  /** Guarda el PNG donde el usuario diga y recuerda el sitio para la próxima vez. */
  private async saveToDisk(bytes: Buffer | undefined): Promise<void> {
    const png = bytes ?? this.lastSnapshot;
    if (!png) {
      void vscode.window.showWarningMessage("La pizarra está vacía: no hay nada que guardar.");
      return;
    }
    const last = this.context.workspaceState.get<string>(KEY_LAST_URI);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = last
      ? vscode.Uri.file(last)
      : vscode.Uri.joinPath(root ?? this.context.globalStorageUri, "pizarra.png");
    let target: vscode.Uri | undefined;
    try {
      target = await vscode.window.showSaveDialog({
        filters: { PNG: ["png"] },
        defaultUri,
        title: "Guardar pizarra como PNG",
      });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo abrir el diálogo de guardado: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (!target) {
      return;
    }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(target.fsPath)));
      await vscode.workspace.fs.writeFile(target, png);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo guardar la pizarra: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    await this.context.workspaceState.update(KEY_LAST_URI, target.fsPath);
    this.lastSnapshot = png;
    await this.guardarCopia(png);
    this.post({ type: "saved", path: target.fsPath });
  }

  private post(message: unknown): void {
    if (this.ready) {
      void this.panel.webview.postMessage(message);
    } else {
      this.pending.push(message);
    }
  }

  private flush(): void {
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) {
      void this.panel.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const uriIn = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();

    // El marcado vive en media/pizarra.html: la extensión solo rellena los huecos.
    const template = readFileSync(
      join(this.context.extensionUri.fsPath, "media", "pizarra.html"),
      "utf8"
    );
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%TOKENS%%", uriIn("tokens.css"))
      .replaceAll("%%STYLE%%", uriIn("pizarra.css"))
      .replaceAll("%%SCRIPT%%", uriIn("pizarra.js"));
  }

  private dispose(): void {
    if (PizarraPanel.current === this) {
      PizarraPanel.current = undefined;
    }
    this.settleWaiters(this.lastSnapshot);
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
