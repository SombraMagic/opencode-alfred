import * as vscode from "vscode";
import { readSettings, traduccionState } from "../ollama/service";
import { MAX_TEXTO } from "../ollama/translate";
import { currentTheme, themeLinks, themeScript } from "./theme";

/** Tope de la petición de prueba: el servicio tiene el suyo (120 s por petición en cola). */
const PRUEBA_TIMEOUT_MS = 300_000;

/**
 * Pestaña TRADUCCIÓN: prueba el servicio de traducción local pasando por su API HTTP de
 * verdad. La webview no hace red: el host llama a `http://127.0.0.1:<puerto>/traducir`.
 */
export class TraduccionPanel {
  public static current: TraduccionPanel | undefined;
  private static readonly viewType = "opencodeAgents.traduccion";

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private enVuelo?: AbortController;

  static open(context: vscode.ExtensionContext): TraduccionPanel {
    if (TraduccionPanel.current) {
      TraduccionPanel.current.panel.reveal(vscode.ViewColumn.Active);
      TraduccionPanel.current.refresh();
      return TraduccionPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      TraduccionPanel.viewType,
      "Traducción (Mente local)",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    TraduccionPanel.current = new TraduccionPanel(panel, context);
    return TraduccionPanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: Record<string, unknown>) => {
        if (message?.type === "ready") {
          this.postTheme();
          this.refresh();
          return;
        }
        if (message?.type === "copiar" && typeof message.texto === "string") {
          void vscode.env.clipboard.writeText(message.texto.slice(0, 4000));
          return;
        }
        if (
          message?.type === "traducir" &&
          typeof message.texto === "string" &&
          (message.destino === "es" || message.destino === "en")
        ) {
          void this.traducir(message.texto, message.destino);
        }
      },
      null,
      this.disposables
    );
  }

  /** Estado del servicio para el aviso y el ejemplo `curl`. */
  refresh(): void {
    const t = traduccionState(this.context);
    this.post({
      type: "estado",
      activo: t.activo,
      puerto: t.puerto,
      modelo: readSettings(this.context).model,
    });
  }

  /** Avisa al webview del estilo visual vigente. */
  postTheme(): void {
    this.post({ type: "theme", theme: currentTheme() });
  }

  private async traducir(texto: string, destino: "es" | "en"): Promise<void> {
    this.refresh();
    const t = traduccionState(this.context);
    if (!t.activo) {
      this.post({
        type: "resultado",
        error: "El servicio de traducción está apagado: enciéndelo en Mente local.",
      });
      return;
    }
    if (!texto.trim() || texto.length > MAX_TEXTO) {
      this.post({
        type: "resultado",
        error: `Escribe un texto de 1 a ${MAX_TEXTO} caracteres.`,
      });
      return;
    }
    this.enVuelo?.abort();
    const control = new AbortController();
    this.enVuelo = control;
    const reloj = setTimeout(() => control.abort(), PRUEBA_TIMEOUT_MS);
    const inicio = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${t.puerto}/traducir`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texto, destino }),
        signal: control.signal,
      });
      const cuerpo = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !cuerpo || typeof cuerpo.texto !== "string") {
        const motivo =
          cuerpo && typeof cuerpo.error === "string" ? cuerpo.error : "respuesta ilegible";
        this.post({ type: "resultado", error: `HTTP ${response.status}: ${motivo}` });
        return;
      }
      this.post({
        type: "resultado",
        texto: cuerpo.texto,
        modelo: typeof cuerpo.modelo === "string" ? cuerpo.modelo : "",
        ms: typeof cuerpo.ms === "number" ? cuerpo.ms : Date.now() - inicio,
        total: Date.now() - inicio,
      });
    } catch (err) {
      if (control.signal.aborted && this.enVuelo !== control) {
        return; // La sustituyó otra petición: su resultado es el que vale.
      }
      this.post({
        type: "resultado",
        error: control.signal.aborted
          ? "La traducción tardó demasiado."
          : `No se pudo hablar con el servicio: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      clearTimeout(reloj);
      if (this.enVuelo === control) {
        this.enVuelo = undefined;
      }
    }
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "traduccion.js")
    );
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp}; script-src 'nonce-${nonce}';">
${themeLinks(this.context.extensionUri, webview, ["traduccion.css"])}
<title>Traducción</title>
</head>
<body>
<header class="hud-header">
  <h1 class="hud-title">TRADUCCIÓN</h1>
  <span class="hud-status" id="estado">—</span>
</header>
<p class="aviso" id="aviso" role="status" aria-live="polite" hidden></p>

<main class="tr-cuerpo">
  <section class="tr-col">
    <label class="tr-label" for="origen">ORIGEN</label>
    <textarea id="origen" class="tr-area" spellcheck="false" maxlength="${MAX_TEXTO}" placeholder="Texto en cualquier idioma…"></textarea>
  </section>
  <section class="tr-col">
    <div class="tr-barra">
      <span class="tr-label">DESTINO</span>
      <div class="tr-destino" role="group" aria-label="Idioma de destino">
        <button type="button" class="tr-ord on" data-destino="es" aria-pressed="true">ES</button>
        <button type="button" class="tr-ord" data-destino="en" aria-pressed="false">EN</button>
      </div>
      <button id="traducir" class="tr-btn" type="button">TRADUCIR</button>
    </div>
    <textarea id="resultado" class="tr-area" readonly placeholder="La traducción saldrá aquí."></textarea>
    <p class="tr-meta" id="meta"></p>
  </section>
</main>

<section class="tr-curl">
  <div class="tr-barra">
    <span class="tr-label">EJEMPLO</span>
    <button id="copiarCurl" class="tr-btn mini" type="button" title="Copiar el ejemplo al portapapeles">COPIAR</button>
  </div>
  <pre class="tr-pre" id="curl"></pre>
</section>
${themeScript(this.context.extensionUri, webview, nonce)}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private release(): void {
    const enVuelo = this.enVuelo;
    this.enVuelo = undefined;
    enVuelo?.abort();
    if (TraduccionPanel.current === this) {
      TraduccionPanel.current = undefined;
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
