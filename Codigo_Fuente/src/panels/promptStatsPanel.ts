import * as vscode from "vscode";
import { PromptStatsSnapshot } from "../stats/promptFlow";
import { currentTheme, themeLinks, themeScript } from "./theme";

export interface PromptStatsPanelHandlers {
  refresh(): Promise<void>;
  setMonitor(on: boolean): Promise<void>;
  clear(): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

/** Preferencia de vista: mostrar u ocultar los huecos de tiempo entre prompts. */
const SHOW_GAPS_KEY = "opencodeAgents.promptStats.showGaps";

/** Pestaña de estadísticas de prompts: lista de prompts y línea de tiempo de cada uno. */
export class PromptStatsPanel {
  public static current: PromptStatsPanel | undefined;
  private static readonly viewType = "opencodeAgents.promptStats";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly globalState: vscode.Memento;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: PromptStatsPanelHandlers;
  private last?: PromptStatsSnapshot;
  private showGaps: boolean;

  static open(context: vscode.ExtensionContext, handlers: PromptStatsPanelHandlers): PromptStatsPanel {
    if (PromptStatsPanel.current) {
      PromptStatsPanel.current.handlers = handlers;
      PromptStatsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (PromptStatsPanel.current.last) {
        PromptStatsPanel.current.update(PromptStatsPanel.current.last);
      }
      return PromptStatsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      PromptStatsPanel.viewType,
      "Alfred: estadísticas de prompts",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    PromptStatsPanel.current = new PromptStatsPanel(
      panel,
      context.extensionUri,
      context.globalState,
      handlers
    );
    return PromptStatsPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    globalState: vscode.Memento,
    handlers: PromptStatsPanelHandlers
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.globalState = globalState;
    this.handlers = handlers;
    this.showGaps = globalState.get<boolean>(SHOW_GAPS_KEY, false);

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (message: { type?: string; on?: boolean; ids?: unknown }) => {
        switch (message.type) {
          case "ready":
            this.postTheme();
            this.post({ type: "showGaps", on: this.showGaps });
            if (this.last) {
              this.post({ type: "promptStats", payload: this.last });
            }
            break;
          case "setShowGaps":
            // El webview ya repinta en local: al host solo le queda recordar la preferencia.
            this.showGaps = message.on === true;
            void this.globalState.update(SHOW_GAPS_KEY, this.showGaps);
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
          case "remove": {
            // El webview puede mandar basura: se queda solo con ids de texto y con tope.
            const ids = Array.isArray(message.ids)
              ? message.ids
                  .filter((id): id is string => typeof id === "string" && id.length > 0)
                  .slice(0, 500)
              : [];
            if (ids.length) {
              await this.handlers.remove(ids);
            }
            break;
          }
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

  /** Avisa al webview del estilo visual vigente. */
  postTheme(): void {
    this.post({ type: "theme", theme: currentTheme() });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
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
${themeLinks(this.extensionUri, webview, ["promptStats.css"])}
<title>Estadísticas de prompts</title>
</head>
<body>
<div class="hud">
  <div class="hud-header">
    <span class="hud-dot"></span>
    <span class="hud-title">ESTADÍSTICAS DE PROMPTS</span>
    <button id="btn-gaps" class="gaps-btn" type="button" aria-pressed="false" aria-label="Mostrar los huecos de tiempo entre prompts" title="Mostrar los huecos de tiempo entre prompts">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 2.5h8M4 13.5h8M4.8 2.5c0 3 3.2 3.4 3.2 5.5s-3.2 2.5-3.2 5.5M11.2 2.5c0 3-3.2 3.4-3.2 5.5s3.2 2.5 3.2 5.5" />
      </svg>
    </button>
    <button id="btn-monitor" class="switch" type="button" aria-pressed="false" aria-label="Monitorizar prompts" title="Escanea y guarda los prompts nuevos mientras el agente trabaja">
      <span class="switch-track"><span class="switch-thumb"></span></span>
      <span class="switch-label">MONITORIZAR</span>
    </button>
    <span id="chip-monitor" class="chip" aria-live="polite">EN PAUSA</span>
    <button id="btn-refresh" class="ghost-btn" type="button" title="Volver a escanear las sesiones del agente">ACTUALIZAR</button>
    <button id="btn-clear" class="ghost-btn" type="button" title="Borra todo el registro guardado de prompts">BORRAR</button>
  </div>

  <p class="sub" id="subtitle">Leyendo prompts…</p>

  <div id="banner" class="banner" hidden></div>
  <div id="notice" class="notice" hidden></div>

  <div class="board">
    <aside class="col col-list">
      <div class="col-head">
        <span class="label">PROMPTS</span>
        <span class="count" id="list-count"></span>
        <span class="head-actions">
          <button id="sel-all" class="link-btn" type="button" title="Marcar todos los prompts de la lista">TODAS</button>
          <button id="sel-none" class="link-btn" type="button" title="Desmarcar todos los prompts">NINGUNA</button>
        </span>
      </div>
      <div id="list" class="list"></div>
    </aside>

    <section class="col col-main">
      <div class="agg">
        <div class="block-head">
          <span class="label">CONJUNTO SELECCIONADO</span>
          <span class="count" id="agg-count"></span>
        </div>
        <div class="kpis" id="kpis"></div>
        <p class="agg-text" id="agg-text" hidden></p>
      </div>

      <div class="panel-block">
        <div class="block-head">
          <span class="label">TRABAJO POR AGENTE</span>
          <span class="block-actions">
            <button id="zoom-out" class="ghost-btn" type="button" aria-label="Alejar" title="Alejar la línea de tiempo">−</button>
            <button id="zoom-in" class="ghost-btn" type="button" aria-label="Acercar" title="Acercar la línea de tiempo">+</button>
            <button id="zoom-fit" class="ghost-btn" type="button" title="Ver la selección completa">AJUSTAR</button>
            <span class="range-label" id="range-label">—</span>
            <span class="zoom-label" id="zoom-label">x1.00</span>
          </span>
        </div>
        <div class="timeline" id="timeline">
          <div class="strip" id="strip"></div>
          <div class="lanes" id="lanes"></div>
          <div class="axis" id="axis" aria-hidden="true"></div>
        </div>
      </div>

      <div class="charts">
        <div class="panel-block">
          <div class="block-head">
            <span class="label">TOKENS POR AGENTE</span>
            <span class="count" id="tokens-max"></span>
          </div>
          <div id="chart-tokens" class="chart"></div>
        </div>
        <div class="panel-block">
          <div class="block-head">
            <span class="label">COSTE POR AGENTE</span>
            <span class="count" id="cost-max"></span>
          </div>
          <div id="chart-cost" class="chart"></div>
        </div>
      </div>

      <div id="empty" class="empty" hidden></div>
    </section>
  </div>
</div>
${themeScript(this.extensionUri, webview, nonce)}
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