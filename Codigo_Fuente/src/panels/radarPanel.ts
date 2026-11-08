import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { RadarSinBase, RadarService, type RadarPerfilView } from "../radar/service";
import type { CampoFlag, RadarFila } from "../radar/db";
import type { RadarConfig, RadarEstado, RadarProveedor } from "../radar/types";
import { currentTheme, themeLinks, themeScript } from "./theme";

/** Filas por página de la lista de noticias. */
const PAGINA = 100;

/** Nombres de modelo admitidos (ids de proveedor, variantes y etiquetas). */
const MODELO_RE = /^[A-Za-z0-9._:/-]{0,200}$/;
/** Ids de perfil de MariaDB (UUID o nombre corto). */
const ID_RE = /^[A-Za-z0-9._-]{0,64}$/;

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "list",
  "sync",
  "repuntuar",
  "marcar",
  "guardarConfig",
  "setClave",
  "borrarClave",
  "abrir",
  "setActivo",
]);

/** La lista es de solo lectura salvo las dos banderas: nombres fijos, nunca libres. */
type RadarAction =
  | { type: "list"; busqueda: string; tema: string; offset: number }
  | { type: "sync" }
  | { type: "repuntuar" }
  | { type: "marcar"; id: number; campo: CampoFlag; valor: boolean }
  | {
      type: "guardarConfig";
      activas: string[];
      proveedor: RadarProveedor;
      modelo: string;
      umbral: number;
      profileId: string;
    }
  | { type: "setClave"; clave: string }
  | { type: "borrarClave" }
  | { type: "abrir"; enlace: string }
  | { type: "setActivo"; on: boolean };

/** El webview no es de fiar: todo lo que manda se valida aquí. */
function parseAction(raw: unknown): RadarAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
  if (typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  switch (action.type) {
    case "list": {
      const busqueda = typeof action.busqueda === "string" ? action.busqueda.trim().slice(0, 200) : "";
      const tema = typeof action.tema === "string" ? action.tema.trim().slice(0, 64) : "";
      const bruto = typeof action.offset === "number" && Number.isFinite(action.offset) ? action.offset : 0;
      const offset = Math.max(0, Math.min(1_000_000, Math.round(bruto)));
      return { type: "list", busqueda, tema, offset };
    }
    case "sync":
      return { type: "sync" };
    case "repuntuar":
      return { type: "repuntuar" };
    case "marcar": {
      const id = Number(action.id);
      const campo =
        action.campo === "leida" || action.campo === "guardada" ? action.campo : undefined;
      if (!campo || !Number.isInteger(id) || id <= 0 || typeof action.valor !== "boolean") {
        return undefined;
      }
      return { type: "marcar", id, campo, valor: action.valor };
    }
    case "guardarConfig": {
      const proveedor =
        action.proveedor === "openai" || action.proveedor === "deepseek" || action.proveedor === "ollama"
          ? action.proveedor
          : undefined;
      const modelo = typeof action.modelo === "string" ? action.modelo.trim() : "";
      const profileId = typeof action.profileId === "string" ? action.profileId.trim() : "";
      const umbral = Math.round(Number(action.umbral));
      const activas = Array.isArray(action.activas)
        ? action.activas
            .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64)
            .slice(0, 40)
        : undefined;
      if (
        !proveedor ||
        !activas ||
        !Number.isFinite(umbral) ||
        !MODELO_RE.test(modelo) ||
        !ID_RE.test(profileId)
      ) {
        return undefined;
      }
      return {
        type: "guardarConfig",
        activas,
        proveedor,
        modelo,
        umbral: Math.min(100, Math.max(0, umbral)),
        profileId,
      };
    }
    case "setClave": {
      const clave = typeof action.clave === "string" ? action.clave.trim() : "";
      return clave.length > 0 && clave.length <= 500 ? { type: "setClave", clave } : undefined;
    }
    case "borrarClave":
      return { type: "borrarClave" };
    case "abrir": {
      const enlace = typeof action.enlace === "string" ? action.enlace.trim() : "";
      return /^https?:\/\/\S+$/i.test(enlace) && enlace.length <= 2000
        ? { type: "abrir", enlace }
        : undefined;
    }
    case "setActivo":
      return typeof action.on === "boolean" ? { type: "setActivo", on: action.on } : undefined;
  }
  return undefined;
}

