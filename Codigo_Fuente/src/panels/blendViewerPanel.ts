/**
 * Visor Alfred 3D: pestaña central de solo lectura para ficheros `.blend`. El host exporta
 * el fichero a GLB con Blender (caché en globalStorage) y la webview lo pinta con three.js;
 * desde aquí se lanzan también renders PNG de un frame o de un rango de la animación.
 * El `.blend` nunca se guarda.
 */
import * as vscode from "vscode";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import {
  RenderCancelledError,
  alfred3dRoot,
  blenderVersion,
  ensureScene,
  findBlender,
  invalidateSceneCache,
  renderAnimation,
  renderStill,
  safeBase,
  writeAtomic,
  type Scene,
} from "../blender/bridge";

/** Base, carpeta y motor de los renders, recordados por espacio de trabajo (no por pestaña). */
const KEY_BASE = "opencodeAgents.alfred3d.base";
const KEY_DIR = "opencodeAgents.alfred3d.dir";
const KEY_ENGINE = "opencodeAgents.alfred3d.engine";
/** Aviso único de carpeta inválida: lo comparten los renders de Blender y los del visor. */
const DIR_INVALIDA =
  "La carpeta de salida no es válida: escribe una ruta absoluta a una carpeta que exista.";

export class BlendViewerProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = "opencodeAgents.blendViewer";

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose() {} };
  }

  resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    new BlendViewerSession(this.context, document.uri, panel);
  }
}

