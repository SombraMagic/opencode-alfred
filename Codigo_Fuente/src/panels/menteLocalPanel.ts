import * as vscode from "vscode";
import type { MenteLocalAction, MenteLocalState } from "../ollama/service";

/** Acciones que el webview tiene permitido pedir: la lista de `MenteLocalAction`. */
const ACTION_TYPES = new Set<string>([
  "refresh",
  "setEnabled",
  "install",
  "uninstall",
  "pull",
  "cancelPull",
  "delete",
  "setModel",
  "setBaseURL",
  "startServer",
  "stopServer",
  "openModelsDir",
]);

const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;

/** El webview no es de fiar: nada llega al servicio sin pasar por aquí. */
function parseAction(raw: unknown): MenteLocalAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
  if (typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  const model = typeof action.model === "string" ? action.model.trim() : "";
  switch (action.type) {
    case "refresh":
    case "install":
    case "uninstall":
    case "cancelPull":
    case "startServer":
    case "stopServer":
    case "openModelsDir":
      return { type: action.type };
    case "setEnabled":
      return typeof action.on === "boolean"
        ? { type: "setEnabled", on: action.on }
        : undefined;
    case "pull":
    case "delete":
      return MODEL_RE.test(model) ? { type: action.type, model } : undefined;
    case "setModel":
      return model === "" || MODEL_RE.test(model)
        ? { type: "setModel", model }
        : undefined;
    case "setBaseURL": {
      const url = typeof action.url === "string" ? action.url.trim() : "";
      return /^https?:\/\//.test(url) && url.length <= 200
        ? { type: "setBaseURL", url }
        : undefined;
    }
  }
  return undefined;
}

export interface MenteLocalPanelHandlers {
  onAction(action: MenteLocalAction): void;
  onReady(): void;
}

export class MenteLocalPanel {
  public static current: MenteLocalPanel | undefined;
  private static readonly viewType = "opencodeAgents.menteLocal";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: MenteLocalPanelHandlers;
  private last?: MenteLocalState;

