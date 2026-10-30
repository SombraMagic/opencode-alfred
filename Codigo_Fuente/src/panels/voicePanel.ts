import * as vscode from "vscode";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readSettings,
  describeMotors,
  listVoices,
  devices,
  speak,
  syncSharedConfig,
} from "../voice/service.js";
import { mcpState, setMcpEnabled } from "../voice/mcpInstaller.js";

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
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.pushInitial();
      }),
    );
    this.context.subscriptions.push(...this.disposables);

    view.webview.html = this.html(view.webview);
    await this.pushInitial();
    this.watchPlayback();
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

  /** El webview ya cargó: entrega lo que quedó en cola. */
  private flush() {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) this.view?.webview.postMessage(msg);
  }

  private async pushInitial() {
    const settings = readSettings();
    const motors = await describeMotors();
    const devs = await devices();
    this.post({
      type: "init",
      motors,
      engine: settings.engine,
      devices: devs,
      device: settings.outputDevice,
      rate: settings.rate,
      pitch: settings.pitch,
      volume: settings.volume,
    });
    const voices = await listVoices(settings.engine);
    this.post({ type: "voices", voices, selected: settings.voice || voices[0]?.id });
    // Tras un recargo del webview, las tarjetas vuelven sin esperar al siguiente
    // sondeo: `pending` las guarda si aún no ha avisado de que está listo.
    this.post({ type: "agents", agents: this.agents });
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
    this.post({ type: "agents", agents });
  }

  /**
   * Reenvía el estado al webview. Lo usan los ajustes que cambian fuera del
   * panel (Settings o settings.json), que antes dejaban la interfaz mintiendo.
   */
  refresh() {
    if (this.ready && this.view?.visible) void this.pushInitial();
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":
        this.flush();
        break;
      case "speak":
        await this.doSpeak(msg);
        break;
      case "loadVoices": {
        const voices = await listVoices(msg.engine);
        // Si la voz guardada no pertenece a este motor, se adopta la primera
        // y se guarda: si no, el MCP recibiría una voz inexistente.
        const saved = readSettings().voice;
        const selected = voices.some((v) => v.id === saved) ? saved : voices[0]?.id;
        if (selected && selected !== saved) await this.updateSetting("voice", selected);
        this.post({ type: "voices", voices, selected });
        break;
      }
      case "setEngine":
        await this.updateSetting("engine", msg.engine);
        break;
      case "setVoice":
        await this.updateSetting("voice", msg.voice);
        break;
      case "setRate":
        await this.updateSetting("rate", msg.rate);
        break;
      case "setPitch":
        await this.updateSetting("pitch", msg.pitch);
        break;
      case "setVolume":
        await this.updateSetting("volume", msg.volume);
        break;
      case "setDevice":
        await this.updateSetting("outputDevice", msg.device);
        break;
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

  private async updateSetting(key: string, value: unknown) {
    const cfg = vscode.workspace.getConfiguration("voz");
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    // El MCP lee este fichero: sin esto hablaría con otra voz.
    await syncSharedConfig();
  }

  private async doSpeak(msg: any) {
    try {
      // La envolvente y la duración se envían ANTES de reproducir: si se
      // enviaran después, el ecualizador reaccionaría con la voz ya terminada.
      const result = await speak(
        msg.text,
        msg.engine,
        { rate: msg.rate, pitch: msg.pitch, volume: msg.volume, device: msg.device },
        (info) => {
          this.post({
            type: "envelope",
            values: info.envelope,
            energy: info.energy,
            durationMs: info.durationMs,
          });
          this.post({ type: "speaking", durationMs: info.durationMs });
        },
      );
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
    const nonce = Math.random().toString(36).slice(2);
    const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "tokens.css"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    const equalizerUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "equalizer.js"));

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${tokensUri}" />
<link rel="stylesheet" href="${styleUri}" />
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
      <canvas id="equalizer" width="128" height="72"></canvas>

      <!-- Agentes en vuelo: panel.js lo rellena y lo vacía (vacío = sin hueco). -->
      <div id="agents"></div>
    </div>

    <div class="readout">
      <span id="readout-engine">—</span>
      <span id="readout-voice">—</span>
      <span id="readout-time">00:00</span>
    </div>

    <!-- Ajustes del motor: plegados para dejar sitio a los agentes. -->
    <details class="fold" id="cfg">
      <summary>AJUSTES</summary>
      <label class="field"><span class="field-label">MOTOR</span><select id="engine"></select></label>
      <label class="field"><span class="field-label">VOZ</span><select id="voice"></select></label>
      <label class="field"><span class="field-label">SALIDA</span><select id="device"></select></label>
      <label class="field"><span class="field-label">VELOCIDAD <i id="rate-val">0%</i></span><input type="range" id="rate" min="-50" max="100" step="5" value="0" /></label>
      <label class="field"><span class="field-label">TONO <i id="pitch-val">0Hz</i></span><input type="range" id="pitch" min="-50" max="50" step="5" value="0" /></label>
      <label class="field"><span class="field-label">VOLUMEN <i id="volume-val">100%</i></span><input type="range" id="volume" min="0" max="100" step="5" value="100" /></label>
    </details>

    <!-- Pie: siempre abajo, nunca se comprime. -->
    <div class="dock">
      <label class="field"><span class="field-label">TEXTO</span><textarea id="text" rows="3" placeholder="Escribe o pega el texto que quieres que se lea…"></textarea></label>
      <button id="speak" class="speak-btn"><span class="speak-glyph">▶</span><span id="speak-label">TRANSCRIBIR</span></button>
      <div class="mcp-row"><button id="mcp-toggle" class="ghost-btn" type="button" disabled title="Servidor MCP de Alfred: voz y pizarra para tu agente"><span class="mcp-dot off" id="mcp-dot"></span>ALFRED MCP</button><span class="mcp-hint" id="mcp-hint">…</span></div>
    </div>
  </div>
  <script src="${equalizerUri}"></script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    unwatchFile(nowFile);
    for (const d of this.disposables) d.dispose();
  }
}
