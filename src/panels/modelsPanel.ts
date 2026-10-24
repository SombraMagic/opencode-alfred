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
}

export interface ModelsData {
  models: ModelEntry[];
  /** Modelo de la sesión en marcha; vacío si no hay ninguna. */
  currentModel: string;
  /** Últimos elegidos, el más reciente primero. */
  recentModels: string[];
}

export type ModelsAction = { type: "setModel"; id: string };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>(["setModel"]);

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
    <input id="search" class="model-search" type="search" placeholder="Buscar conector o modelo…" autocomplete="off" spellcheck="false" aria-label="Buscar modelo" />
    <div class="group"><span class="group-name">ACTUAL</span></div>
    <div id="now" class="list"></div>
    <div class="group"><span class="group-name">RECIENTES</span></div>
    <div id="recent" class="list"></div>
    <div class="group"><span class="group-name">TODOS</span><span class="count" id="total"></span></div>
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
