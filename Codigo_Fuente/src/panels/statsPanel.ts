import * as vscode from "vscode";
import { StatsSnapshot } from "../stats/opencodeStats";

export interface StatsPanelHandlers {
  reset(agent?: string): Promise<void>;
  clear(agent?: string): Promise<void>;
  refresh(): Promise<void>;
}

export class StatsPanel {
  public static current: StatsPanel | undefined;
  private static readonly viewType = "opencodeAgents.stats";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: StatsPanelHandlers;
  private last?: StatsSnapshot;

  static open(context: vscode.ExtensionContext, handlers: StatsPanelHandlers): StatsPanel {
    if (StatsPanel.current) {
      StatsPanel.current.handlers = handlers;
      StatsPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      if (StatsPanel.current.last) {
        StatsPanel.current.update(StatsPanel.current.last);
      }
      return StatsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      StatsPanel.viewType,
      "opencode: estadísticas de agentes",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    StatsPanel.current = new StatsPanel(panel, context.extensionUri, handlers);
    return StatsPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    handlers: StatsPanelHandlers
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.handlers = handlers;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (message: { type?: string; agent?: string }) => {
        switch (message.type) {
          case "ready":
            if (this.last) {
              this.post({ type: "stats", payload: this.last });
            }
            break;
          case "reset":
            await this.handlers.reset(message.agent);
            break;
          case "clear":
            await this.handlers.clear(message.agent);
            break;
          case "resetAll":
            await this.handlers.reset();
            break;
          case "clearAll":
            await this.handlers.clear();
            break;
          case "refresh":
            await this.handlers.refresh();
            break;
        }
      },
      null,
      this.disposables
    );
  }

  update(snapshot: StatsSnapshot): void {
    this.last = snapshot;
    this.post({ type: "stats", payload: snapshot });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "stats.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "stats.js")
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
<link href="${styleUri}" rel="stylesheet" />
<title>Estadísticas de agentes</title>
</head>
<body>
<div id="app">
  <header class="head">
    <div>
      <h1>Estadísticas de agentes</h1>
      <p class="sub" id="subtitle">Leyendo datos de opencode…</p>
    </div>
    <div class="head-actions">
      <button id="btn-refresh" class="secondary" type="button">Actualizar</button>
      <button id="btn-clear-all" class="secondary" type="button" title="Borra la linea base y muestra el historico completo">Ver histórico</button>
      <button id="btn-reset-all" class="primary" type="button" title="Pone todos los contadores a cero y sigue sumando">Reiniciar todo</button>
    </div>
  </header>

  <div id="banner" class="banner" hidden></div>

  <section id="totals" class="totals"></section>

  <div class="toolbar">
    <input id="search" type="search" placeholder="Filtrar agente…" spellcheck="false" />
  </div>

  <table id="table">
    <thead>
      <tr>
        <th data-key="agent" class="sortable">Agente</th>
        <th data-key="state" class="sortable">Estado</th>
        <th data-key="total" class="sortable num">Tokens</th>
        <th data-key="input" class="sortable num">Entrada</th>
        <th data-key="output" class="sortable num">Salida</th>
        <th data-key="reasoning" class="sortable num">Razon.</th>
        <th data-key="cache" class="sortable num">Caché L</th>
        <th data-key="cost" class="sortable num">Coste</th>
        <th data-key="workMs" class="sortable num">Tiempo</th>
        <th data-key="sessions" class="sortable num">Ses.</th>
        <th data-key="messages" class="sortable num">Msg</th>
        <th data-key="lastActive" class="sortable">Última actividad</th>
        <th class="actions">Acciones</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>

  <p class="hint">El botón <strong>Reiniciar</strong> guarda un punto de partida por agente: el contador muestra 0 y vuelve a sumar. <strong>Ver histórico</strong> borra ese punto de partida. Los datos provienen de las bases de datos de opencode (nada se escribe en ellas).</p>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    StatsPanel.current = undefined;
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
