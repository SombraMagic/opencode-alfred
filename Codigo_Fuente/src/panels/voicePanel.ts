import * as vscode from "vscode";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSettings, speak } from "../voice/service.js";
import { mcpState, setMcpEnabled } from "../voice/mcpInstaller.js";
import { SysMonitor, type SysSample } from "../sysmon/monitor.js";
import { listActivities, type ActivityIcon } from "./activity";
import { currentTheme, themeLinks, themeScript } from "./theme";

/** Fichero donde el MCP publica cada reproducción (misma ruta que voz-core). */
const nowFile = join(
  process.env.VOZ_STATE_DIR ??
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "voz"),
  "now.json",
);

/** Agente que está trabajando ahora mismo, tal como lo pinta el panel. */
export interface WorkingAgent {
  name: string;
  streaming: boolean;
  /** Color del `.md` del agente (hex o nombre de la paleta de Claude); sin él, el acento. */
  color?: string;
  /** Actividad que no es un agente (imagen, dictado, Ollama, radar); sin él, es un agente. */
  icon?: ActivityIcon;
  /** Paso en curso de la actividad, bajo el nombre; solo en las tarjetas extra. */
  detail?: string;
}

/**
 * Vista webview del panel de voz.
 */
export class VozPanel {
  static readonly viewId = "voz.panel";
  private disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private ready = false;
  private pending: unknown[] = [];
  private lastPlaybackId = "";
  /** Último estado recibido: se reenvía si el webview se recarga. */
  private agents: WorkingAgent[] = [];
  /** El interruptor del MCP: dice qué hacer al pulsarlo. */
  private mcpEnabled = false;
  /** Monitor del equipo (CPU, RAM, GPU y VRAM); solo lee el fichero de muestras. */
  private monitor?: SysMonitor;
  /** Sondeo de 2 s: corre solo mientras la vista se ve. */
  private sysTimer?: ReturnType<typeof setInterval>;
  /** Última muestra buena, para no dejar el monitor vacío al reabrir o recargar. */
  private lastSample: SysSample | null = null;

  constructor(
    view: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.view = view;
  }