  static open(
    context: vscode.ExtensionContext,
    state: MenteLocalState,
    handlers: MenteLocalPanelHandlers
  ): MenteLocalPanel {
    if (MenteLocalPanel.current) {
      MenteLocalPanel.current.handlers = handlers;
      MenteLocalPanel.current.panel.reveal(vscode.ViewColumn.Active);
      MenteLocalPanel.current.update(state);
      return MenteLocalPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      MenteLocalPanel.viewType,
      "Mente local (Ollama)",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    MenteLocalPanel.current = new MenteLocalPanel(panel, context.extensionUri, handlers);
    MenteLocalPanel.current.update(state);
    return MenteLocalPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    handlers: MenteLocalPanelHandlers
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.handlers = handlers;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string }) => {
        if (message?.type === "ready") {
          if (this.last) {
            this.post({ type: "state", state: this.last });
          }
          this.handlers.onReady();
          return;
        }
        const action = parseAction(message);
        if (!action) {
          return;
        }
        this.handlers.onAction(action);
      },
      null,
      this.disposables
    );
  }

  update(state: MenteLocalState): void {
    this.last = state;
    this.post({ type: "state", state });
  }

  updateLive(patch: Pick<MenteLocalState, "busy" | "pull" | "message">): void {
    if (!this.last) {
      return;
    }
    this.last = { ...this.last, ...patch };
    this.post({ type: "state", state: this.last });
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
      vscode.Uri.joinPath(this.extensionUri, "media", "menteLocal.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "menteLocal.js")
    );
    const csp = webview.cspSource;

    // HUD del cerebro local: interruptor, resumen, modelos, descarga, instalación y servidor.
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${tokensUri}">
<link rel="stylesheet" href="${styleUri}">
<title>Mente local</title>
</head>
<body>
<header class="hud-header">
  <h1 class="hud-title">MENTE LOCAL</h1>
  <button id="power" class="power" type="button" aria-pressed="false" title="Encender o apagar el cerebro local (Ollama)">
    <span id="power-dot" class="power-dot off" aria-hidden="true"></span>
    <span id="power-text">APAGADA</span>
  </button>
</header>

<p class="resumen" id="resumen">Leyendo…</p>
<p class="aviso" id="aviso" role="status" aria-live="polite" hidden></p>

<main class="cuerpo">
  <section class="bloque" id="bloque-modelos" aria-labelledby="h-modelos">
    <div class="bloque-head">
      <h2 class="bloque-title" id="h-modelos">MODELOS</h2>
      <span class="count" id="modelos-count"></span>
      <div class="orden" role="group" aria-label="Orden de la lista">
        <button type="button" class="ord" data-orden="nombre" aria-pressed="true">NOMBRE</button>
        <button type="button" class="ord" data-orden="tamano" aria-pressed="false">TAMAÑO</button>
        <button type="button" class="ord" data-orden="recientes" aria-pressed="false">RECIENTES</button>
      </div>
      <input id="filtro" class="campo campo-filtro" type="search" placeholder="Filtrar…" spellcheck="false" autocomplete="off" aria-label="Filtrar modelos">
    </div>
    <ul class="modelos" id="modelos"></ul>
    <p class="vacio" id="modelos-vacio" hidden></p>
  </section>

  <section class="bloque" id="bloque-descargar" aria-labelledby="h-descargar">
    <div class="bloque-head">
      <h2 class="bloque-title" id="h-descargar">DESCARGAR</h2>
    </div>
    <div class="fila">
      <input id="modelo" class="campo" type="text" placeholder="qwen3.5:9b" spellcheck="false" autocomplete="off" aria-label="Modelo a descargar" title="Nombre y etiqueta del modelo, por ejemplo qwen3.5:9b">
      <button id="descargar" class="btn" type="button" disabled>DESCARGAR</button>
    </div>
    <div class="pull" id="pull" hidden>
      <div class="pull-head">
        <span class="pull-model" id="pull-model"></span>
        <span class="pull-pct" id="pull-pct"></span>
        <button id="cancelar" class="btn mini danger" type="button" title="Corta la descarga en curso; lo descargado se queda a medias" hidden>CANCELAR</button>
      </div>
      <div class="bar" id="pull-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Progreso de la descarga">
        <span class="bar-fill" id="pull-fill"></span>
      </div>
      <div class="pull-foot">
        <span class="pull-status" id="pull-status"></span>
        <span class="pull-bytes" id="pull-bytes"></span>
      </div>
    </div>
  </section>

  <section class="bloque" id="bloque-instalar" aria-labelledby="h-instalar">
    <div class="bloque-head">
      <h2 class="bloque-title" id="h-instalar">INSTALACIÓN</h2>
      <button id="refrescar" class="btn mini" type="button" title="Volver a leer el estado de Ollama">REFRESCAR</button>
    </div>
    <div id="instalar-si-no" hidden>
      <p class="pista">Ollama no está en este equipo. Se instala con winget y necesita alrededor de 1 GB, sin contar los modelos.</p>
      <div class="fila">
        <button id="instalar" class="btn" type="button" title="Instala Ollama con winget">INSTALAR</button>
      </div>
    </div>
    <div id="instalar-si" hidden>
      <div class="fila">
        <button id="desinstalar" class="btn danger" type="button" data-confirm="desinstalar" data-label="DESINSTALAR" title="Desinstala Ollama. Los modelos se quedan en disco.">DESINSTALAR</button>
        <button id="abrirCarpeta" class="btn" type="button" title="Abrir la carpeta de modelos en el explorador del sistema">ABRIR CARPETA</button>
      </div>
      <p class="ruta" id="ruta-modelos"></p>
      <p class="pista">Desinstalar no borra los modelos: se quedan en la carpeta de arriba.</p>
    </div>
  </section>

  <section class="bloque" id="bloque-servidor" aria-labelledby="h-servidor">
    <div class="bloque-head">
      <h2 class="bloque-title" id="h-servidor">SERVIDOR</h2>
    </div>
    <div class="fila">
      <input id="servidor" class="campo" type="text" spellcheck="false" autocomplete="off" aria-label="URL del servidor Ollama">
      <button id="guardarServidor" class="btn" type="button" disabled>GUARDAR</button>
    </div>
    <div class="fila">
      <button id="arrancarServidor" class="btn" type="button" title="Arranca el servidor de Ollama sin tocar el proveedor de opencode">ARRANCAR</button>
      <button id="pararServidor" class="btn" type="button" title="Para el servidor de Ollama. El proveedor de opencode no se toca.">PARAR</button>
    </div>
    <p class="pista" id="servidor-pista">La dirección debe empezar por http:// o https://.</p>
  </section>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** Suelta el singleton al cerrarse, sin volver a disponer el panel. */
  private release(): void {
    if (MenteLocalPanel.current === this) {
      MenteLocalPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
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
