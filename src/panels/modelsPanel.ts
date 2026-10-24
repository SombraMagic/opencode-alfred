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
  | { type: "openAssign" };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "setModel",
  "clearModel",
  "setSubagentModel",
  "clearSubagentModel",
  "openAssign",
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
    <div id="head" class="models-head" hidden>
      <div id="title" class="models-title" hidden></div>
      <div id="tags" class="models-tags" hidden>
        <button id="t-main" class="tag on" type="button" aria-pressed="true">PRINCIPAL</button>
        <button id="t-sub" class="tag" type="button" aria-pressed="false">SUBAGENTES</button>
      </div>
    </div>
    <button id="assign" class="assign-btn" type="button" title="Asignar agentes a modelos" hidden>ASIGNAR AGENTES</button>
    <input id="search" class="model-search" type="search" placeholder="Buscar conector o modelo…" autocomplete="off" spellcheck="false" aria-label="Buscar modelo" />
    <div class="group"><span class="group-name">ACTUAL</span><button id="clear" type="button" hidden>SIN FIJAR</button></div>
    <div id="now" class="list"></div>
    <div id="note" class="note" hidden></div>
    <div id="groups" hidden></div>
    <div id="recent-group" class="group"><span class="group-name">RECIENTES</span></div>
    <div id="recent" class="list"></div>
    <div id="all-group" class="group"><span class="group-name">TODOS</span><span class="count" id="total"></span></div>
    <div id="all" class="list scroll"></div>
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
