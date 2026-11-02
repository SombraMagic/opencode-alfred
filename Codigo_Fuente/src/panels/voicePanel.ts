import * as vscode from "vscode";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readSettings,
  describeMotors,
  listVoices,
  devices,
  inputDevices,
  speak,
  syncSharedConfig,
  measuredFloor,
} from "../voice/service.js";
import {
  CLOUD_URL_DEFAULT,
  KEY_SECRET,
  STT_ENGINES,
  STT_LANGUAGES,
  WHISPER_MODELS,
  loadWhisper,
  whisperInstalled,
  type SttEngine,
} from "../voice/stt.js";
import { mcpState, setMcpEnabled } from "../voice/mcpInstaller.js";
import { SysMonitor, type SysSample } from "../sysmon/monitor.js";
import { listActivities, type ActivityIcon } from "./activity";

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
  /** Actividad que no es un agente (imagen, dictado, Ollama); sin él, es un agente. */
  icon?: ActivityIcon;
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
    const inputs = await inputDevices();
    const cfg = vscode.workspace.getConfiguration("voz");
    const hasKey = Boolean(await this.context.secrets.get(KEY_SECRET));
    this.post({
      type: "init",
      motors,
      engine: settings.engine,
      devices: devs,
      device: settings.outputDevice,
      rate: settings.rate,
      pitch: settings.pitch,
      volume: settings.volume,
      // Ajustes del dictado, que ahora se manejan desde este panel.
      sttEngine: cfg.get<SttEngine>("dictado.engine", "sapi"),
      engines: STT_ENGINES,
      language: cfg.get("dictado.language", "es-ES"),
      languages: STT_LANGUAGES,
      denoise: cfg.get<boolean>("dictado.denoise", true),
      tolerance: cfg.get<number>("dictado.noiseTolerance", 6),
      noiseFloor: cfg.get<number>("dictado.noiseFloor", 0),
      measuredFloor: measuredFloor() ?? null,
      inputDevices: inputs,
      inputDevice: cfg.get<number>("dictado.inputDevice", -1),
      inputGain: cfg.get<number>("dictado.inputGain", 100),
      whisperModel: cfg.get("dictado.whisperModel", WHISPER_MODELS[2].id),
      cloudUrl: cfg.get("dictado.cloudUrl", CLOUD_URL_DEFAULT),
      cloudModel: cfg.get("dictado.cloudModel", "whisper-1"),
      hasKey,
      whisperReady: whisperInstalled(this.whisperDir()),
      models: WHISPER_MODELS,
    });
    const voices = await listVoices(settings.engine);
    this.post({ type: "voices", voices, selected: settings.voice || voices[0]?.id });
    // Tras un recargo del webview, las tarjetas vuelven sin esperar al siguiente
    // sondeo: `pending` las guarda si aún no ha avisado de que está listo.
    this.post({ type: "agents", agents: this.snapshotAgents() });
    // El interruptor del MCP se repinta al reabrir o recargar el panel.
    void this.pushMcp();
  }

  private whisperDir() {
    return join(this.context.globalStorageUri.fsPath, "whisper");
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
      ...listActivities().map((a) => ({ name: a.name, streaming: true, icon: a.icon })),
    ];
  }

  /** Repinta las tarjetas tras un cambio en las actividades de `./activity`. */
  refreshActivities(): void {
    this.post({ type: "agents", agents: this.snapshotAgents() });
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
        // El monitor no puede esperar al primer sondeo: la última muestra se
        // reenvía en cuanto el webview está listo.
        this.post({ type: "sysmon", data: this.lastSample });
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
      case "setSttEngine":
        await this.updateSetting("dictado.engine", String(msg.engine ?? "sapi"));
        break;
      case "setLanguage":
        await this.updateSetting("dictado.language", String(msg.language ?? "es-ES"));
        break;
      case "setInputDevice": {
        const n = Number(msg.device);
        const device = Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
        await this.updateSetting("dictado.inputDevice", device);
        this.post({ type: "inputDevice", device });
        break;
      }
      case "setInputGain": {
        const value = Math.max(0, Math.min(200, Math.round(Number(msg.value) || 0)));
        await this.updateSetting("dictado.inputGain", value);
        this.post({ type: "inputGain", value });
        break;
      }
      case "setDenoise":
        await this.updateSetting("dictado.denoise", Boolean(msg.on));
        break;
      case "setTolerance": {
        // La tolerancia del filtro va de 0 a 18 dB.
        const db = Math.max(0, Math.min(18, Number(msg.db) || 0));
        await this.updateSetting("dictado.noiseTolerance", db);
        break;
      }
      case "lockFloor":
        await this.lockFloor(Boolean(msg.on));
        break;
      case "setWhisperModel":
        await this.updateSetting("dictado.whisperModel", String(msg.model ?? ""));
        break;
      case "setCloudUrl": {
        const raw = String(msg.url ?? "").trim();
        if (raw && !/^https?:\/\//i.test(raw)) {
          this.post({ type: "error", message: "La URL debe empezar por http:// o https://." });
          break;
        }
        // Vaciar el campo devuelve el endpoint por defecto.
        const url = raw || CLOUD_URL_DEFAULT;
        await this.updateSetting("dictado.cloudUrl", url);
        this.post({ type: "cloudUrl", url });
        break;
      }
      case "setCloudModel":
        await this.updateSetting("dictado.cloudModel", String(msg.model ?? "").trim());
        break;
      case "saveKey":
        await this.context.secrets.store(KEY_SECRET, String(msg.key ?? ""));
        this.post({ type: "key", hasKey: Boolean(msg.key) });
        break;
      case "installWhisper": {
        const dir = this.whisperDir();
        this.post({ type: "whisper", ready: false, done: false, message: "Preparando Whisper…" });
        try {
          await loadWhisper(dir, (m) => this.post({ type: "whisper", ready: false, done: false, message: m }));
          this.post({ type: "whisper", ready: true, done: true, message: "Whisper listo." });
        } catch (err) {
          this.post({
            type: "whisper",
            ready: whisperInstalled(dir),
            done: true,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
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

  private async updateSetting(key: string, value: unknown) {
    const cfg = vscode.workspace.getConfiguration("voz");
    await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    // El MCP lee este fichero: sin esto hablaría con otra voz.
    await syncSharedConfig();
  }

  /** Fija (o suelta) el fondo con la última medida del dictado. */
  private async lockFloor(on: boolean) {
    const cfg = vscode.workspace.getConfiguration("voz");
    if (!on) {
      await this.updateSetting("dictado.noiseFloor", 0);
      this.post({ type: "floorLock", on: false, db: 0 });
      return;
    }
    const measured = measuredFloor();
    const saved = cfg.get<number>("dictado.noiseFloor", 0);
    if (measured === undefined && !saved) {
      this.post({ type: "error", message: "Habla algo para medir el fondo antes de fijarlo." });
      return;
    }
    const val = measured ?? saved;
    // Un fondo medido por encima de -40 dBFS suele provenir de un fragmento
    // donde casi todo era voz (percentil 20 contaminado de habla) o de un
    // micro excesivamente saturado. Evitamos fijar fondos incoherentes.
    if (val > -40) {
      this.post({
        type: "error",
        message: "No se pudo medir el fondo: graba un par de segundos en silencio.",
      });
      return;
    }
    const db = Number(val.toFixed(1));
    await this.updateSetting("dictado.noiseFloor", db);
    this.post({ type: "floorLock", on: true, db });
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

    <div class="readout">
      <span id="readout-engine">—</span>
      <span id="readout-voice">—</span>
      <span id="readout-time">00:00</span>
    </div>

    <!-- Ajustes del motor de voz: plegados para dejar sitio a los agentes. -->
    <details class="fold" id="cfg">
      <summary>AJUSTES VOZ</summary>
      <label class="field"><span class="field-label">MOTOR</span><select id="engine"></select></label>
      <label class="field"><span class="field-label">VOZ</span><select id="voice"></select></label>
      <label class="field"><span class="field-label">SALIDA</span><select id="device"></select></label>
      <label class="field"><span class="field-label">VELOCIDAD <i id="rate-val">0%</i></span><input type="range" id="rate" min="-50" max="100" step="5" value="0" /></label>
      <label class="field"><span class="field-label">TONO <i id="pitch-val">0Hz</i></span><input type="range" id="pitch" min="-50" max="50" step="5" value="0" /></label>
      <label class="field"><span class="field-label">VOLUMEN <i id="volume-val">100%</i></span><input type="range" id="volume" min="0" max="100" step="5" value="100" /></label>
    </details>

    <!-- Ajustes del micrófono del dictado. -->
    <details class="fold" id="cfg-mic">
      <summary>AJUSTES MICRÓFONO</summary>
      <label class="field"><span class="field-label">ENTRADA</span><select id="input-device"></select></label>
      <label class="field"><span class="field-label">VOLUMEN <i id="input-gain-val">100%</i></span><input id="input-gain" type="range" min="0" max="200" step="10" value="100" /></label>
      <div class="row2">
        <button class="ghost-btn" id="denoise" type="button" aria-pressed="true" title="Quita retumbe y siseo del micrófono antes de transcribir">FILTRAR</button>
        <button class="ghost-btn" id="lock-floor" type="button" aria-pressed="false" title="Fija el último fondo medido por el dictado"><span id="lock-label">FIJAR</span></button>
      </div>
      <label class="field"><span class="field-label">TOLERANCIA <i id="tolerance-value">+6 dB</i></span><input id="tolerance" type="range" min="0" max="18" step="1" value="6" /></label>
      <div class="hint" id="floor">Fondo sin medir todavía.</div>
    </details>

    <!-- El bloque CONFIGURACIÓN del dictado: reconocedor, Whisper y nube. -->
    <details class="fold" id="cfg-whisper">
      <summary>AJUSTES WHISPER</summary>
      <div class="sec">RECONOCEDOR</div>
      <label class="field"><span class="field-label">MOTOR</span><select id="stt-engine"></select></label>
      <div class="hint" id="engine-hint"></div>
      <label class="field"><span class="field-label">IDIOMA</span><select id="language"></select></label>
      <div class="sub" id="whisper-group">
        <div class="sec">WHISPER LOCAL</div>
        <div class="field">
          <span class="field-label">MODELO WHISPER
            <button class="mini" id="install-whisper" type="button" title="Descarga e instala Whisper (una sola vez)">PREPARAR</button>
          </span>
          <select id="whisper-model"></select>
        </div>
        <div class="hint" id="whisper-hint"></div>
      </div>
      <div class="sub" id="cloud-group">
        <div class="sec">NUBE (OPENAI)</div>
        <label class="field"><span class="field-label">URL DE LA API</span><input id="cloud-url" type="text" spellcheck="false" title="Cualquier API compatible con OpenAI" placeholder="https://api.openai.com/v1/audio/transcriptions" /></label>
        <label class="field"><span class="field-label">MODELO NUBE</span><input id="cloud-model" type="text" /></label>
        <div class="field">
          <span class="field-label">CLAVE API <i id="key-state"></i></span>
          <div class="row2">
            <input id="key" type="password" placeholder="sk-…" />
            <button class="ghost-btn" id="save-key" type="button">GUARDAR</button>
          </div>
        </div>
      </div>
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
    this.stopSysPolling();
    // No mata el proceso: se va solo al morir su -ParentPid.
    this.monitor?.dispose();
    unwatchFile(nowFile);
    for (const d of this.disposables) d.dispose();
  }
}
