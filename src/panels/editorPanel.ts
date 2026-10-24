import * as vscode from "vscode";
import {
  Agent,
  AgentFrontmatter,
  ALL_PERMISSION_TOOLS,
  FLAT_PERMISSION_TOOLS,
  PATTERN_PERMISSION_TOOLS,
  Scope,
} from "../agents/types";
import { findAgent, readConfigInfo, saveAgent } from "../agents/store";
import { validateAgentName, validateFrontmatter, ValidationIssue } from "../agents/validate";
import { projectRoot } from "../agents/paths";

interface EditorInit {
  mode: "create" | "edit";
  name: string;
  scope: Scope;
  targetScope: Scope;
  canRename: boolean;
  source: string;
  filePath?: string;
  frontmatter: AgentFrontmatter;
  prompt: string;
  models: { id: string; name: string }[];
  allTools: readonly string[];
  flatTools: readonly string[];
  patternTools: readonly string[];
  schemaUrl: string;
  hasProject: boolean;
}

export class EditorPanel {
  public static current: EditorPanel | undefined;
  private static readonly viewType = "opencodeAgents.editor";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private init: EditorInit;
  private onSaved?: () => void;
  /** Ids de modelo conocidos; se calcula aquí para no recibirlos del webview en cada tecla. */
  private readonly knownModels: Set<string>;
  dirty = false;

