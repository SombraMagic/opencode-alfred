import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { RadarSinBase, RadarService, type RadarPerfilView } from "../radar/service";
import type { CampoFlag, RadarFila } from "../radar/db";
import type { RadarConfig, RadarEstado, RadarProveedor, RadarTema } from "../radar/types";
import { currentTheme, themeLinks, themeScript } from "./theme";

/** Filas por página de la lista de noticias. */
const PAGINA = 100;

/** Nombres de modelo admitidos (ids de proveedor, variantes y etiquetas). */
const MODELO_RE = /^[A-Za-z0-9._:/-]{0,200}$/;
/** Ids de perfil de MariaDB (UUID o nombre corto). */
const ID_RE = /^[A-Za-z0-9._-]{0,64}$/;
/** Tope de temas editables desde CONFIGURACIÓN. */
const MAX_TEMAS = 20;

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "list",
  "sync",
  "repuntuar",
  "marcar",
  "guardarConfig",
  "guardarTemas",
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
      traducir: boolean;
    }
  | { type: "guardarTemas"; temas: RadarTema[] }
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
      // Campo ausente vale `false`, igual que `sanearConfig`: un mensaje viejo no pierde el guardado.
      const traducir = action.traducir === true;
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
        traducir,
      };
    }
    case "guardarTemas":
      return { type: "guardarTemas", temas: leerTemas(action.temas) };
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

/**
 * Valida la lista de temas que manda el webview. Los ids vacíos se generan y los repetidos
 * se corrigen aquí: `sanearConfig` es la red final, no la única. Lanza con texto legible.
 */
function leerTemas(raw: unknown): RadarTema[] {
  if (!Array.isArray(raw)) {
    throw new Error("Los temas no han llegado como lista.");
  }
  if (raw.length > MAX_TEMAS) {
    throw new Error(`No se pueden guardar más de ${MAX_TEMAS} temas.`);
  }
  const nombres = new Set<string>();
  const ids = new Set<string>();
  const temas: RadarTema[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      throw new Error(`El tema ${i + 1} no tiene un formato válido.`);
    }
    const t = item as Record<string, unknown>;
    const nombre = typeof t.nombre === "string" ? t.nombre.trim().slice(0, 64) : "";
    if (!nombre) {
      throw new Error(`El tema ${i + 1} no tiene nombre.`);
    }
    const clave = nombre.toLowerCase();
    if (clave === "todos") {
      throw new Error("«TODOS» está reservado para el filtro de la lista.");
    }
    if (nombres.has(clave)) {
      throw new Error(`Ya existe un tema «${nombre}».`);
    }
    nombres.add(clave);
    temas.push({
      id: idUnico(typeof t.id === "string" ? t.id : "", ids, i),
      nombre,
      incluir: leerLista(t.incluir, nombre),
      excluir: leerLista(t.excluir, nombre),
    });
  }
  return temas;
}

/** Id estable y único: vacío pasa a `tema-N` y un repetido lleva sufijo `-2`, `-3`… */
function idUnico(bruto: string, usados: Set<string>, indice: number): string {
  let id = bruto.trim().slice(0, 64);
  if (!id) {
    id = `tema-${indice + 1}`;
  }
  let candidato = id;
  let n = 2;
  while (usados.has(candidato)) {
    const sufijo = `-${n++}`;
    candidato = `${id.slice(0, 64 - sufijo.length)}${sufijo}`;
  }
  usados.add(candidato);
  return candidato;
}

/** Lista de palabras del tema; ausente vale vacía. */
function leerLista(raw: unknown, tema: string): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new Error(`Las palabras del tema «${tema}» no tienen un formato válido.`);
  }
  return raw as string[];
}

/** ¿Cambian las palabras de los temas? Renombrar uno no obliga a repuntuar. */
function reglasCambian(antes: RadarTema[], despues: RadarTema[]): boolean {
  if (antes.length !== despues.length) {
    return true;
  }
  const previos = new Map(antes.map((t) => [t.id, t]));
  for (const tema of despues) {
    const previo = previos.get(tema.id);
    if (!previo || !mismaLista(previo.incluir, tema.incluir) || !mismaLista(previo.excluir, tema.excluir)) {
      return true;
    }
  }
  return false;
}

