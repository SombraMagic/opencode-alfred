import * as vscode from "vscode";
import { AgentFrontmatter } from "../agents/types";
import { deleteAgent } from "../agents/store";
import { ValidationIssue } from "../agents/validate";
import {
  CLAUDE_AGENT_COLORS,
  CLAUDE_AGENT_TOOLS,
  ClaudeAgentFields,
  ClaudeScope,
  claudeAgentText,
  claudeModelAliases,
  readClaudeAgent,
  saveClaudeAgent,
  validateClaudeAgent,
} from "../providers/claude";

export interface ClaudeAgentOpenOptions {
  mode: "create" | "edit";
  name?: string;
  scope: ClaudeScope;
  filePath?: string;
  projectRoot: string | undefined;
  onSaved: () => void;
}

interface ClaudeAgentInit {
  mode: "create" | "edit";
  name: string;
  scope: ClaudeScope;
  filePath?: string;
  fields: ClaudeAgentFields;
  prompt: string;
  /** YAML del frontmatter, sin el cuerpo. */
  preview: string;
  models: { alias: string; mapped: string }[];
  colors: string[];
  toolsCatalog: string[];
  hasProject: boolean;
}

interface ClaudeAgentMessage {
  type?: string;
  value?: boolean;
  payload?: {
    name?: string;
    scope?: ClaudeScope;
    fields?: ClaudeAgentFields;
    prompt?: string;
  };
}

function emptyFields(): ClaudeAgentFields {
  return {
    description: "",
    tools: [],
    model: "",
    color: "",
    permissionMode: "",
    effort: "",
    skills: [],
    memory: "",
    isolation: "",
    omitClaudeMd: false,
    background: false,
  };
}

export class ClaudeAgentPanel {
  public static current: ClaudeAgentPanel | undefined;
  private static readonly viewType = "opencodeAgents.claudeAgent";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly projectRoot: string | undefined;
  private readonly onSaved?: () => void;
  /** Frontmatter original: sus claves no gestionadas se conservan en cada guardado. */
  private readonly original: AgentFrontmatter | undefined;
  private init: ClaudeAgentInit;
  private filePath: string | undefined;
  /** Último nombre que mandó el webview: `init.name` solo se actualiza al guardar. */
  private currentName: string;
  dirty = false;

