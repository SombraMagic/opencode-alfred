import * as vscode from "vscode";

export type ExplorerScope = "project" | "global";

export interface ExplorerAgent {
  name: string;
  mode: "primary" | "subagent" | "builtin";
  scope: ExplorerScope | "builtin";
  description?: string;
  model?: string;
  color?: string;
  disabled?: boolean;
  shadowed?: boolean;
  overriddenBy?: string[];
  filePath?: string;
  working: boolean;
  streaming: boolean;
  tokens: number;
  workMs: number;
  cost: number;
  /** Tokens históricos del agente. Opcional: los proveedores que aún no los miden no lo mandan. */
  tokensTotal?: number;
  /** Tokens de la última sesión del agente. Opcional, como `tokensTotal`. */
  tokensSession?: number;
}

export interface ExplorerCatalogItem {
  name: string;
  scope: ExplorerScope;
  enabled: boolean;
  detail?: string;
  filePath?: string;
  /** false = no se puede activar ni desactivar; la fila no se pulsa. */
  toggleable?: boolean;
}

export interface ExplorerData {
  hasProject: boolean;
  agents: { project: ExplorerAgent[]; global: ExplorerAgent[]; builtin: ExplorerAgent[] };
  mcp: ExplorerCatalogItem[];
  skills: ExplorerCatalogItem[];
  plugins: ExplorerCatalogItem[];
  totals: { tokens: number; workMs: number; cost: number; working: number };
  autoAccept: boolean;
  /** Agente elegido en el selector de sesión. */
  sessionAgent: string;
  /** Agentes instalados, en el orden del selector: las flechas solo recorren estos. */
  sessionAgents: string[];
}

export type ExplorerAction =
  | { type: "editInstructions"; scope: ExplorerScope }
  | { type: "openLastSession" }
  | { type: "createAgent"; mode: "primary" | "subagent" }
  | { type: "editAgent"; name: string; scope: ExplorerScope | "builtin" }
  | { type: "openAgentFile"; name: string; scope: ExplorerScope | "builtin" }
  | { type: "toggleMcp"; name: string; scope: ExplorerScope }
  | { type: "toggleSkill"; name: string; scope: ExplorerScope }
  | { type: "togglePlugin"; name: string; scope: ExplorerScope }
  | { type: "addPlugin" }
  | { type: "setAutoAccept"; on: boolean }
  | { type: "cycleAgent"; delta: 1 | -1 };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "editInstructions",
  "openLastSession",
  "createAgent",
  "editAgent",
  "openAgentFile",
  "toggleMcp",
  "toggleSkill",
  "togglePlugin",
  "addPlugin",
  "setAutoAccept",
  "cycleAgent",
]);

export class ExplorerPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeAgents.view";

  private view?: vscode.WebviewView;
  private last?: ExplorerData;
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

    view.webview.onDidReceiveMessage((message: { type?: string; action?: ExplorerAction }) => {
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
      const action = message.action;
      if (!action || typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
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

  update(data: ExplorerData): void {
    this.last = data;
    if (this.view && this.ready) {
      this.post(data);
    }
  }

  private post(data: ExplorerData): void {
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
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "explorer.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    // Un solo cerebro para los dos botones: ahorra HTML duplicado.
    const brain = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M6.3 2.3a2 2 0 0 0-2 1.9 2 2 0 0 0-1.1 3.6 2 2 0 0 0 1.4 3.4 2 2 0 0 0 3.3 1.4V3.2a1.7 1.7 0 0 0-1.6-.9Z"/><path d="M9.7 2.3a2 2 0 0 1 2 1.9 2 2 0 0 1 1.1 3.6 2 2 0 0 1-1.4 3.4 2 2 0 0 1-3.3 1.4V3.2a1.7 1.7 0 0 1 1.6-.9Z"/><path d="M4.7 5.4h1.5M4.3 9.1h1.7M11.3 5.4H9.8M11.7 9.1H10"/></svg>`;

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${tokensUri}" rel="stylesheet" />
<link href="${styleUri}" rel="stylesheet" />
<title>ALFRED // CONTROL</title>
</head>
<body>
<div class="hud">
  <!-- [MANDO] Dos filas: AGENTS.md + sesión, y el interruptor de permisos. -->
  <div class="mando">
    <div class="mando-row">
      <button id="btn-global" class="brain-btn" type="button" title="Editar el AGENTS.md global">${brain}<span>GLOBAL</span></button>
      <button id="btn-local" class="brain-btn" type="button" title="Editar el AGENTS.md del proyecto" disabled>${brain}<span>PROYECTO</span></button>
      <div class="session-group">
        <button id="agent-prev" class="agent-arrow" type="button" title="Agente anterior" aria-label="Agente anterior" disabled>‹</button>
        <button id="btn-session" class="ghost-btn session-btn" type="button" title="Abrir o enfocar la terminal de opencode; las flechas cambian de agente"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" fill-rule="evenodd" clip-rule="evenodd"></path></svg><span id="agent-label" hidden>OPEN</span></button>
        <button id="agent-next" class="agent-arrow" type="button" title="Agente siguiente" aria-label="Agente siguiente" disabled>›</button>
      </div>
    </div>
    <div class="mando-row">
      <button id="btn-auto-accept" class="switch perm-switch" type="button" aria-pressed="false" title="Aceptar sin preguntar lo que el agente pida. Las reglas «deny» siguen bloqueando; se aplica al momento.">
        <span class="switch-track"><span class="switch-thumb"></span></span>
        <span class="perm-label">ACEPTAR TODO SIN PREGUNTAR</span>
        <span class="chip" id="perm-state" hidden>AUTO</span>
      </button>
    </div>
  </div>

  <div id="banner" class="banner" hidden></div>

  <section class="section">
    <div class="section-head">
      <span class="label">EXPLORADOR</span>
      <span class="count" id="agents-total"></span>
    </div>
    <details class="fold" open>
      <summary>AGENTES DE PROYECTO <span class="count" id="agents-project-count">0</span></summary>
      <div id="agents-project" class="list"></div>
    </details>
    <details class="fold" open>
      <summary>AGENTES GLOBALES <span class="count" id="agents-global-count">0</span></summary>
      <div id="agents-global" class="list"></div>
    </details>
  </section>

  <section class="section">
    <div class="area-head">
      <span class="area-name">MCP</span>
      <span class="legend">GLOBAL <span class="count" id="mcp-global-count">0</span> · PROYECTO <span class="count" id="mcp-project-count">0</span></span>
    </div>
    <div class="cols">
      <div id="mcp-global" class="list"></div>
      <div id="mcp-project" class="list"></div>
    </div>

    <div class="area-head">
      <span class="area-name">PLUGINS</span>
      <span class="legend">GLOBAL <span class="count" id="plugins-global-count">0</span> · PROYECTO <span class="count" id="plugins-project-count">0</span></span>
      <button id="btn-add-plugin" class="ghost-btn add-plugin" type="button">+ PLUGIN</button>
    </div>
    <div class="cols">
      <div id="plugins-global" class="list"></div>
      <div id="plugins-project" class="list"></div>
    </div>

    <details class="fold">
      <summary>SKILLS GLOBALES <span class="count" id="skills-global-count">0</span></summary>
      <div id="skills-global" class="list"></div>
    </details>
    <details class="fold">
      <summary>SKILLS PROYECTO <span class="count" id="skills-project-count">0</span></summary>
      <div id="skills-project" class="list"></div>
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
