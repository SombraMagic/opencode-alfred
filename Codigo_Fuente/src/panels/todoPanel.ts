/**
 * Panel TO_DO: pestaña central para ver y ordenar las tareas que comparten el usuario y la IA
 * (vía MCP `mcp_alfred`). Los datos viven en `src/todo/store.ts` (sin `vscode`, `todo.json`); este
 * panel no importa nada de `extension.ts`.
 *
 * PROTOCOLO
 * webview → host
 *   {type:"ready"}
 *   {type:"action", action:{type:"setEstado", id, estado}}
 *   {type:"action", action:{type:"mover", id, delta:-1|1, proyecto?}}
 *   {type:"action", action:{type:"moverA", id, destino}}   índice GLOBAL de destino
 *   {type:"action", action:{type:"setProyecto", id, proyecto}}
 *   {type:"action", action:{type:"borrar", id}}
 *   {type:"action", action:{type:"finalizar", id, hecho}}  true → finalizado; false → revisa
 *   {type:"action", action:{type:"refresh"}}
 * host → webview
 *   {type:"theme", theme}
 *   {type:"state", tareas:[Tarea & {nombre}], proyectos:string[], ahora}   (Tarea lleva `origen`)
 *   {type:"notice", text, error?:true}   con `error` el webview repinta y no auto-oculta el aviso
 *
 * El MCP escribe `todo.json` desde otro proceso: se vigila con `fs.watchFile`.
 */
import * as vscode from "vscode";
import { readFileSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { join } from "node:path";
import {
  borrarTarea,
  cambiarEstado,
  cambiarProyecto,
  EstadoTodo,
  ESTADOS_TODO,
  leerTodoSeguro,
  MAX_PROYECTO,
  moverRelativa,
  moverTarea,
  nombreTarea,
  todoFile,
} from "../todo/store";
import { currentTheme, themeLinks, themeScript } from "./theme";

const MAX_ID = 64;

type TodoAction =
  | { type: "setEstado"; id: string; estado: EstadoTodo }
  | { type: "mover"; id: string; delta: -1 | 1; proyecto?: string }
  | { type: "moverA"; id: string; destino: number }
  | { type: "setProyecto"; id: string; proyecto: string }
  | { type: "borrar"; id: string }
  | { type: "finalizar"; id: string; hecho: boolean }
  | { type: "refresh" };

/** El webview no es de fiar: solo pasan las acciones del panel, con su forma exacta y topes. */
export function parseAction(raw: unknown): TodoAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const a = raw as Record<string, unknown>;
  if (a.type === "refresh") {
    return { type: "refresh" };
  }
  const id = typeof a.id === "string" ? a.id : "";
  if (!id || id.length > MAX_ID) {
    return undefined;
  }
  switch (a.type) {
    case "setEstado":
      return typeof a.estado === "string" && (ESTADOS_TODO as string[]).includes(a.estado)
        ? { type: "setEstado", id, estado: a.estado as EstadoTodo }
        : undefined;
    case "mover": {
      if (a.delta !== -1 && a.delta !== 1) {
        return undefined;
      }
      if (a.proyecto === undefined) {
        return { type: "mover", id, delta: a.delta };
      }
      return typeof a.proyecto === "string" && a.proyecto.length <= MAX_PROYECTO
        ? { type: "mover", id, delta: a.delta, proyecto: a.proyecto }
        : undefined;
    }
    case "moverA":
      return typeof a.destino === "number" &&
        Number.isInteger(a.destino) &&
        a.destino >= 0 &&
        a.destino <= 1000
        ? { type: "moverA", id, destino: a.destino }
        : undefined;
    case "setProyecto":
      return typeof a.proyecto === "string" && a.proyecto.length <= MAX_PROYECTO
        ? { type: "setProyecto", id, proyecto: a.proyecto }
        : undefined;
    case "borrar":
      return { type: "borrar", id };
    case "finalizar":
      return typeof a.hecho === "boolean" ? { type: "finalizar", id, hecho: a.hecho } : undefined;
  }
  return undefined;
}

