import * as vscode from "vscode";

export interface ModelEntry {
  /** proveedor/modelo: la misma forma que usa `session_v2.model`. */
  id: string;
  provider: string;
  /** Id del modelo dentro del conector, sin el prefijo. */
  model: string;
  name: string;
  /** Todas las tarifas a cero: el modelo no cuesta nada. */
  free: boolean;
  /** Texto corto a la derecha de la fila (mapeo de un alias, «visto»...). */
  hint?: string;
}

export interface ModelGroup {
  name: string;
  models: ModelEntry[];
}

export interface ModelsData {
  models: ModelEntry[];
  /** Modelo de la sesión en marcha; vacío si no hay ninguna. */
  currentModel: string;
  /** Últimos elegidos, el más reciente primero. */
  recentModels: string[];
  /** Cabecera del panel, p. ej. «CLAUDE · api.deepseek.com». */
  title?: string;
  /** Una línea con la procedencia del modelo actual. */
  note?: string;
  /** Si viene, el panel pinta estos grupos en vez de RECIENTES/TODOS. */
  groups?: ModelGroup[];
  /** Hay algo fijado en settings.json que se puede borrar. */
  clearable?: boolean;
  /** Modelo de subagentes; si no viene, el panel no muestra el selector. */
  subagent?: {
    model: string;
    /** `settings`, `entorno` o `principal` (hereda). */
    source: string;
    clearable: boolean;
  };
  /** El proveedor activo admite asignar agentes a modelos (solo opencode). */
  canAssign?: boolean;
}

export type ModelsAction =
  | { type: "setModel"; id: string }
  | { type: "clearModel" }
  | { type: "setSubagentModel"; id: string }
  | { type: "clearSubagentModel" }
  | { type: "openAssign" }
  | { type: "openConnectors" };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "setModel",
  "clearModel",
  "setSubagentModel",
  "clearSubagentModel",
  "openAssign",
  "openConnectors",
]);

export class ModelsPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeAgents.models";

  private view?: vscode.WebviewView;
  private last?: ModelsData;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: {
      onAction(action: ModelsAction): void | Promise<void>;
      onReady(): void;
    }
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message: { type?: string; action?: ModelsAction }) => {
      if (message?.type === "ready") {
        if (this.last) {
          this.post(this.last);
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
      void this.handlers.onAction(action);
    });

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });

    // El webview tiene que pedir los datos: al montarse manda "ready".
    if (this.last) {
      this.post(this.last);
    }
  }

  update(data: ModelsData): void {
    this.last = data;
    if (this.view) {
      this.post(data);
    }
  }

  private post(data: ModelsData): void {
    void this.view?.webview.postMessage({ type: "models", payload: data });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "models.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "models.js")
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
<title>Modelos</title>
</head>
<body>
<div class="hud">
  <div class="models">
    <div id="actions" class="panel-actions" hidden>
      <button id="connectors" class="assign-btn" type="button" title="Gestionar los conectores de opencode">CONECTORES</button>
      <button id="assign" class="assign-btn" type="button" title="Asignar agentes a modelos" hidden>ASIGNAR AGENTES</button>
    </div>
    <div id="head" class="models-head" hidden>
      <div id="title" class="models-title" hidden></div>
      <div id="tags" class="models-tags" hidden>
        <button id="t-main" class="tag on" type="button" aria-pressed="true">PRINCIPAL</button>
        <button id="t-sub" class="tag" type="button" aria-pressed="false">SUBAGENTES</button>
      </div>
    </div>
    <div class="current-row">
      <div class="group">
        <span class="group-name">ACTUAL</span>
        <div id="now"></div>
        <button id="clear" type="button" hidden>SIN FIJAR</button>
        <button id="recent-btn" class="pop-btn" type="button" aria-expanded="false" title="Modelos recientes" aria-label="Modelos recientes">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button id="search-btn" class="pop-btn" type="button" aria-expanded="false" title="Buscar modelos" aria-label="Buscar modelos">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M15 15l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div id="recent-pop" class="pop" hidden>
        <div id="recent" class="list"></div>
      </div>
      <div id="search-pop" class="pop" hidden>
        <div class="pop-search">
          <input id="search" class="model-search" type="search" placeholder="Buscar conector o modelo…" autocomplete="off" spellcheck="false" aria-label="Buscar modelo" />
          <span id="total" class="count"></span>
        </div>
        <div id="groups" hidden></div>
        <div id="all" class="list" hidden></div>
      </div>
    </div>
    <div id="note" class="note" hidden></div>
  </div>
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
