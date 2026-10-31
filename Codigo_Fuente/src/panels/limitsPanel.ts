import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderLimits } from "../limits/limits";

/** Mensajes que el webview tiene permitido pedir. */
interface LimitsMessage {
  type?: string;
  plan?: string;
  id?: string;
  collapsed?: boolean;
}

/** Clave del globalState donde viven las tarjetas plegadas. */
const COLLAPSED_KEY = "opencodeAgents.limitsCollapsed";

export class LimitsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencodeAgents.limits";

  private view?: vscode.WebviewView;
  private providers: ProviderLimits[] = [];
  // Ids de proveedor con la tarjeta plegada (persisten en el globalState).
  private collapsed: string[] = [];
  // Antes del primer sondeo no se manda nada: la vista muestra «Leyendo límites…».
  private loaded = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onReady: () => void,
    private readonly onRefresh: () => void,
    private readonly onSetGoPlan: (plan: "go" | "go-plus") => void,
    /** La vista se ha cerrado: el host apaga aquí su temporizador de sondeo. */
    private readonly onDispose: () => void,
    private readonly state: vscode.Memento
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // El estado guardado no es de fiar: solo valen las entradas de tipo string.
    const guardado = this.state.get<unknown[]>(COLLAPSED_KEY, []);
    this.collapsed = Array.isArray(guardado)
      ? guardado.filter((id): id is string => typeof id === "string")
      : [];

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message: LimitsMessage) => {
      if (message?.type === "refresh") {
        this.onRefresh();
        return;
      }
      if (message?.type === "setGoPlan") {
        if (message.plan === "go" || message.plan === "go-plus") {
          this.onSetGoPlan(message.plan);
        }
        return;
      }
      if (message?.type === "collapse") {
        const id = message.id;
        if (typeof id !== "string" || !id) {
          return;
        }
        // Sin repintar: el webview ya movió su tarjeta y su sondeo no debe deshacerlo.
        const resto = this.collapsed.filter((otro) => otro !== id);
        this.collapsed = message.collapsed ? [...resto, id] : resto;
        void this.state.update(COLLAPSED_KEY, this.collapsed);
        return;
      }
      if (message?.type !== "ready") {
        return;
      }
      this.post();
      this.onReady();
    });

    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        // Solo la vista vigente apaga el sondeo del host: un dispose tardío de una
        // vista vieja no debe matar el temporizador de la nueva.
        this.onDispose();
      }
    });

    this.post();
  }

  update(providers: ProviderLimits[]): void {
    this.providers = Array.isArray(providers) ? providers : [];
    this.loaded = true;
    this.post();
  }

  private post(): void {
    if (!this.loaded) {
      return;
    }
    void this.view?.webview.postMessage({
      type: "data",
      providers: this.providers,
      collapsed: this.collapsed,
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const tokensUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "tokens.css")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "limits.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "limits.js")
    );

    // El marcado vive en media/limits.html: la extensión solo rellena los huecos.
    const template = readFileSync(
      join(this.extensionUri.fsPath, "media", "limits.html"),
      "utf8"
    );
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%TOKENS%%", tokensUri.toString())
      .replaceAll("%%STYLE%%", styleUri.toString())
      .replaceAll("%%SCRIPT%%", scriptUri.toString());
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