function mismaLista(a: readonly string[], b: readonly string[]): boolean {
  const norm = (lista: readonly string[]): string[] =>
    [...new Set(lista.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0))].sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Configuración tal como viaja al webview: sin clave y sin secretos. */
interface RadarVista {
  fuentes: {
    id: string;
    nombre: string;
    url: string;
    activa: boolean;
    /** Tema fijo de la fuente; vacío = sin tema fijo (la lista no pinta chip). */
    temaFijo: string;
    ultimoError: string;
  }[];
  /** Temas editables con sus reglas: el formulario de CONFIGURACIÓN las necesita. */
  temas: { id: string; nombre: string; incluir: string[]; excluir: string[] }[];
  proveedor: RadarProveedor;
  modelo: string;
  umbral: number;
  profileId: string;
  /** Casilla TRADUCIR TITULARES Y CUERPOS de CONFIGURACIÓN. */
  traducir: boolean;
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
          let action: RadarAction | undefined;
          try {
            action = parseAction(message.action);
          } catch (err) {
            // Los temas se validan con mensajes concretos («El tema 2 no tiene nombre.»).
            this.post({ type: "aviso", text: mensajeDe(err) });
            return;
          }
          if (action) {
            this.enqueue(action);
          } else {
            // Una acción descartada no puede quedarse en silencio: el formulario parecería
            // guardado y volvería a su sitio al reabrir.
            this.post({
              type: "aviso",
              text: "No se pudo guardar: hay un campo con un valor que no vale.",
            });
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
        const antesTraducir = this.cfg.traducir;
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
          traducir: action.traducir,
        });
        // Un perfil nuevo se conecta desde cero: la sesión vieja se cierra.
        await this.service.cerrarSesion();
        await this.recargarTodo();
        if (!antesTraducir && action.traducir) {
          // Encender la traducción no toca lo ya puntuado: hay que volver a puntuar o el
          // usuario no verá ni un titular traducido y creerá que la casilla no hace nada.
          this.post({
            type: "aviso",
            tono: "info",
            text: "Traducción activada. Pulsa REPUNTUAR 3 DÍAS para traducir las noticias que ya están guardadas.",
          });
        }
        return;
      }

      case "guardarTemas": {
        const antes = this.cfg.temas;
        await this.service.saveConfig({ temas: action.temas });
        // Un tema borrado o renombrado no puede dejar la lista filtrada por un nombre que ya
        // no existe: el filtro vuelve a TODOS y el repintado enseña las noticias.
        if (this.tema && !this.service.config().temas.some((t) => t.nombre === this.tema)) {
          this.tema = "";
        }
        await this.recargarTodo();
        if (reglasCambian(antes, this.cfg.temas)) {
          // Lo ya puntuado no se toca solo: si no se dice, el usuario creerá que las reglas
          // nuevas ya filtraron el histórico.
          this.post({
            type: "aviso",
            tono: "info",
            text: "Temas guardados. Las noticias ya puntuadas no cambian hasta que pulses REPUNTUAR 3 DÍAS.",
          });
        } else {
          this.post({ type: "aviso", tono: "info", text: "Temas guardados." });
        }
        // El formulario se cierra con este aviso, no antes: si la validación falla, lo escrito
        // sigue en su sitio.
        this.post({ type: "temasGuardados" });
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
        temaFijo: f.temaFijo ?? "",
        ultimoError: this.fuenteErrores.get(f.id) ?? "",
      })),
      temas: this.cfg.temas.map((t) => ({
        id: t.id,
        nombre: t.nombre,
        incluir: [...t.incluir],
        excluir: [...t.excluir],
      })),
      proveedor: this.cfg.proveedor,
      modelo: this.cfg.modelo,
      umbral: this.cfg.umbral,
      profileId: this.cfg.profileId,
      traducir: this.cfg.traducir,
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
