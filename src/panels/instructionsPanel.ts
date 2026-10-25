import * as vscode from "vscode";
import { AgentsMdFile, readAgentsMd, saveAgentsMd } from "../agents/store";
import { Scope } from "../agents/types";

/**
 * Panel propio para el AGENTS.md (global o de proyecto). No comparte formulario con el
 * editor de agentes: aquí solo hay un textarea con el fichero entero.
 */
export class InstructionsPanel {
  private static readonly panels = new Map<Scope, InstructionsPanel>();
  private static readonly viewType = "opencodeAgents.instructions";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly scope: Scope;
  private readonly disposables: vscode.Disposable[] = [];
  private data: AgentsMdFile;
  private onSaved?: () => void;
  dirty = false;

  static async open(
    context: vscode.ExtensionContext,
    scope: Scope,
    opts?: { onSaved?: () => void }
  ): Promise<void> {
    const label = scope === "global" ? "global" : "proyecto";
    const current = InstructionsPanel.panels.get(scope);
    if (current?.dirty) {
      const choice = await vscode.window.showWarningMessage(
        `Hay cambios sin guardar en AGENTS.md (${label}). ¿Descartarlos?`,
        { modal: true },
        "Descartar"
      );
      if (choice !== "Descartar") {
        return;
      }
    }
    current?.panel.dispose();

    let data: AgentsMdFile;
    try {
      data = await readAgentsMd(scope);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo leer AGENTS.md: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InstructionsPanel.viewType,
      `Editar: AGENTS.md (${label})`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );

    InstructionsPanel.panels.set(
      scope,
      new InstructionsPanel(panel, context.extensionUri, scope, data, opts?.onSaved)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    scope: Scope,
    data: AgentsMdFile,
    onSaved?: () => void
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.scope = scope;
    this.data = data;
    this.onSaved = onSaved;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "ready":
            this.post({
              type: "init",
              payload: { file: this.data.file, exists: this.data.exists, text: this.data.text },
            });
            break;
          case "save":
            await this.handleSave(message.payload);
            break;
          case "openRaw":
            await this.openRaw();
            break;
          case "cancel":
            this.panel.dispose();
            break;
          case "dirty":
            this.dirty = !!message.value;
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async handleSave(payload?: { text?: string }): Promise<void> {
    const text = typeof payload?.text === "string" ? payload.text : "";
    try {
      const file = await saveAgentsMd(this.scope, text, this.data.eol);
      this.data = { file, exists: true, text, eol: this.data.eol };
      this.dirty = false;
      this.post({ type: "saved", ok: true, message: `Guardado: ${file}` });
      this.onSaved?.();
      void vscode.window.setStatusBarMessage(
        "opencode: AGENTS.md guardado. Reinicia opencode para aplicarlo.",
        6000
      );
    } catch (err) {
      this.post({
        type: "saved",
        ok: false,
        message: `Error al guardar: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async openRaw(): Promise<void> {
    if (!this.data.exists) {
      void vscode.window.showInformationMessage("Guarda primero para crear el fichero.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.data.file));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const global = this.scope === "global";
    const heading = global
      ? "Instrucciones globales (AGENTS.md)"
      : "Instrucciones del proyecto (AGENTS.md)";
    const hint = global
      ? "Es el AGENTS.md global de opencode. Tras guardar, reinicia opencode para aplicarlo."
      : "Es el AGENTS.md de la raíz del proyecto abierto. Tras guardar, reinicia opencode para aplicarlo.";
    const placeholder = global
      ? "Escribe aquí las instrucciones globales de opencode…"
      : "Escribe aquí las instrucciones del proyecto para opencode…";
    const targets = global
      ? "Instrucciones para todos los agentes"
      : "Instrucciones para los agentes de este proyecto";
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "editor.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "instructions.js")
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
<title>${heading}</title>
</head>
<body>
<div id="app">
  <header class="head">
    <div>
      <h1>${heading}</h1>
      <p class="sub" id="subtitle"></p>
    </div>
    <div class="head-actions">
      <button id="btn-open-raw" class="secondary" type="button" title="Abrir el AGENTS.md en el editor">Abrir .md</button>
      <button id="btn-cancel" class="secondary" type="button">Cerrar</button>
      <button id="btn-save" class="primary" type="button">Guardar</button>
    </div>
  </header>

  <div id="banner" class="banner" hidden></div>

  <main class="grid">
    <section class="card span-2">
      <h2>Contenido</h2>
      <label class="block">${targets}
        <textarea id="f-text" class="prompt" rows="24" spellcheck="false" placeholder="${placeholder}"></textarea>
      </label>
      <p class="hint">${hint}</p>
    </section>
  </main>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    InstructionsPanel.panels.delete(this.scope);
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