/** Una pestaña abierta: un webview, un `.blend` y, como mucho, un render en marcha. */
class BlendViewerSession {
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pending: unknown[] = [];
  /** Último PNG escrito por el visor: `renderVisorEnd` lo da por terminado. */
  private ultimoPngVisor?: string;
  /** Exportación en vuelo: varias pestañas visibles no lanzan varios Blender. */
  private exportando?: Promise<Scene>;
  /** Último init enviado: al recrearse el webview hay que repetirlo sin reexportar. */
  private ultimoInit?: Scene;
  private busy = false;
  private disposed = false;
  private job?: { cancel(): void };
  /** Operación vigente: el cierre de una vieja no puede pisar el estado de la siguiente. */
  private operacion = 0;
  /** Mensajes en orden de llegada: un `renderVisorEnd` no puede correr antes de su `renderPng`. */
  private cola: Promise<void> = Promise.resolve();
  /** La tanda del visor tuvo un fallo: su cierre no debe contestar con datos de la anterior. */
  private visorFallo = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly blendUri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel
  ) {
    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    this.panel.webview.options = {
      enableScripts: true,
      // El GLB vive en la caché del almacén global o en el sidecar junto al `.blend`.
      localResourceRoots: [
        media,
        vscode.Uri.file(alfred3dRoot(context)),
        vscode.Uri.file(dirname(this.blendPath)),
      ],
    };
    this.panel.webview.html = this.getHtml(this.panel.webview, media);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: {
        type?: string;
        kind?: unknown;
        frame?: unknown;
        start?: unknown;
        end?: unknown;
        count?: unknown;
        base?: unknown;
        dir?: unknown;
        engine?: unknown;
        data?: unknown;
      }) => {
        // La cola solo ordena: cada handler empieza con el anterior terminado.
        if (message?.type === "cancelRender") {
          // Cancelar no puede hacer cola: el render en vuelo es lo que la está ocupando.
          this.job?.cancel();
          return;
        }
        this.cola = this.cola
          .then(() => this.onMessage(message))
          .catch((err) => this.post({ type: "renderFailed", message: errorText(err) }));
      },
      null,
      this.disposables
    );
  }

  private get blendPath(): string {
    return this.blendUri.fsPath;
  }

  /** Nombre del `.blend` sin extensión, ya saneado para usarlo como prefijo de los PNG. */
  private get stem(): string {
    return safeBase(basename(this.blendPath, extname(this.blendPath)));
  }

  private async onMessage(message: {
    type?: string;
    kind?: unknown;
    frame?: unknown;
    start?: unknown;
    end?: unknown;
    count?: unknown;
    base?: unknown;
    dir?: unknown;
    engine?: unknown;
    data?: unknown;
  }): Promise<void> {
    switch (message?.type) {
      case "ready":
        this.ready = true;
        this.flush();
        void this.enviarBlender();
        void this.enviarInit();
        return;
      case "pickBlender":
        await this.pickBlender();
        return;
      case "pickDir":
        await this.pickDir();
        return;
      case "renderSettings":
        this.recordarRender(message.base, message.dir, message.engine);
        return;
      case "renderPng":
        await this.renderPng(message.dir, message.base, message.frame, message.data);
        return;
      case "renderVisorEnd":
        this.renderVisorEnd(message.kind, message.dir, message.count);
        return;
      case "renderStill":
        await this.renderStill(message.frame, message.base, message.dir);
        return;
      case "renderAnimation":
        await this.renderAnimation(message.start, message.end, message.base, message.dir);
        return;
    }
  }

  /** Exporta el GLB (stat si la caché vale) y manda la escena; cada `ready` lo repite. */
  private async enviarInit(): Promise<void> {
    // Una exportación ya en marcha termina enviando el init: no se lanza otra.
    if (this.exportando) {
      return this.exportando.then(
        () => undefined,
        () => undefined
      );
    }
    const enVuelo = ensureScene(this.context, this.blendPath);
    this.exportando = enVuelo;
    try {
      const scene = await enVuelo;
      this.ultimoInit = scene;
      this.postInit(scene);
    } catch (err) {
      // Un reexport fallido no deja la pestaña en blanco solo si el GLB anterior sigue en disco.
      if (this.ultimoInit && !existsSync(this.ultimoInit.glb)) {
        this.ultimoInit = undefined;
      }
      if (this.ultimoInit) {
        this.postInit(this.ultimoInit);
      } else {
        this.post({ type: "error", message: errorText(err) });
      }
    } finally {
      this.exportando = undefined;
    }
  }

  private postInit(scene: Scene): void {
    const glb = this.panel.webview.asWebviewUri(vscode.Uri.file(scene.glb)).toString();
    this.post({
      type: "init",
      // El mtime como versión: sin él la webview puede reusar el GLB viejo de su caché.
      glb: `${glb}?v=${Math.round(scene.mtime)}`,
      meta: scene.meta,
      render: this.renderPrefs(),
    });
  }

  /** Base, carpeta y motor recordados; sin nada guardado, el nombre y la carpeta del `.blend`. */
  private renderPrefs(): { base: string; dir: string; engine: "visor" | "blender" } {
    const guardada = this.context.workspaceState.get<string>(KEY_BASE)?.trim();
    const dirGuardada = this.context.workspaceState.get<string>(KEY_DIR)?.trim();
    return {
      base: safeBase(guardada || this.stem),
      dir: dirGuardada && existsSync(dirGuardada) ? dirGuardada : dirname(this.blendPath),
      engine:
        this.context.workspaceState.get<string>(KEY_ENGINE) === "blender" ? "blender" : "visor",
    };
  }

  /** Base del mensaje, saneada; vacía = nombre del `.blend`. */
  private baseDe(raw: unknown): string {
    const texto = typeof raw === "string" ? raw.trim() : "";
    return safeBase(texto || this.stem);
  }

  /** El render exige carpeta absoluta que exista: si no, no se toca nada. */
  private dirValida(raw: unknown): string | undefined {
    const dir = typeof raw === "string" ? raw.trim() : "";
    if (!dir || !isAbsolute(dir)) {
      return undefined;
    }
    try {
      return statSync(dir).isDirectory() ? dir : undefined;
    } catch {
      return undefined;
    }
  }

  /** El webview manda base, carpeta y motor con debounce: se guardan sin responder. */
  private recordarRender(rawBase: unknown, rawDir: unknown, rawEngine: unknown): void {
    void this.context.workspaceState.update(KEY_BASE, this.baseDe(rawBase));
    // Una ruta relativa o inexistente no se guarda: solo la base se conserva.
    const dir = this.dirValida(rawDir);
    if (dir) {
      void this.context.workspaceState.update(KEY_DIR, dir);
    }
    // El motor solo se persiste si viene conocido: un valor raro no borra el guardado.
    if (rawEngine === "visor" || rawEngine === "blender") {
      void this.context.workspaceState.update(KEY_ENGINE, rawEngine);
    }
  }

  /**
   * PNG fotografiado por el visor: se escribe tal cual, sin Blender ni cerrojo.
   * Éxito = silencio: la webview cierra la tirada con `renderVisorEnd`.
   */
  private async renderPng(
    rawDir: unknown,
    rawBase: unknown,
    rawFrame: unknown,
    rawData: unknown
  ): Promise<void> {
    // La tanda cuenta como fallida hasta que writeAtomic confirme: cualquier salida de error,
    // incluida la excepción de escritura, deja la marca para que el cierre no mienta.
    this.visorFallo = true;
    const dir = this.dirValida(rawDir);
    if (!dir) {
      this.post({ type: "renderFailed", message: DIR_INVALIDA });
      return;
    }
    if (typeof rawFrame !== "number" || !Number.isInteger(rawFrame) || rawFrame < 0) {
      this.post({ type: "renderFailed", message: "El frame tiene que ser un número entero." });
      return;
    }
    if (typeof rawData !== "string" || !rawData) {
      this.post({ type: "renderFailed", message: "El visor no ha enviado los datos del PNG." });
      return;
    }
    // El mismo pad4 que FOTO: así los PNG del visor y de Blender se llaman igual.
    const file = join(dir, `${this.baseDe(rawBase)}_frame${String(rawFrame).padStart(4, "0")}.png`);
    await writeAtomic(file, Buffer.from(rawData, "base64"));
    this.ultimoPngVisor = file;
    this.visorFallo = false;
  }

  /** Cierre del render del visor: un frame suelto o una animación ya escrita frame a frame. */
  private renderVisorEnd(rawKind: unknown, rawDir: unknown, rawCount: unknown): void {
    if (rawKind === "animation") {
      this.post({ type: "renderDone", kind: "animation", path: rawDir, count: rawCount });
      return;
    }
    if (this.visorFallo) {
      // El renderFailed de la tanda ya cerró la UI del webview: no la pisa con datos viejos.
      this.visorFallo = false;
      return;
    }
    if (rawKind !== "still") {
      this.post({ type: "renderFailed", message: "El tipo de render del visor no es válido." });
      return;
    }
    if (!this.ultimoPngVisor) {
      this.post({ type: "renderFailed", message: "El visor no ha escrito ningún PNG todavía." });
      return;
    }
    this.post({ type: "renderDone", kind: "still", path: this.ultimoPngVisor });
  }

  /** Diálogo de carpeta de salida; responde siempre, con null si se cancela. */
  private async pickDir(): Promise<void> {
    if (this.busy) {
      this.post({ type: "renderDir", dir: null });
      return;
    }
    const guardada = this.context.workspaceState.get<string>(KEY_DIR)?.trim();
    const defecto = guardada && existsSync(guardada) ? guardada : dirname(this.blendPath);
    const elegidas = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defecto),
      title: "Carpeta de salida de los renders",
      openLabel: "Usar esta carpeta",
    });
    this.post({ type: "renderDir", dir: elegidas?.[0]?.fsPath ?? null });
  }

  /** Línea de estado de la webview: qué Blender se está usando. */
  private async enviarBlender(): Promise<void> {
    const path = await findBlender();
    const version = path ? await blenderVersion(path) : "";
    this.post({ type: "blender", path: path ?? null, version });
  }

  /** Elegir otro `blender.exe`: ajuste global, caché fuera y reexportación. */
  private async pickBlender(): Promise<void> {
    if (this.busy) {
      return;
    }
    const op = ++this.operacion;
    this.busy = true;
    try {
      const actual = await findBlender();
      const elegidos = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { Blender: ["exe"] },
        defaultUri: vscode.Uri.file(actual ?? "C:\\Program Files\\Blender Foundation"),
        title: "Elegir el ejecutable de Blender",
        openLabel: "Usar este Blender",
      });
      const exe = elegidos?.[0]?.fsPath;
      if (!exe) {
        return;
      }
      if (!(await blenderVersion(exe))) {
        void vscode.window.showWarningMessage("Ese ejecutable no parece Blender.");
        return;
      }
      await vscode.workspace
        .getConfiguration("opencodeAgents")
        .update("blenderPath", exe, vscode.ConfigurationTarget.Global);
      // Nadie puede invalidar la caché mientras Blender sigue escribiendo en ella.
      const enVuelo = this.exportando;
      if (enVuelo) {
        await enVuelo.then(
          () => undefined,
          () => undefined
        );
        this.exportando = undefined;
      }
      // Los GLB de la versión anterior ya no valen: fuera caché y a exportar de nuevo.
      await invalidateSceneCache(this.context);
      this.ultimoInit = undefined;
      await this.enviarBlender();
      await this.enviarInit();
    } catch (err) {
      this.post({ type: "error", message: errorText(err) });
    } finally {
      if (this.operacion === op) {
        this.job = undefined;
        this.busy = false;
      }
    }
  }

  private async renderStill(rawFrame: unknown, rawBase: unknown, rawDir: unknown): Promise<void> {
    // Solo un render a la vez: el webview deshabilita sus botones, pero no se fía de él.
    if (this.busy) {
      return;
    }
    if (typeof rawFrame !== "number" || !Number.isInteger(rawFrame)) {
      this.post({ type: "renderFailed", message: "El frame tiene que ser un número entero." });
      return;
    }
    const dir = this.dirValida(rawDir);
    if (!dir) {
      this.post({ type: "renderFailed", message: DIR_INVALIDA });
      return;
    }
    const frame = rawFrame;
    // El nombre final lo pone el host: Blender escribe a un temporal y su padding da igual.
    const outPath = join(dir, `${this.baseDe(rawBase)}_frame${String(frame).padStart(4, "0")}.png`);
    const op = ++this.operacion;
    this.busy = true;
    try {
      const blender = await findBlender();
      if (!blender) {
        this.post({
          type: "renderFailed",
          message:
            "No encuentro Blender. Instálalo o indica la ruta en el ajuste opencodeAgents.blenderPath.",
        });
        return;
      }

      const job = renderStill({ blender, blend: this.blendPath, frame, outPath });
      this.job = job;
      this.post({ type: "renderProgress", kind: "still", frame, total: 1 });
      let path: string;
      try {
        path = await job.done;
      } catch (err) {
        if (err instanceof RenderCancelledError) {
          this.post({ type: "renderCancelled" });
        } else {
          this.post({ type: "renderFailed", message: errorText(err) });
        }
        return;
      } finally {
        this.job = undefined;
        // Libre antes del aviso: un clic en ese hueco ya no se descarta.
        this.busy = false;
      }
      if (this.disposed) {
        return;
      }
      this.post({ type: "renderDone", kind: "still", path });
      // El aviso no puede esperar al clic: la cola de mensajes se bloquearía tras el render.
      void Promise.resolve(
        vscode.window.showInformationMessage(`PNG guardado en ${path}`, "Abrir")
      )
        .then((pick) =>
          pick === "Abrir" ? vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path)) : undefined
        )
        .catch(() => undefined);
    } finally {
      // Solo cierra la operación que sigue vigente: un render o un diálogo posterior manda.
      if (this.operacion === op) {
        this.job = undefined;
        this.busy = false;
      }
    }
  }

  private async renderAnimation(
    rawStart: unknown,
    rawEnd: unknown,
    rawBase: unknown,
    rawDir: unknown
  ): Promise<void> {
    if (this.busy) {
      return;
    }
    if (
      typeof rawStart !== "number" ||
      typeof rawEnd !== "number" ||
      !Number.isInteger(rawStart) ||
      !Number.isInteger(rawEnd)
    ) {
      this.post({
        type: "renderFailed",
        message: "El inicio y el fin tienen que ser números enteros.",
      });
      return;
    }
    if (rawStart > rawEnd) {
      this.post({
        type: "renderFailed",
        message: "Rango de frames no válido: el inicio no puede ser mayor que el fin.",
      });
      return;
    }
    const dir = this.dirValida(rawDir);
    if (!dir) {
      this.post({ type: "renderFailed", message: DIR_INVALIDA });
      return;
    }
    const start = rawStart;
    const end = rawEnd;
    const base = this.baseDe(rawBase);
    const op = ++this.operacion;
    this.busy = true;
    try {
      const blender = await findBlender();
      if (!blender) {
        this.post({
          type: "renderFailed",
          message:
            "No encuentro Blender. Instálalo o indica la ruta en el ajuste opencodeAgents.blenderPath.",
        });
        return;
      }

      const total = end - start + 1;
      const job = renderAnimation({
        blender,
        blend: this.blendPath,
        start,
        end,
        dir,
        base,
        onFrame: (frame) => this.post({ type: "renderProgress", kind: "animation", frame, total }),
      });
      this.job = job;
      let count: number;
      try {
        count = await job.done;
      } catch (err) {
        if (err instanceof RenderCancelledError) {
          this.post({ type: "renderCancelled" });
        } else {
          this.post({ type: "renderFailed", message: errorText(err) });
        }
        return;
      } finally {
        this.job = undefined;
        // Libre antes del aviso: un clic en ese hueco ya no se descarta.
        this.busy = false;
      }
      if (this.disposed) {
        return;
      }
      this.post({ type: "renderDone", kind: "animation", path: dir, count });
      // Igual que en FOTO: sin clic pendiente que deje la cola colgada.
      void Promise.resolve(
        vscode.window.showInformationMessage(`${count} PNG en ${dir}`, "Abrir carpeta")
      )
        .then((pick) =>
          pick === "Abrir carpeta" ? vscode.env.openExternal(vscode.Uri.file(dir)) : undefined
        )
        .catch(() => undefined);
    } finally {
      // Solo cierra la operación que sigue vigente: un render o un diálogo posterior manda.
      if (this.operacion === op) {
        this.job = undefined;
        this.busy = false;
      }
    }
  }

  private post(message: unknown): void {
    // La pestaña pudo cerrarse mientras un render seguía: no hay webview a la que hablar.
    if (this.disposed) {
      return;
    }
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

  private getHtml(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = getNonce();
    const uriIn = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();

    // El marcado vive en media/blendViewer.html: la extensión solo rellena los huecos.
    const template = readFileSync(
      join(this.context.extensionUri.fsPath, "media", "blendViewer.html"),
      "utf8"
    );
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%TOKENS%%", uriIn("tokens.css"))
      .replaceAll("%%STYLE%%", uriIn("blendViewer.css"))
      .replaceAll("%%SCRIPT%%", uriIn("blendViewer.js"))
      .replaceAll("%%THREE%%", uriIn("three/three.module.min.js"));
  }

  private dispose(): void {
    this.disposed = true;
    this.job?.cancel();
    this.job = undefined;
    this.busy = false;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
