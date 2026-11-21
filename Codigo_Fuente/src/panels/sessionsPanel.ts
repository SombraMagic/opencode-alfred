/**
 * Panel SESIONES: desplegable de proyectos de opencode o Claude y, debajo, las sesiones del elegido de
 * la más nueva a la más vieja, en una pestaña central. Al pulsar una sesión, el host la retoma con `opencode -s <id>` o `claude --resume <id>` en la carpeta de su proyecto.
 *
 * El marcado está en `media/sessions.html` (lo escribe `interfaz`): aquí solo se rellenan los
 * huecos `%%CSP%% %%NONCE%% %%THEME_LINKS%% %%THEME_SCRIPT%% %%STYLE%% %%SCRIPT%%` (los mismos
 * del comparador de modelos) y se atiende al webview, que no es de fiar.
 *
 * PROTOCOLO
 * webview → host
 *   {type:"ready"}                                  arranque: tema y datos
 *   {type:"sessions"}                               botón de refrescar
 *   {type:"loadSession", id, directory, title}      retomar una sesión
 * host → webview
 *   {type:"theme", theme}
 *   {type:"sessions", groups:[{dir,name,sessions:[{id,title,active,updated}]}], current?, error?}
 *     `current` es la carpeta abierta en VS Code: el desplegable arranca en ese proyecto.
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentTheme, themeLinks, themeScript } from "./theme";
import { projectRoot } from "../agents/paths";

/** Una sesión de la lista: lo justo para rotular y marcar la que corre. */
export interface SessionItem {
  id: string;
  title: string;
  active: boolean;
  updated: number;
}

/** Proyecto del desplegable: su carpeta y sus sesiones raíz. */
export interface SessionGroup {
  dir: string;
  name: string;
  sessions: SessionItem[];
}

export interface SessionsPanelHandlers {
  /** Retoma una sesión en la terminal. */
  load(id: string, directory: string, title: string): void;
  /** Sesiones raíz agrupadas por carpeta, o el error ya en español. */
  request(): Promise<{ groups: SessionGroup[]; error?: string }>;
}

/** Id de sesión que admiten opencode y Claude: el que se pasa a `-s` o `--resume` sin comillas ni escapes. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,120}$/;
/** Tope de la carpeta: una ruta más larga no cabe en ningún sistema de ficheros real. */
const MAX_DIR = 400;
/** Tope del título: se usa para el nombre de la terminal, no para nada más. */
const MAX_TITLE = 200;

export class SessionsPanel {
  public static current: SessionsPanel | undefined;
  public static readonly viewType = "opencodeAgents.sessions";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: SessionsPanelHandlers;

  static open(context: vscode.ExtensionContext, handlers: SessionsPanelHandlers): SessionsPanel {
    if (SessionsPanel.current) {
      SessionsPanel.current.handlers = handlers;
      // Sin robar el foco: la terminal de la izquierda sigue siendo donde se escribe.
      SessionsPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return SessionsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      SessionsPanel.viewType,
      "Sesiones",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    SessionsPanel.current = new SessionsPanel(panel, context.extensionUri, handlers);
    return SessionsPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    handlers: SessionsPanelHandlers
  ) {
    this.panel = panel;
    this.handlers = handlers;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      () => {
        // La lista se pone al día cada vez que se vuelve a mirar el panel.
        if (this.panel.visible) {
          void this.sendSessions();
        }
      },
      null,
      this.disposables
    );
    this.panel.webview.onDidReceiveMessage(
      (message: {
        type?: string;
        id?: unknown;
        directory?: unknown;
        title?: unknown;
      }) => {
        switch (message?.type) {
          case "ready":
            this.postTheme();
            void this.sendSessions();
            break;
          case "sessions":
            void this.sendSessions();
            break;
          case "loadSession": {
            const id = typeof message.id === "string" ? message.id : "";
            const directory = typeof message.directory === "string" ? message.directory : "";
            const title = typeof message.title === "string" ? message.title.slice(0, MAX_TITLE) : "";
            // Un mensaje que no casa se descarta en silencio: el webview no es de fiar.
            if (!SESSION_ID.test(id) || !directory || directory.length > MAX_DIR || directory.includes("\0")) {
              break;
            }
            this.handlers.load(id, directory, title);
            break;
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

  private async sendSessions(): Promise<void> {
    let groups: SessionGroup[] = [];
    let error: string | undefined;
    try {
      const r = await this.handlers.request();
      groups = r.groups;
      error = r.error;
    } catch (err) {
      error = `No se pudieron leer las sesiones: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.post({ type: "sessions", groups, current: projectRoot(), error });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const media = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file)).toString();
    let template: string;
    try {
      template = readFileSync(join(this.extensionUri.fsPath, "media", "sessions.html"), "utf8");
    } catch {
      return '<!DOCTYPE html><html lang="es"><body>No se encontró media/sessions.html.</body></html>';
    }
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%THEME_LINKS%%", themeLinks(this.extensionUri, webview, []))
      .replaceAll("%%THEME_SCRIPT%%", themeScript(this.extensionUri, webview, nonce))
      .replaceAll("%%STYLE%%", media("sessions.css"))
      .replaceAll("%%SCRIPT%%", media("sessions.js"));
  }

  /** Suelta el singleton y sus oyentes al cerrarse. */
  private dispose(): void {
    if (SessionsPanel.current === this) {
      SessionsPanel.current = undefined;
    }
    this.panel.dispose();
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
