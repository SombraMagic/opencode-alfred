import * as vscode from "vscode";
import { ContextWindowInfo } from "../stats/contextWindow";

export class ContextViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeAgents.context";

  private view?: vscode.WebviewView;
  private last?: ContextWindowInfo;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onReady: () => void,
    private readonly onCompact: () => void
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === "compact") {
        this.onCompact();
        return;
      }
      if (message?.type !== "ready") {
        return;
      }
      if (this.last) {
        this.post(this.last);
      }
      this.onReady();
    });

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });

    if (this.last) {
      this.post(this.last);
    }
  }

  update(info: ContextWindowInfo): void {
    this.last = info;
    if (this.view) {
      this.post(info);
    }
  }

  /** Sesión que el panel está midiendo: es la que hay que compactar. */
  currentSessionId(): string | undefined {
    return this.last?.sessionId;
  }

  private post(info: ContextWindowInfo): void {
    void this.view?.webview.postMessage({ type: "context", payload: info });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "context.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "context.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${tokensUri}" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
<title>Contexto</title>
</head>
<body>
<div class="hud">
  <div class="hud-header">
    <span class="hud-dot"></span>
    <span class="hud-title" id="title">CONTEXTO</span>
  </div>

  <div id="banner" class="banner" hidden></div>

  <section id="usage" hidden>
    <div class="usage-head">
      <span class="pct" id="pct">—</span>
      <button id="compact" class="compact-btn" type="button" title="Compactar la conversación (equivale a /compact)">COMPACTAR</button>
    </div>
    <p class="tokens" id="tokens"></p>
    <p class="free" id="free"></p>
    <div id="cells" class="cells" role="img" aria-label="Ocupación de la ventana de contexto"></div>
    <details id="legend-box" class="legend-box">
      <summary>Leyenda</summary>
      <ul id="legend" class="legend"></ul>
    </details>
  </section>
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
