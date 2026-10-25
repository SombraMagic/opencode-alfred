import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ConnectorAttempt,
  ConnectorsData,
  FormAnswer,
  FormValue,
} from "../agents/connectors";

export type ConnectorAction =
  | { type: "select"; id: string }
  | { type: "persistView"; search: string }
  | { type: "refresh" }
  | { type: "toggle"; id: string; on: boolean }
  | { type: "remove"; id: string }
  | { type: "connectKey"; id: string; key: string; answer?: FormAnswer }
  | { type: "connectExternal"; id: string; methodID: string; answer?: FormAnswer }
  | { type: "startOauth"; id: string; methodID: string; answer?: FormAnswer }
  | { type: "completeOauth"; id: string; attemptID: string; code?: string }
  | { type: "cancelAttempt"; id: string; attemptID: string; kind?: "oauth" | "command" }
  | { type: "startCommand"; id: string; methodID: string }
  | { type: "openUrl"; url: string }
  | { type: "close" };

/** Acciones que el webview tiene permitido pedir. */
const ACTION_TYPES = new Set<string>([
  "select",
  "persistView",
  "refresh",
  "toggle",
  "remove",
  "connectKey",
  "connectExternal",
  "startOauth",
  "completeOauth",
  "cancelAttempt",
  "startCommand",
  "openUrl",
  "close",
]);

/** Ids de conector, método e intento: no vacíos y cortos (van a una ruta HTTP). */
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function validFormValue(value: unknown): value is FormValue {
  if (typeof value === "string") {
    return value.length <= 8192;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "boolean") {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every((item) => typeof item === "string" && item.length <= 512)
  );
}

function validAnswer(value: unknown): value is FormAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 100 && entries.every(([, item]) => validFormValue(item));
}

/** El webview no es de fiar: nada llega al servicio sin pasar por aquí. */
function parseAction(raw: unknown): ConnectorAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const action = raw as Record<string, unknown>;
  if (typeof action.type !== "string" || !ACTION_TYPES.has(action.type)) {
    return undefined;
  }
  const answer = action.answer;
  if (answer !== undefined && !validAnswer(answer)) {
    return undefined;
  }
  const id = validId(action.id) ? action.id : undefined;
  switch (action.type) {
    case "refresh":
      return { type: "refresh" };
    case "close":
      return { type: "close" };
    case "persistView":
      return typeof action.search === "string" && action.search.length <= 500
        ? { type: "persistView", search: action.search }
        : undefined;
    case "select":
      return id ? { type: "select", id } : undefined;
    case "remove":
      return id ? { type: "remove", id } : undefined;
    case "toggle":
      return id && typeof action.on === "boolean"
        ? { type: "toggle", id, on: action.on }
        : undefined;
    case "connectKey": {
      const key = action.key;
      if (!id || typeof key !== "string" || key.length < 1 || key.length > 4096) {
        return undefined;
      }
      return { type: "connectKey", id, key, ...(answer !== undefined ? { answer } : {}) };
    }
    case "connectExternal":
    case "startOauth": {
      const methodID = action.methodID;
      if (!id || !validId(methodID)) {
        return undefined;
      }
      return {
        type: action.type,
        id,
        methodID,
        ...(answer !== undefined ? { answer } : {}),
      };
    }
    case "startCommand": {
      const methodID = action.methodID;
      return id && validId(methodID) ? { type: "startCommand", id, methodID } : undefined;
    }
    case "completeOauth": {
      const attemptID = action.attemptID;
      const code = action.code;
      if (!id || !validId(attemptID)) {
        return undefined;
      }
      if (code !== undefined && (typeof code !== "string" || code.length > 8192)) {
        return undefined;
      }
      return {
        type: "completeOauth",
        id,
        attemptID,
        ...(code !== undefined ? { code } : {}),
      };
    }
    case "cancelAttempt": {
      const attemptID = action.attemptID;
      const kind = action.kind;
      if (
        !id ||
        !validId(attemptID) ||
        (kind !== undefined && kind !== "oauth" && kind !== "command")
      ) {
        return undefined;
      }
      return { type: "cancelAttempt", id, attemptID, ...(kind ? { kind } : {}) };
    }
    case "openUrl": {
      const url = action.url;
      return typeof url === "string" && url.length <= 2048 && /^https?:\/\//.test(url)
        ? { type: "openUrl", url }
        : undefined;
    }
  }
  return undefined;
}

export interface ConnectorsPanelHandlers {
  onAction(action: ConnectorAction): void | Promise<void>;
  onReady(): void;
  onClosed?(): void;
}

export class ConnectorsPanel {
  public static current: ConnectorsPanel | undefined;
  private static readonly viewType = "opencodeAgents.connectors";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private handlers: ConnectorsPanelHandlers;
  private last?: ConnectorsData;
  private released = false;

  static open(
    context: vscode.ExtensionContext,
    data: ConnectorsData,
    handlers: ConnectorsPanelHandlers
  ): ConnectorsPanel {
    if (ConnectorsPanel.current) {
      ConnectorsPanel.current.handlers = handlers;
      ConnectorsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ConnectorsPanel.current.update(data);
      return ConnectorsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ConnectorsPanel.viewType,
      "Conectores de opencode",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    ConnectorsPanel.current = new ConnectorsPanel(panel, context.extensionUri, handlers);
    ConnectorsPanel.current.update(data);
    return ConnectorsPanel.current;
  }

  /** Cierra el panel si está abierto (al cambiar a un proveedor que no lo admite). */
  static close(): void {
    ConnectorsPanel.current?.panel.dispose();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    handlers: ConnectorsPanelHandlers
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.handlers = handlers;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: unknown }) => {
        if (message?.type === "ready") {
          if (this.last) {
            this.post({ type: "connectors", payload: this.last });
          }
          this.handlers.onReady();
          return;
        }
        if (message?.type !== "action") {
          return;
        }
        const action = parseAction(message.action);
        if (!action) {
          return;
        }
        // Cerrar no llega al handler: es cosa del panel.
        if (action.type === "close") {
          this.panel.dispose();
          return;
        }
        void this.handlers.onAction(action);
      },
      null,
      this.disposables
    );
  }

  update(data: ConnectorsData): void {
    this.last = data;
    this.post({ type: "connectors", payload: data });
  }

  postAttempt(attempt: ConnectorAttempt): void {
    this.post({ type: "attempt", payload: attempt });
  }

  postNotice(level: "info" | "error", text: string): void {
    this.post({ type: "notice", level, text });
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
      vscode.Uri.joinPath(this.extensionUri, "media", "connectors.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "connectors.js")
    );

    // El marcado vive en media/connectors.html: la extensión solo rellena los huecos.
    const template = readFileSync(
      join(this.extensionUri.fsPath, "media", "connectors.html"),
      "utf8"
    );
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%TOKENS%%", tokensUri.toString())
      .replaceAll("%%STYLE%%", styleUri.toString())
      .replaceAll("%%SCRIPT%%", scriptUri.toString());
  }

  /** Suelta el singleton y avisa a la extensión una sola vez, sin volver a disponer el panel. */
  private release(): void {
    if (ConnectorsPanel.current === this) {
      ConnectorsPanel.current = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    if (this.released) {
      return;
    }
    this.released = true;
    this.handlers.onClosed?.();
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