/** Configuración tal como viaja al webview: sin clave y sin secretos. */
interface RadarVista {
  fuentes: { id: string; nombre: string; url: string; activa: boolean; ultimoError: string }[];
  temas: string[];
  proveedor: RadarProveedor;
  modelo: string;
  umbral: number;
  profileId: string;
  perfiles: RadarPerfilView[];
  hasClave: boolean;
  filas: RadarFila[];
  total: number;
  offset: number;
  /** Tamaño de página vigente: la webview no repite el número. */
  pagina: number;
  busqueda: string;
  tema: string;
  /** Pasadas automáticas del ajuste `opencodeAgents.radar.activo`. */
  activo: boolean;
  /** Mensaje de `RadarSinBase`: la vista dice «Sin conexión con MariaDB». */
  sinBase?: string;
  /** Otro fallo de lectura, ya en español. */
  error?: string;
  estado: RadarEstado;
}

export class RadarPanel {
  public static current: RadarPanel | undefined;
  private static readonly viewType = "opencodeAgents.radar";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly service: RadarService;
  private readonly disposables: vscode.Disposable[] = [];

  private cola = Promise.resolve();
  private disposed = false;
  private enMarcha = false;

  private cfg: RadarConfig;
  private perfiles: RadarPerfilView[] = [];
  private hasClave = false;
  private busqueda = "";
  private tema = "";
  private offset = 0;
  private filas: RadarFila[] = [];
  private total = -1;
  private fuenteErrores = new Map<string, string>();
  private sinBase?: string;
  private errorLista?: string;

