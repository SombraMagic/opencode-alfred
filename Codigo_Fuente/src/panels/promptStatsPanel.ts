import * as vscode from "vscode";
import { PromptStatsSnapshot } from "../stats/promptFlow";

export interface PromptStatsPanelHandlers {
  refresh(): Promise<void>;
  setMonitor(on: boolean): Promise<void>;
  clear(): Promise<void>;
}

/** Pestaña de estadísticas de prompts: lista de prompts y línea de tiempo de cada uno. */
export class PromptStatsPanel {
  public static current: PromptStatsPanel | undefined;
  private static readonly viewType = "opencodeAgents.promptStats";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: PromptStatsPanelHandlers;
  private last?: PromptStatsSnapshot;

  static open(context: vscode.ExtensionContext, handlers: PromptStatsPanelHandlers): PromptStatsPanel {
    if (PromptStatsPanel.current) {
      PromptStatsPanel.current.handlers = handlers;
      PromptStatsPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      if (PromptStatsPanel.current.last) {
        PromptStatsPanel.current.update(PromptStatsPanel.current.last);
      }
      return PromptStatsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      PromptStatsPanel.viewType,
      "opencode: estadísticas de prompts",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    PromptStatsPanel.current = new PromptStatsPanel(panel, context.extensionUri, handlers);
    return PromptStatsPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    handlers: PromptStatsPanelHandlers
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.handlers = handlers;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (message: { type?: string; on?: boolean }) => {
        switch (message.type) {
          case "ready":
            if (this.last) {
              this.post({ type: "promptStats", payload: this.last });
            }
            break;
          case "refresh":
            await this.handlers.refresh();
            break;
          case "setMonitor":
            await this.handlers.setMonitor(message.on === true);
            break;
          case "clear":
            await this.handlers.clear();
            break;
        }
      },
      null,
      this.disposables
    );
  }

  update(snapshot: PromptStatsSnapshot): void {
    this.last = snapshot;
    this.post({ type: "promptStats", payload: snapshot });
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
      vscode.Uri.joinPath(this.extensionUri, "media", "promptStats.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "promptStats.js")
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
<title>Estadísticas de prompts</title>
</head>
<body>
<div class="hud">
  <div class="hud-header">
    <span class="hud-dot"></span>
    <span class="hud-title">ESTADÍSTICAS DE PROMPTS</span>
    <button id="btn-monitor" class="switch" type="button" aria-pressed="false" aria-label="Monitorizar prompts" title="Escanea y guarda los prompts nuevos mientras opencode trabaja">
      <span class="switch-track"><span class="switch-thumb"></span></span>
      <span class="switch-label">MONITORIZAR</span>
    </button>
    <span id="chip-monitor" class="chip" aria-live="polite">EN PAUSA</span>
    <button id="btn-refresh" class="ghost-btn" type="button" title="Volver a escanear las bases de datos de opencode">ACTUALIZAR</button>
    <button id="btn-clear" class="ghost-btn" type="button" title="Borra el registro guardado de prompts">BORRAR</button>
  </div>

  <p class="sub" id="subtitle">Leyendo prompts de opencode…</p>

  <div id="banner" class="banner" hidden></div>
  <div id="notice" class="notice" hidden></div>

  <div class="board">
    <section class="col">
      <div class="col-head">
        <span class="label">PROMPTS</span>
        <span class="count" id="list-count"></span>
      </div>
      <div id="list" class="list"></div>
    </section>

    <section class="col">
      <div id="detail" class="detail" hidden>
        <div class="detail-head">
          <h2 class="detail-title" id="p-title"></h2>
          <p class="detail-meta" id="p-meta"></p>
        </div>
        <div class="toolbar">
          <button id="zoom-out" class="ghost-btn" type="button" aria-label="Alejar" title="Alejar la línea de tiempo">−</button>
          <button id="zoom-in" class="ghost-btn" type="button" aria-label="Acercar" title="Acercar la línea de tiempo">+</button>
          <button id="zoom-fit" class="ghost-btn" type="button" title="Ver el prompt completo">AJUSTAR</button>
          <span class="range-label" id="range-label">—</span>
          <span class="zoom-label" id="zoom-label">x1.00</span>
          <span class="zoom-hint">Ctrl + rueda</span>
        </div>
        <div class="timeline" id="timeline">
          <div class="lanes" id="lanes"></div>
          <div class="axis" id="axis" aria-hidden="true"></div>
        </div>
      </div>
      <div id="detail-empty" class="empty">Selecciona un prompt de la lista para ver su línea de tiempo.</div>
    </section>
  </div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    PromptStatsPanel.current = undefined;
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