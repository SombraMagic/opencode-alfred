import * as vscode from "vscode";
import type { ExplorerAction } from "./explorerPanel";

export interface ControlData {
  sessionAgent: string;
  sessionAgents: string[];
  menteLocal: boolean;
}

/** Acciones que el webview tiene permitido pedir: el mando de Control y nada más. */
const ACTION_TYPES = new Set<string>([
  "cycleAgent",
  "openLastSession",
  "openConnectors",
  "openMenteLocal",
]);

/** El webview no es de fiar: solo pasan las cuatro acciones del mando, con su forma exacta. */
function parseAction(raw: unknown): ExplorerAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
  if (typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  switch (action.type) {
    case "cycleAgent":
      return action.delta === 1 || action.delta === -1
        ? { type: "cycleAgent", delta: action.delta }
        : undefined;
    case "openLastSession":
      return { type: "openLastSession" };
    case "openConnectors":
      return { type: "openConnectors" };
    case "openMenteLocal":
      return { type: "openMenteLocal" };
  }
  return undefined;
}

export class ControlPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeAgents.control";

  private view?: vscode.WebviewView;
  private last?: ControlData;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: {
      onAction(action: ExplorerAction): void | Promise<void>;
      onReady(): void;
    }
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message: { type?: string; action?: unknown }) => {
      if (message?.type === "ready") {
        this.ready = true;
        if (this.last) {
          this.post(this.last);
        }
        this.handlers.onReady();
        return;
      }
      if (message?.type !== "action") {
        return;
      }
      const action = parseAction(message.action);
      if (!action) {
        return;
      }
      void this.handlers.onAction(action);
    });

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  update(data: ControlData): void {
    this.last = data;
    if (this.view && this.ready) {
      this.post(data);
    }
  }

  private post(data: ControlData): void {
    void this.view?.webview.postMessage({ type: "data", payload: data });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "explorer.css")
    );
    const controlUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "control.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "control.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${tokensUri}" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
<link href="${controlUri}" rel="stylesheet" />
<title>ALFRED // CONTROL</title>
</head>
<body>
<div class="hud">
  <details class="fold" open>
    <summary>CONTROLES</summary>
    <div class="mando">
      <div class="mando-row">
        <div class="session-group">
          <button id="agent-prev" class="agent-arrow" type="button" title="Agente anterior" aria-label="Agente anterior" disabled>‹</button>
          <button id="btn-session" class="ghost-btn session-btn" type="button" title="Abrir o enfocar la terminal del agente"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill-rule="evenodd" clip-rule="evenodd"></path></svg><span id="agent-label" hidden>OPEN</span></button>
          <button id="agent-next" class="agent-arrow" type="button" title="Agente siguiente" aria-label="Agente siguiente" disabled>›</button>
        </div>
        <button id="btn-connectors" class="icon-btn" type="button" title="Conectores de opencode" aria-label="Conectores de opencode" disabled><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/></svg></button>
        <button id="btn-mente" class="icon-btn" type="button" title="Ollama (mente local)" aria-label="Ollama (mente local)" aria-pressed="false"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.3 2.3a2 2 0 0 0-2 1.9 2 2 0 0 0-1.1 3.6 2 2 0 0 0 1.4 3.4 2 2 0 0 0 3.3 1.4V3.2a1.7 1.7 0 0 0-1.6-.9Z"/><path d="M9.7 2.3a2 2 0 0 1 2 1.9 2 2 0 0 1 1.1 3.6 2 2 0 0 1-1.4 3.4 2 2 0 0 1-3.3 1.4V3.2a1.7 1.7 0 0 1 1.6-.9Z"/><path d="M4.7 5.4h1.5M4.3 9.1h1.7M11.3 5.4H9.8M11.7 9.1H10"/></svg></button>
        <button id="btn-image" class="icon-btn" type="button" title="Generador de imágenes (próximamente)" aria-label="Generador de imágenes (próximamente)" disabled><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M8.5 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg></button>
        <button id="btn-chatbot" class="icon-btn" type="button" title="Chatbot (próximamente)" aria-label="Chatbot (próximamente)" disabled><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v10H9l-5 4z"/></svg></button>
      </div>
    </div>
  </details>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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