  static async open(
    context: vscode.ExtensionContext,
    opts: ClaudeAgentOpenOptions
  ): Promise<void> {
    if (ClaudeAgentPanel.current?.dirty) {
      const current = ClaudeAgentPanel.current;
      const choice = await vscode.window.showWarningMessage(
        `Hay cambios sin guardar en "${current.currentName || "nuevo subagente"}". ¿Descartarlos?`,
        { modal: true },
        "Descartar"
      );
      if (choice !== "Descartar") {
        return;
      }
    }

    let name = opts.name ?? "";
    let fields = emptyFields();
    let prompt = "";
    let original: AgentFrontmatter | undefined;
    if (opts.mode === "edit" && opts.filePath) {
      let data;
      try {
        data = readClaudeAgent(opts.filePath);
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }
      name = data.name;
      fields = data.fields;
      prompt = data.prompt;
      original = data.frontmatter;
    }

    if (ClaudeAgentPanel.current) {
      ClaudeAgentPanel.current.panel.dispose();
    }

    const init: ClaudeAgentInit = {
      mode: opts.mode,
      name,
      scope: opts.scope,
      filePath: opts.filePath,
      fields,
      prompt,
      preview: claudeAgentText(name, original, fields, ""),
      models: claudeModelAliases(),
      colors: [...CLAUDE_AGENT_COLORS],
      toolsCatalog: [...CLAUDE_AGENT_TOOLS],
      hasProject: !!opts.projectRoot,
    };

    const panel = vscode.window.createWebviewPanel(
      ClaudeAgentPanel.viewType,
      opts.mode === "create" ? "Nuevo subagente de Claude" : `Subagente: ${name}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );

    ClaudeAgentPanel.current = new ClaudeAgentPanel(
      panel,
      context.extensionUri,
      init,
      opts.projectRoot,
      original,
      opts.onSaved
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    init: ClaudeAgentInit,
    projectRoot: string | undefined,
    original: AgentFrontmatter | undefined,
    onSaved?: () => void
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.init = init;
    this.projectRoot = projectRoot;
    this.original = original;
    this.filePath = init.filePath;
    this.currentName = init.name;
    this.onSaved = onSaved;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: ClaudeAgentMessage) => {
        switch (message.type) {
          case "ready":
            this.post({ type: "init", payload: this.init });
            break;
          case "validate":
            this.handleValidate(message);
            break;
          case "save":
            await this.handleSave(message);
            break;
          case "cancel":
            this.panel.dispose();
            break;
          case "delete":
            await this.handleDelete();
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

  /** Datos del mensaje, con el estado actual como respaldo si el webview omite algo. */
  private payloadOf(message: ClaudeAgentMessage): {
    name: string;
    scope: ClaudeScope;
    fields: ClaudeAgentFields;
    prompt: string;
  } {
    const payload = message.payload ?? {};
    const name = typeof payload.name === "string" ? payload.name : this.init.name;
    this.currentName = name;
    return {
      name,
      scope:
        payload.scope === "project" || payload.scope === "global"
          ? payload.scope
          : this.init.scope,
      fields: payload.fields ?? this.init.fields,
      prompt: typeof payload.prompt === "string" ? payload.prompt : this.init.prompt,
    };
  }

  private previewOf(name: string, fields: ClaudeAgentFields): string {
    return claudeAgentText(name, this.original, fields, "");
  }

  private handleValidate(message: ClaudeAgentMessage): void {
    const { name, scope, fields } = this.payloadOf(message);
    const issues: ValidationIssue[] = validateClaudeAgent(
      name,
      fields,
      scope,
      this.projectRoot,
      this.filePath
    );
    this.post({ type: "validation", issues, preview: this.previewOf(name, fields) });
  }

  private async handleSave(message: ClaudeAgentMessage): Promise<void> {
    const { name, scope, fields, prompt } = this.payloadOf(message);
    const errors = validateClaudeAgent(name, fields, scope, this.projectRoot, this.filePath).filter(
      (issue) => issue.level === "error"
    );
    if (errors.length > 0) {
      this.post({
        type: "saved",
        ok: false,
        message: `No se puede guardar: ${errors.map((issue) => issue.message).join(" ")}`,
      });
      return;
    }

    try {
      const saved = await saveClaudeAgent(
        scope,
        name,
        fields,
        prompt,
        this.projectRoot,
        this.filePath
      );
      this.filePath = saved.file;
      this.init.filePath = saved.file;
      this.init.mode = "edit";
      this.init.name = name;
      this.init.scope = scope;
      this.init.fields = fields;
      this.init.prompt = prompt;
      this.init.preview = this.previewOf(name, fields);
      this.dirty = false;
      this.panel.title = `Subagente: ${name}`;
      this.post({ type: "saved", ok: true, message: `Guardado: ${saved.file}`, file: saved.file });
      this.onSaved?.();
      // Claude vigila las carpetas de agentes y recarga solo; el reinicio únicamente hace
      // falta si la carpeta no existía al arrancar la sesión.
      const hint = saved.createdDir
        ? " La carpeta agents es nueva: reinicia Claude para que lo cargue."
        : "";
      void vscode.window.setStatusBarMessage(`Claude: guardado ${name}.${hint}`, 6000);
    } catch (err) {
      this.post({
        type: "saved",
        ok: false,
        message: `Error al guardar: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Borra el .md del disco, avisa al resto de componentes y cierra el panel. */
  private async handleDelete(): Promise<void> {
    const file = this.filePath;
    const name = this.init.name || this.currentName || "nuevo subagente";
    if (!file) {
      void vscode.window.showInformationMessage(
        `Nada que borrar: aún no existe el fichero del subagente "${name}".`
      );
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `¿Borrar el subagente "${name}"? Se elimina ${file} del disco y el subagente deja de existir.` +
        (this.dirty ? " Se pierden los cambios sin guardar." : ""),
      { modal: true },
      "Borrar"
    );
    if (choice !== "Borrar") {
      return;
    }

    try {
      await deleteAgent(file);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.post({ type: "saved", ok: false, message: `Error al borrar: ${text}` });
      void vscode.window.showErrorMessage(`No se pudo borrar ${file}: ${text}`);
      return;
    }

    this.dirty = false;
    this.onSaved?.();
    void vscode.window.setStatusBarMessage(
      `Claude: borrado ${name}. Claude vigila la carpeta agents y recarga solo.`,
      6000
    );
    this.panel.dispose();
  }

  private async openRaw(): Promise<void> {
    if (this.filePath) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
    void vscode.window.showInformationMessage(
      "Guarda primero el agente para ver el fichero .md."
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "claudeAgent.css")
    );
    const mdStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "mdEditor.css")
    );
    const mdScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "mdEditor.js")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "claudeAgent.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
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
<link href="${mdStyleUri}" rel="stylesheet" />
<title>Subagente de Claude</title>
</head>
<body>
<div id="app">
  <header class="head">
    <div>
      <h1 id="title">Subagente de Claude</h1>
      <p class="sub" id="subtitle">Subagente de Claude</p>
    </div>
    <div class="head-actions">
      <button id="btn-open-raw" class="secondary" type="button" title="Abrir el .md">Abrir .md</button>
      <button id="btn-delete" class="secondary danger" type="button" title="Borrar el fichero del subagente">Borrar</button>
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
          <input id="f-name" type="text" placeholder="mi-subagente" spellcheck="false" autocomplete="off" />
        </label>
        <label>Scope de destino
          <select id="f-scope">
            <option value="project">PROYECTO (.claude/agents)</option>
            <option value="global">USUARIO (~/.claude/agents)</option>
          </select>
        </label>
      </div>
      <label class="block">Descripción
        <textarea id="f-description" rows="2" placeholder="Qué hace y cuándo debe usarlo Claude. Obligatoria."></textarea>
      </label>
      <p class="hint">Sin descripción, Claude omite el agente.</p>
    </section>

    <section class="card span-2">
      <h2>Herramientas</h2>
      <p class="hint" id="tools-hint">Sin ninguna marcada, el subagente hereda todas las herramientas disponibles.</p>
      <div id="tools-known" class="chips"></div>
      <div class="row">
        <label>Otra herramienta
          <input id="f-tool-add" type="text" spellcheck="false" placeholder="mcp__servidor__* o Agent(explore)" />
        </label>
        <button id="btn-tool-add" class="secondary small" type="button">Añadir</button>
        <button id="btn-tools-all" class="secondary small" type="button">Todas</button>
        <button id="btn-tools-read" class="secondary small" type="button">Solo lectura</button>
      </div>
      <div id="tools-extra" class="chips"></div>
    </section>

    <section class="card">
      <h2>Modelo</h2>
      <div class="row">
        <label>model
          <!-- El JS rellena este desplegable con los alias y su mapeo. -->
          <select id="f-model">
            <option value="">(heredado)</option>
          </select>
        </label>
        <label id="row-model-custom">id completo
          <input id="f-model-custom" type="text" spellcheck="false" placeholder="claude-opus-5-5" />
        </label>
      </div>
      <p class="hint" id="model-hint">Omitido, hereda el modelo del subagente y, si no hay, el principal.</p>
    </section>

    <section class="card">
      <h2>Permisos y esfuerzo</h2>
      <label>permissionMode
        <select id="f-permission">
          <option value="">(heredado)</option>
          <option value="default">default</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="auto">auto</option>
          <option value="dontAsk">dontAsk</option>
          <option value="bypassPermissions">bypassPermissions</option>
          <option value="plan">plan</option>
          <option value="manual">manual (alias de default)</option>
        </select>
      </label>
      <p class="hint" id="permission-hint">Omitido, hereda el modo del principal.</p>
      <label>effort
        <select id="f-effort">
          <option value="">(heredado)</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
      </label>
    </section>

    <section class="card span-2">
      <h2>Apariencia</h2>
      <div id="colors" class="chips"></div>
      <div class="row">
        <button id="btn-color-none" class="secondary small" type="button">Sin color</button>
      </div>
      <p class="hint" id="color-hint">Solo nombres de la paleta: el CLI no pinta un hex.</p>
    </section>

    <section class="card span-2">
      <details class="advanced">
        <summary>Avanzado</summary>
        <div class="row">
          <label>maxTurns
            <input id="f-max-turns" type="text" inputmode="numeric" placeholder="(sin límite)" />
          </label>
          <label>memory
            <select id="f-memory">
              <option value="">(por defecto)</option>
              <option value="user">user</option>
              <option value="project">project</option>
              <option value="local">local</option>
            </select>
          </label>
          <label>isolation
            <select id="f-isolation">
              <option value="">(ninguno)</option>
              <option value="worktree">worktree</option>
            </select>
          </label>
        </div>
        <label class="block">skills (una por línea)
          <textarea id="f-skills" rows="3" spellcheck="false" placeholder="nombre-de-skill"></textarea>
        </label>
        <div class="row">
          <label class="check"><input id="f-background" type="checkbox" /> background</label>
          <label class="check"><input id="f-omit-claude-md" type="checkbox" /> omitClaudeMd</label>
        </div>
      </details>
    </section>

    <section class="card span-2">
      <h2>Prompt (system prompt)</h2>
      <p class="hint">El cuerpo del fichero es el prompt. No se escribe ninguna clave <code>prompt:</code>.</p>
      <textarea id="f-prompt" class="prompt" rows="18" spellcheck="false" placeholder="Eres un..."></textarea>
      <p class="hint" id="prompt-count"></p>
    </section>

    <section class="card span-2">
      <h2>Vista previa</h2>
      <pre id="preview" class="preview"></pre>
    </section>

    <section class="card span-2">
      <h2>Validación</h2>
      <ul id="issues" class="issues"><li class="ok">Sin problemas.</li></ul>
    </section>
  </main>
</div>
<script nonce="${nonce}" src="${mdScriptUri}"></script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    ClaudeAgentPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
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
