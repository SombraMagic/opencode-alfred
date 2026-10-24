import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelEntry } from "./modelsPanel";

export interface AssignAgent {
  name: string;
  scope: "project" | "global" | "builtin";
  /** Id `proveedor/modelo` del frontmatter, o "" si no tiene. */
  model: string;
  /** Texto corto ya formateado: descripción, «integrado», «sobrescrito por proyecto»… */
  detail?: string;
}

export interface AssignData {
  agents: AssignAgent[];
  /** Catálogo vivo de opencode. */
  models: ModelEntry[];
  favorites: string[];
}

export type AssignAction =
  | { type: "toggleFavorite"; id: string; on: boolean }
  | { type: "assign"; agent: string; scope: AssignAgent["scope"]; model: string }
  | { type: "clear"; agent: string; scope: AssignAgent["scope"] }
  | { type: "close" };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>(["toggleFavorite", "assign", "clear", "close"]);

export interface AssignPanelHandlers {
  onAction(action: AssignAction): void | Promise<void>;
  onReady(): void;
}

export class AssignPanel {
  public static current: AssignPanel | undefined;
  private static readonly viewType = "opencodeAgents.assign";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: AssignPanelHandlers;
  private last?: AssignData;

  static open(
    context: vscode.ExtensionContext,
    data: AssignData,
    handlers: AssignPanelHandlers
  ): AssignPanel {
    if (AssignPanel.current) {
      AssignPanel.current.handlers = handlers;
      AssignPanel.current.panel.reveal(vscode.ViewColumn.Active);
      AssignPanel.current.update(data);
      return AssignPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      AssignPanel.viewType,
      "Asignar agentes a modelos",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    AssignPanel.current = new AssignPanel(panel, context.extensionUri, handlers);
    AssignPanel.current.update(data);
    return AssignPanel.current;
  }

  /** Cierra el tablero si está abierto (al cambiar a un proveedor que no lo admite). */
  static close(): void {
    AssignPanel.current?.dispose();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    handlers: AssignPanelHandlers
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.handlers = handlers;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: AssignAction }) => {
        if (message?.type === "ready") {
          if (this.last) {
            this.post({ type: "assign", payload: this.last });
          }
          this.handlers.onReady();
          return;
        }
        if (message?.type !== "action") {
          return;
        }
        const action = message.action;
        if (!action || typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
          return;
        }
        // Cerrar no llega al handler: es cosa del panel.
        if (action.type === "close") {
          this.panel.dispose();
          return;
        }
        // El webview no es de fiar: se comprueba la forma antes de tocar ficheros.
        if (action.type === "toggleFavorite") {
          if (typeof action.id !== "string" || !action.id || typeof action.on !== "boolean") {
            return;
          }
        } else if (
          typeof action.agent !== "string" ||
          !action.agent ||
          !["project", "global", "builtin"].includes(action.scope) ||
          (action.type === "assign" && (typeof action.model !== "string" || !action.model))
        ) {
          return;
        }
        void this.handlers.onAction(action);
      },
      null,
      this.disposables
    );
  }

  update(data: AssignData): void {
    this.last = data;
    this.post({ type: "assign", payload: data });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "assign.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "assign.js")
    );

    // El marcado vive en media/assign.html: la extensión solo rellena los huecos.
    const template = readFileSync(
      join(this.extensionUri.fsPath, "media", "assign.html"),
      "utf8"
    );
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%TOKENS%%", tokensUri.toString())
      .replaceAll("%%STYLE%%", styleUri.toString())
      .replaceAll("%%SCRIPT%%", scriptUri.toString());
  }

  private dispose(): void {
    AssignPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      d?.dispose();
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