export class TodoPanel {
  public static current: TodoPanel | undefined;
  private static readonly viewType = "opencodeAgents.todo";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly file = todoFile();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly vigila = (cur: Stats, prev: Stats): void => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
      this.sendState();
    }
  };

  static open(context: vscode.ExtensionContext): TodoPanel {
    if (TodoPanel.current) {
      TodoPanel.current.reveal();
      return TodoPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(TodoPanel.viewType, "TO_DO", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    TodoPanel.current = new TodoPanel(panel, context.extensionUri);
    return TodoPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    // El MCP escribe el fichero desde otro proceso: sondeo barato cada segundo.
    watchFile(this.file, { interval: 1000 }, this.vigila);

    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: unknown }) => {
        if (message?.type === "ready") {
          this.postTheme();
          this.sendState();
          return;
        }
        if (message?.type !== "action") {
          return;
        }
        const action = parseAction(message.action);
        if (!action) {
          return;
        }
        if (action.type === "refresh") {
          this.sendState();
          return;
        }
        // Serial: las escrituras son leer-modificar-escribir sobre el mismo fichero. El `catch`
        // final evita que un eslabón rechazado deje la cadena rota para siempre.
        this.queue = this.queue
          .then(() => this.apply(action))
          .catch((err) => this.avisar(`No se pudo aplicar el cambio: ${err instanceof Error ? err.message : String(err)}`));
      },
      null,
      this.disposables
    );
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active);
    this.sendState();
  }

  private async apply(action: Exclude<TodoAction, { type: "refresh" }>): Promise<void> {
    try {
      let aviso: string | undefined;
      switch (action.type) {
        case "setEstado":
          aviso = (await cambiarEstado(action.id, action.estado)).aviso;
          break;
        case "finalizar":
          aviso = (await cambiarEstado(action.id, action.hecho ? "finalizado" : "revisa")).aviso;
          break;
        case "mover":
          aviso = (await moverRelativa(action.id, action.delta, action.proyecto)).aviso;
          break;
        case "moverA":
          aviso = (await moverTarea(action.id, action.destino)).aviso;
          break;
        case "setProyecto":
          aviso = (await cambiarProyecto(action.id, action.proyecto)).aviso;
          break;
        case "borrar":
          aviso = (await borrarTarea(action.id)).aviso;
          break;
      }
      if (aviso) {
        this.avisar(aviso);
      }
      this.sendState();
    } catch (err) {
      const motivo = `No se pudo aplicar el cambio: ${err instanceof Error ? err.message : String(err)}`;
      if (this.disposed) {
        console.error(`[TO_DO] ${motivo}`);
        return;
      }
      this.avisar(motivo);
      this.sendState();
    }
  }

  /** Aviso de fallo: el webview repinta con el fichero real y lo mantiene hasta que se cierre. */
  private avisar(text: string): void {
    this.post({ type: "notice", text, error: true });
  }

  /** Relee el fichero y manda el estado completo; si no se puede leer, avisa y NO pinta una lista vacía. */
  sendState(): void {
    if (this.disposed) {
      return;
    }
    const { tareas: leidas, error, aviso } = leerTodoSeguro();
    if (error) {
      this.avisar(error);
      return;
    }
    if (aviso) {
      this.avisar(aviso);
    }
    const tareas = leidas.map((t) => ({ ...t, nombre: nombreTarea(t.descripcion) }));
    const proyectos: string[] = [];
    for (const t of tareas) {
      if (t.proyecto && !proyectos.includes(t.proyecto)) {
        proyectos.push(t.proyecto);
      }
    }
    this.post({ type: "state", tareas, proyectos, ahora: Date.now() });
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
      template = readFileSync(join(this.extensionUri.fsPath, "media", "todo.html"), "utf8");
    } catch {
      return '<!DOCTYPE html><html lang="es"><body>No se encontró media/todo.html.</body></html>';
    }
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%THEME_LINKS%%", themeLinks(this.extensionUri, webview, []))
      .replaceAll("%%THEME_SCRIPT%%", themeScript(this.extensionUri, webview, nonce))
      .replaceAll("%%STYLE%%", media("todo.css"))
      .replaceAll("%%SCRIPT%%", media("todo.js"));
  }

  private release(): void {
    this.disposed = true;
    unwatchFile(this.file, this.vigila);
    if (TodoPanel.current === this) {
      TodoPanel.current = undefined;
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