  static async open(
    context: vscode.ExtensionContext,
    agent: Agent,
    opts: { mode: "create" | "edit"; onSaved?: () => void }
  ): Promise<void> {
    const column = vscode.ViewColumn.Beside;

    if (EditorPanel.current?.dirty) {
      const choice = await vscode.window.showWarningMessage(
        `Hay cambios sin guardar en "${EditorPanel.current.init.name}". ¿Descartarlos?`,
        { modal: true },
        "Descartar"
      );
      if (choice !== "Descartar") {
        return;
      }
    }
    if (EditorPanel.current) {
      EditorPanel.current.panel.dispose();
    }

    const config = await readConfigInfo();
    const targetScope: Scope = agent.scope;
    const hasProject = !!projectRoot();

    const init: EditorInit = {
      mode: opts.mode,
      name: agent.name,
      scope: agent.scope,
      targetScope,
      canRename: opts.mode === "edit" && agent.source === "file",
      source: agent.source,
      filePath: agent.filePath,
      frontmatter: agent.frontmatter,
      prompt: agent.prompt,
      models: config.models.map((m) => ({ id: m.id, name: m.name })),
      allTools: ALL_PERMISSION_TOOLS,
      flatTools: FLAT_PERMISSION_TOOLS,
      patternTools: PATTERN_PERMISSION_TOOLS,
      schemaUrl: vscode.workspace
        .getConfiguration("opencodeAgents")
        .get<string>("schemaUrl", "https://opencode.ai/config.json"),
      hasProject,
    };

    const panel = vscode.window.createWebviewPanel(
      EditorPanel.viewType,
      opts.mode === "create" ? `Nuevo agente: ${agent.name}` : `Editar: ${agent.name}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );

    EditorPanel.current = new EditorPanel(panel, context.extensionUri, init, opts.onSaved);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    init: EditorInit,
    onSaved?: () => void
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.init = init;
    this.onSaved = onSaved;
    this.knownModels = new Set(init.models.map((m) => m.id));

    this.panel.webview.html = this.getHtml(this.panel.webview, init.name);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "ready":
            this.post({ type: "init", payload: this.init });
            break;
          case "validate":
            this.handleValidate(message.payload);
            break;
          case "save":
            await this.handleSave(message.payload);
            break;
          case "cancel":
            this.panel.dispose();
            break;
          case "openRaw":
            await this.openRaw();
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

  private computeIssues(payload: {
    name: string;
    frontmatter: AgentFrontmatter;
  }): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (this.init.mode === "create" || this.init.canRename) {
      issues.push(...validateAgentName(payload.name));
    }
    issues.push(...validateFrontmatter(payload.frontmatter, this.knownModels));
    return issues;
  }

  private handleValidate(payload: { name: string; frontmatter: AgentFrontmatter }): void {
    const issues = this.computeIssues(payload);
    this.post({ type: "validation", issues });
  }

  private async handleSave(payload: {
    name: string;
    targetScope: Scope;
    frontmatter: AgentFrontmatter;
    prompt: string;
  }): Promise<void> {
    const issues = this.computeIssues(payload).filter((i) => i.level === "error");
    if (issues.length > 0) {
      this.post({
        type: "saved",
        ok: false,
        message: `No se puede guardar: ${issues.map((i) => i.message).join(" ")}`,
      });
      return;
    }

    // Renombrar escribe un fichero nuevo: no debe machacar el de otro agente.
    if (payload.name !== this.init.name) {
      const clash = await findAgent(payload.name, payload.targetScope);
      if (clash && clash.filePath !== this.init.filePath) {
        this.post({
          type: "saved",
          ok: false,
          message: `Ya existe un agente "${payload.name}" en ese scope.`,
        });
        return;
      }
    }

    try {
      const file = await saveAgent(
        payload.targetScope,
        payload.name,
        payload.frontmatter,
        payload.prompt,
        this.init.filePath
      );
      this.init.filePath = file;
      this.init.name = payload.name;
      this.init.source = "file";
      this.dirty = false;
      this.post({
        type: "saved",
        ok: true,
        message: `Guardado: ${file}`,
        file,
      });
      this.onSaved?.();
      void vscode.window.setStatusBarMessage(
        `opencode agents: guardado ${payload.name}. Reinicia opencode para aplicarlo.`,
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
    if (this.init.filePath) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.init.filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
    void vscode.window.showInformationMessage("Guarda primero el agente para ver el fichero .md.");
  }

  private getHtml(webview: vscode.Webview, name: string): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "editor.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "editor.js")
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
<link href="${styleUri}" rel="stylesheet" />
<title>Editor de agente</title>
</head>
<body>
<div id="app" data-name="${escapeHtml(name)}">
  <header class="head">
    <div>
      <h1 id="title">Editor de agente</h1>
      <p class="sub" id="subtitle"></p>
    </div>
    <div class="head-actions">
      <button id="btn-open-raw" class="secondary" type="button" title="Abrir el .md">Abrir .md</button>
      <button id="btn-cancel" class="secondary" type="button">Cerrar</button>
      <button id="btn-save" class="primary" type="button">Guardar</button>
    </div>
  </header>

  <div id="banner" class="banner" hidden></div>

  <main class="grid">
    <section class="card span-2">
      <h2>Identidad</h2>
      <div class="row">
        <label>Nombre (fichero)
          <input id="f-name" type="text" placeholder="mi-agente" spellcheck="false" />
        </label>
        <label>Scope de destino
          <select id="f-scope">
            <option value="project">Proyecto (.opencode/agent)</option>
            <option value="global">Usuario (~/.config/opencode/agent)</option>
          </select>
        </label>
        <label>Tipo (mode)
          <select id="f-mode">
            <option value="">(por defecto)</option>
            <option value="primary">primary</option>
            <option value="subagent">subagent</option>
            <option value="all">all</option>
          </select>
        </label>
      </div>
      <label class="block">Descripción
        <textarea id="f-description" rows="2" placeholder="Qué hace y cuándo usarlo."></textarea>
      </label>
    </section>

    <section class="card">
      <h2>Modelo</h2>
      <label class="model-label" for="f-model">Modelo (provider/model-id)</label>
      <div class="combo">
        <input id="f-model" type="text" autocomplete="off" spellcheck="false" placeholder="busca provider/model-id…" role="combobox" aria-expanded="false" aria-controls="model-popup" aria-autocomplete="list" />
        <div id="model-popup" class="combo-popup" role="listbox" aria-label="Modelos disponibles" hidden></div>
      </div>
      <p class="hint" id="model-hint"></p>
      <div class="row">
        <label>variant
          <input id="f-variant" type="text" spellcheck="false" placeholder="(opcional)" />
        </label>
        <label>temperature
          <input id="f-temperature" type="number" step="0.05" min="0" max="2" placeholder="(opcional)" />
        </label>
        <label>top_p
          <input id="f-top_p" type="number" step="0.05" min="0" max="1" placeholder="(opcional)" />
        </label>
        <label>steps
          <input id="f-steps" type="number" step="1" min="1" placeholder="(opcional)" />
        </label>
      </div>
    </section>

    <section class="card">
      <h2>Apariencia y estado</h2>
      <div class="row">
        <label>color
          <input id="f-color" type="color" />
        </label>
        <button id="btn-clear-color" class="secondary small" type="button">Quitar color</button>
        <label class="check"><input id="f-hidden" type="checkbox" /> hidden</label>
        <label class="check"><input id="f-disable" type="checkbox" /> disable</label>
      </div>
      <p class="hint" id="color-hint"></p>
    </section>

    <section class="card span-2">
      <h2>Permisos</h2>
      <p class="hint">Acción plana o por patrón. En objetos con patrones, <strong>la última regla que coincide gana</strong>: pon lo amplio primero y lo concreto después.</p>
      <div id="perm-rows"></div>
      <button id="btn-add-perm" class="secondary small" type="button">+ Añadir permiso</button>
      <details class="preview">
        <summary>Vista previa YAML de permission</summary>
        <pre id="perm-preview"></pre>
      </details>
    </section>

    <section class="card span-2">
      <h2>Prompt (system prompt)</h2>
      <p class="hint">El cuerpo del fichero. No incluyas <code>prompt:</code> en el frontmatter.</p>
      <textarea id="f-prompt" class="prompt" rows="18" spellcheck="false" placeholder="Eres un..."></textarea>
    </section>

    <section class="card span-2">
      <h2>Validación</h2>
      <ul id="issues" class="issues"><li class="ok">Sin problemas.</li></ul>
      <p class="hint">Esquema de referencia: <a href="${this.init.schemaUrl}" id="schema-link">${escapeHtml(this.init.schemaUrl)}</a>. Tras guardar, reinicia opencode para aplicar los cambios.</p>
    </section>
  </main>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    EditorPanel.current = undefined;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