  static open(context: vscode.ExtensionContext, service: RadarService): RadarPanel {
    if (RadarPanel.current) {
      RadarPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void RadarPanel.current.recargarTodo();
      return RadarPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      RadarPanel.viewType,
      "Radar de noticias",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );

    RadarPanel.current = new RadarPanel(panel, context, service);
    return RadarPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    service: RadarService
  ) {
    this.panel = panel;
    this.context = context;
    this.service = service;
    this.cfg = service.config();

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.disposables.push(
      this.service.onChange((estado) => this.onEstado(estado))
    );

    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: unknown }) => {
        if (message?.type === "ready") {
          this.postTheme();
          void this.recargarTodo();
          return;
        }
        if (message?.type === "action") {
          const action = parseAction(message.action);
          if (action) {
            this.enqueue(action);
          }
        }
      },
      null,
      this.disposables
    );
  }

  /** Avisa al webview del estilo visual vigente. */
  postTheme(): void {
    this.post({ type: "theme", theme: currentTheme() });
  }

  /** Repinta la vista cuando el ajuste cambia fuera del panel (Settings). */
  notifyChanged(): void {
    this.publicar();
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  // ── Acciones ──────────────────────────────────────────────────────────────

  private enqueue(action: RadarAction): void {
    this.cola = this.cola.then(() => this.ejecutar(action)).catch((err) => {
      // Una acción que se queda sin MariaDB deja la vista en «sin conexión»: el pie no
      // puede seguir diciendo que hay base cuando la conexión se cayó a mitad.
      if (err instanceof RadarSinBase) {
        this.sinBase = err.message;
        this.errorLista = undefined;
        this.filas = [];
        this.total = -1;
        this.fuenteErrores = new Map();
        this.publicar();
        return;
      }
      this.post({ type: "aviso", text: mensajeDe(err) });
    });
  }

  private async ejecutar(action: RadarAction): Promise<void> {
    switch (action.type) {
      case "list":
        this.busqueda = action.busqueda;
        this.tema = action.tema;
        this.offset = action.offset;
        await this.refrescarLista();
        this.publicar();
        return;

      case "sync":
        // El servicio publica sus fases por `onChange`: aquí no se finge nada.
        await this.service.sync(true);
        return;

      case "repuntuar":
        await this.service.repuntuar();
        return;

      case "marcar":
        await this.service.marcar(action.id, action.campo, action.valor);
        await this.refrescarLista();
        this.publicar();
        return;

      case "guardarConfig": {
        const activas = new Set(action.activas);
        const fuentes = this.service
          .config()
          .fuentes.map((f) => ({ ...f, activa: activas.has(f.id) }));
        await this.service.saveConfig({
          fuentes,
          proveedor: action.proveedor,
          modelo: action.modelo,
          umbral: action.umbral,
          profileId: action.profileId,
        });
        // Un perfil nuevo se conecta desde cero: la sesión vieja se cierra.
        await this.service.cerrarSesion();
        await this.recargarTodo();
        return;
      }

      case "setClave":
        await this.service.setClave(action.clave);
        await this.recargarConfig();
        this.publicar();
        return;

      case "borrarClave":
        await this.service.borrarClave();
        await this.recargarConfig();
        this.publicar();
        return;

      case "abrir":
        await vscode.env.openExternal(vscode.Uri.parse(action.enlace));
        return;

      case "setActivo":
        // El ajuste manda: el oyente de configuración re-arma el temporizador.
        await vscode.workspace
          .getConfiguration("opencodeAgents")
          .update("radar.activo", action.on, vscode.ConfigurationTarget.Global);
        this.publicar();
        return;
    }
  }

  // ── Datos ─────────────────────────────────────────────────────────────────

  private async recargarConfig(): Promise<void> {
    this.cfg = this.service.config();
    this.perfiles = await this.service.perfiles();
    this.hasClave = await this.service.hasClave();
  }

  private async recargarTodo(): Promise<void> {
    await this.recargarConfig();
    if (this.disposed) {
      return;
    }
    await this.refrescarLista();
    this.publicar();
  }

  private async refrescarLista(): Promise<void> {
    try {
      const res = await this.service.listar({
        busqueda: this.busqueda,
        tema: this.tema,
        offset: this.offset,
        limit: PAGINA,
      });
      this.filas = res.filas;
      this.total = res.total;
      this.fuenteErrores = res.estados;
      this.sinBase = undefined;
      this.errorLista = undefined;
    } catch (err) {
      this.filas = [];
      this.total = -1;
      this.fuenteErrores = new Map();
      if (err instanceof RadarSinBase) {
        this.sinBase = err.message;
        this.errorLista = undefined;
      } else {
        this.sinBase = undefined;
        this.errorLista = mensajeDe(err);
      }
    }
  }

  private publicar(): void {
    this.post({ type: "data", payload: this.vista() });
  }

  private vista(): RadarVista {
    const activo = vscode.workspace
      .getConfiguration("opencodeAgents")
      .get<boolean>("radar.activo", false);
    return {
      fuentes: this.cfg.fuentes.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        url: f.url,
        activa: f.activa,
        ultimoError: this.fuenteErrores.get(f.id) ?? "",
      })),
      temas: this.cfg.temas.map((t) => t.nombre),
      proveedor: this.cfg.proveedor,
      modelo: this.cfg.modelo,
      umbral: this.cfg.umbral,
      profileId: this.cfg.profileId,
      perfiles: this.perfiles,
      hasClave: this.hasClave,
      filas: this.filas,
      total: this.total,
      offset: this.offset,
      pagina: PAGINA,
      busqueda: this.busqueda,
      tema: this.tema,
      activo,
      sinBase: this.sinBase,
      error: this.errorLista,
      estado: this.service.estadoActual(),
    };
  }

  /** El estado de la pasada se repinta en vivo; al acabar, la lista se recarga. */
  private onEstado(estado: RadarEstado): void {
    this.post({ type: "estado", estado });
    if (estado.fase === "working") {
      this.enMarcha = true;
      return;
    }
    if (this.enMarcha) {
      this.enMarcha = false;
      void this.refrescarLista().then(() => this.publicar());
    }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    try {
      const nonce = getNonce();
      const uriIn = (file: string): string =>
        webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();
      const template = readFileSync(
        path.join(this.context.extensionUri.fsPath, "media", "radar.html"),
        "utf8"
      );
      return template
        .replaceAll("%%CSP%%", webview.cspSource)
        .replaceAll("%%NONCE%%", nonce)
        .replaceAll("%%THEME_LINKS%%", themeLinks(this.context.extensionUri, webview, []))
        .replaceAll("%%THEME_SCRIPT%%", themeScript(this.context.extensionUri, webview, nonce))
        .replaceAll("%%STYLE%%", uriIn("radar.css"))
        .replaceAll("%%SCRIPT%%", uriIn("radar.js"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Radar de noticias: no se pudo cargar la interfaz (${message}).`);
      return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" /><title>Radar de noticias</title></head><body><p>No se pudo cargar <code>media/radar.html</code>.</p></body></html>`;
    }
  }

  private dispose(): void {
    this.disposed = true;
    RadarPanel.current = undefined;
    while (this.disposables.length > 0) {
      const item = this.disposables.pop();
      if (item) {
        item.dispose();
      }
    }
    // La conexión cacheada se cierra cuando termina la acción en vuelo, no en mitad de ella.
    void this.cola.then(() => this.service.cerrarSesion()).catch(() => undefined);
  }
}

function mensajeDe(err: unknown): string {
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