  async init() {
    const view = this.view!;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    // Escuchar ANTES de asignar el HTML: el webview avisa de que está listo
    // en cuanto arranca y ese mensaje no se puede perder.
    this.disposables.push(
      view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      // La vista se destruye con la ventana o al moverla de sitio, y el panel se
      // crea de nuevo en cada `resolveWebviewView`: sin esto quedan dos sondeos
      // de 2 s vivos, uno de ellos hablando con un webview que ya no existe.
      view.onDidDispose(() => this.dispose()),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          void this.pushInitial();
          // El proceso sigue vivo aunque la vista esté oculta: aquí solo se
          // reanuda el sondeo, nunca se lanza otro.
          this.startSysPolling();
        } else {
          this.stopSysPolling();
        }
      }),
    );
    this.context.subscriptions.push(...this.disposables);

    this.monitor = new SysMonitor({
      script: join(this.context.extensionUri.fsPath, "resources", "sysmon-lhm.ps1"),
      outFile: join(this.context.globalStorageUri.fsPath, "sysmon.json"),
    });

    view.webview.html = this.html(view.webview);
    await this.pushInitial();
    this.watchPlayback();
    if (view.visible) this.startSysPolling();
  }

  /** Arranca el sondeo del monitor con una muestra ya, sin esperar los 2 s. */
  private startSysPolling() {
    if (!this.monitor || this.sysTimer) return;
    this.pushSysmon();
    this.sysTimer = setInterval(() => this.pushSysmon(), 2000);
  }

  private stopSysPolling() {
    if (this.sysTimer) clearInterval(this.sysTimer);
    this.sysTimer = undefined;
  }

  private pushSysmon() {
    const data = this.monitor?.poll() ?? null;
    if (data) this.lastSample = data;
    this.post({ type: "sysmon", data });
  }

  /**
   * Vigila las reproducciones que no salen de este panel (las del MCP, que
   * corre en otro proceso) y las refleja en el ecualizador.
   */
  private watchPlayback() {
    watchFile(nowFile, { interval: 250 }, () => {
      try {
        const ev = JSON.parse(readFileSync(nowFile, "utf8"));
        if (!ev?.id || ev.id === this.lastPlaybackId) return;
        this.lastPlaybackId = ev.id;
        this.post({
          type: "playback",
          values: ev.envelope ?? [],
          energy: ev.energy ?? [],
          durationMs: ev.durationMs ?? 0,
          ageMs: Math.max(0, Date.now() - (ev.startedAt ?? Date.now())),
          // Deja en la caja el texto que ha dicho el agente: así se puede
          // repetir pulsando TRANSCRIBIR.
          text: ev.text ?? "",
        });
      } catch {
        // Fichero a medio escribir o inexistente: se ignora este aviso.
      }
    });
  }

  /** Envía un mensaje al webview, o lo encola si aún no está listo. */
  private post(msg: unknown) {
    if (this.ready) this.view?.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  /** Avisa al webview del estilo visual vigente. */
  postTheme() {
    this.post({ type: "theme", theme: currentTheme() });
  }

  /** El webview ya cargó: entrega lo que quedó en cola. */
  private flush() {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) this.view?.webview.postMessage(msg);
  }

  private async pushInitial() {
    // Tras un recargo del webview, las tarjetas vuelven sin esperar al siguiente
    // sondeo: `pending` las guarda si aún no ha avisado de que está listo.
    this.post({ type: "agents", agents: this.snapshotAgents() });
    // El interruptor del MCP se repinta al reabrir o recargar el panel.
    void this.pushMcp();
  }

  /** Publica el estado del interruptor del MCP; `message` manda en el aviso. */
  private async pushMcp(message?: string) {
    let state: Awaited<ReturnType<typeof mcpState>> | undefined;
    try {
      state = await mcpState(this.context);
    } catch (err) {
      // Leer los agentes no puede dejar el botón bloqueado en el webview.
      message = `No se pudo leer el estado del MCP: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (state) {
      this.mcpEnabled = state.enabled;
    }
    const agents = (state?.agents ?? [])
      .filter((a) => a.installed && a.enabled)
      .map((a) => a.label);
    this.post({ type: "mcp", enabled: state?.enabled ?? this.mcpEnabled, agents, message });
  }

  /**
   * Publica qué agentes están trabajando. `streaming` separa la respuesta en
   * curso de una herramienta en ejecución; la tarjeta solo cambia de ritmo.
   */
  updateAgents(agents: WorkingAgent[]) {
    this.agents = agents;
    this.post({ type: "agents", agents: this.snapshotAgents() });
  }

  /** Agentes en vuelo más las actividades que no son agentes, como una tarjeta más. */
  private snapshotAgents(): WorkingAgent[] {
    return [
      ...this.agents,
      ...listActivities().map((a) => ({ name: a.name, streaming: true, icon: a.icon, detail: a.detail })),
    ];
  }

  /** Repinta las tarjetas tras un cambio en las actividades de `./activity`. */
  refreshActivities(): void {
    this.post({ type: "agents", agents: this.snapshotAgents() });
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":
        this.flush();
        this.postTheme();
        // El monitor no puede esperar al primer sondeo: la última muestra se
        // reenvía en cuanto el webview está listo.
        this.post({ type: "sysmon", data: this.lastSample });
        break;
      case "speak":
        await this.doSpeak(msg);
        break;
      case "openSettings":
        // Los formularios viven en la pestaña central de ajustes.
        await vscode.commands.executeCommand("voz.settings");
        break;
      case "sysmonElevate": {
        // Clic en la temperatura de la CPU: el único sitio donde se pide el UAC.
        const monitor = this.monitor;
        if (!monitor) break;
        // Con un helper elevado bueno no hay nada que pedir: ni «…» ni UAC.
        const busy = !monitor.elevated;
        if (busy) this.post({ type: "sysmonBusy", on: true });
        const result = await monitor.elevate();
        if (busy) this.post({ type: "sysmonBusy", on: false });
        if (result === "fallo") {
          void vscode.window.showInformationMessage(
            "No se pudo leer la temperatura de la CPU: el resto del monitor sigue funcionando.",
          );
        }
        break;
      }
      case "toggleMcp": {
        let message: string;
        try {
          message = await setMcpEnabled(this.context, !this.mcpEnabled);
        } catch (err) {
          message = `No se pudo cambiar el MCP: ${err instanceof Error ? err.message : String(err)}`;
        }
        await this.pushMcp(message);
        break;
      }
  }
  }

  private async doSpeak(msg: any) {
    try {
      // La voz, la velocidad, el tono, el volumen y la salida salen de los
      // ajustes: el panel lateral ya no tiene esos controles.
      const result = await speak(msg.text, readSettings().engine, undefined, (info) => {
        // La envolvente y la duración se envían ANTES de reproducir: si se
        // enviaran después, el ecualizador reaccionaría con la voz ya terminada.
        this.post({
          type: "envelope",
          values: info.envelope,
          energy: info.energy,
          durationMs: info.durationMs,
        });
      });
      this.post({ type: "done", voice: result.voice, engine: result.engine });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`VOZ: ${message}`);
      this.post({ type: "error", message });
    }
  }

  /** Genera el HTML del panel. Público para las comprobaciones automatizadas. */
  html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    const equalizerUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "equalizer.js"));

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${themeLinks(this.context.extensionUri, webview, ["panel.css"])}
</head>
<body>
  <div class="hud">
    <div class="hud-header">
      <span class="hud-dot"></span>
      <span class="hud-title">VOZ // TTS</span>
      <span class="hud-status" id="status">EN LÍNEA</span>
    </div>

    <!-- Zona flexible: crece con los agentes y es lo único que se comprime
         (con scroll propio) cuando la vista es corta. -->
    <div class="stage">
      <!-- Monitor del equipo: se pinta en panel.js con las muestras de sysmon. -->
      <div class="sysmon" id="sysmon">
        <div class="sysmon-cell">
          <span class="sm-label">CPU</span><span class="sm-value" id="sm-cpu-temp">—</span>
          <span class="sm-use">USO</span><span class="sm-bar" id="sm-cpu-bar"><i></i></span><span class="sm-pct" id="sm-cpu-load">—</span>
        </div>
        <div class="sysmon-cell">
          <span class="sm-label">RAM</span><span class="sm-value" id="sm-ram-total">—</span>
          <span class="sm-use">USO</span><span class="sm-bar" id="sm-ram-bar"><i></i></span><span class="sm-pct" id="sm-ram-load">—</span>
        </div>
        <div class="sysmon-cell">
          <span class="sm-label">GPU</span><span class="sm-value" id="sm-gpu-temp">—</span>
          <span class="sm-use">USO</span><span class="sm-bar" id="sm-gpu-bar"><i></i></span><span class="sm-pct" id="sm-gpu-load">—</span>
        </div>
        <div class="sysmon-cell">
          <span class="sm-label">VRAM</span><span class="sm-value" id="sm-vram-total">—</span>
          <span class="sm-use">USO</span><span class="sm-bar" id="sm-vram-bar"><i></i></span><span class="sm-pct" id="sm-vram-load">—</span>
        </div>
      </div>

      <canvas id="equalizer" width="128" height="72"></canvas>

      <!-- Agentes en vuelo: panel.js lo rellena y lo vacía (vacío = sin hueco). -->
      <div id="agents"></div>
    </div>

    <!-- Pie: el texto se pliega; la rueda abre los ajustes en una pestaña central. -->
    <div class="dock">
      <details class="fold text-fold" id="fold-text" open>
        <summary>TEXTO</summary>
        <label class="field"><textarea id="text" rows="3" placeholder="Escribe o pega el texto que quieres que se lea…"></textarea></label>
        <div class="actions">
          <button id="speak" class="speak-btn"><span class="speak-glyph">▶</span><span id="speak-label">TRANSCRIBIR</span></button>
          <button id="btn-config" class="config-btn" type="button" title="Ajustes de voz, micrófono y Whisper" aria-label="Abrir los ajustes de voz">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.3 9v.09A1.7 1.7 0 0 0 20.86 10H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
            </svg>
          </button>
        </div>
      </details>
      <div class="mcp-row"><button id="mcp-toggle" class="ghost-btn" type="button" disabled title="Servidor MCP de Alfred: voz y pizarra para tu agente"><span class="mcp-dot off" id="mcp-dot"></span>ALFRED MCP</button><span class="mcp-hint" id="mcp-hint">…</span></div>
    </div>
  </div>
  ${themeScript(this.context.extensionUri, webview, nonce)}
  <script src="${equalizerUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    this.stopSysPolling();
    // No mata el proceso: se va solo al morir su -ParentPid.
    this.monitor?.dispose();
    unwatchFile(nowFile);
    for (const d of this.disposables) d.dispose();
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
