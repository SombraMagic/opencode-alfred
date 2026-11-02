import * as vscode from "vscode";
import { join } from "node:path";
import {
  readSettings,
  describeMotors,
  listVoices,
  devices,
  inputDevices,
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
import { currentTheme, themeLinks, themeScript } from "./theme";

/**
 * Pestaña central con los ajustes de voz, micrófono y Whisper. Vive fuera de
 * la barra lateral para dejar el ecualizador limpio; el panel de voz abre esta
 * pestaña con la rueda dentada de al lado de TRANSCRIBIR.
 */
export class VoiceSettingsPanel {
  public static current: VoiceSettingsPanel | undefined;
  private static readonly viewType = "voz.settings";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  static open(context: vscode.ExtensionContext): VoiceSettingsPanel {
    if (VoiceSettingsPanel.current) {
      VoiceSettingsPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      void VoiceSettingsPanel.current.pushInitial();
      return VoiceSettingsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      VoiceSettingsPanel.viewType,
      "VOZ: ajustes",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    VoiceSettingsPanel.current = new VoiceSettingsPanel(panel, context);
    return VoiceSettingsPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(
      (msg) => void this.onMessage(msg),
      null,
      this.disposables
    );
  }

  /** Relee los ajustes y repinta la pestaña (cambios desde Settings). */
  refresh() {
    void this.pushInitial();
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
  }

  private whisperDir() {
    return join(this.context.globalStorageUri.fsPath, "whisper");
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":
        this.postTheme();
        await this.pushInitial();
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
          await loadWhisper(dir, (m) =>
            this.post({ type: "whisper", ready: false, done: false, message: m })
          );
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

  private post(msg: unknown) {
    void this.panel.webview.postMessage(msg);
  }

  /** Avisa al webview del estilo visual vigente. */
  postTheme(): void {
    this.post({ type: "theme", theme: currentTheme() });
  }

  /** Genera el HTML de la pestaña. */
  private html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "voiceSettings.js"));

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${themeLinks(this.context.extensionUri, webview, ["panel.css", "voiceSettings.css"])}
</head>
<body>
  <div class="settings">
    <div class="hud-header">
      <span class="hud-dot"></span>
      <span class="hud-title">VOZ // AJUSTES</span>
      <span class="hud-status">CONFIGURACIÓN</span>
    </div>

    <div class="settings-grid">
      <section class="card">
        <h2>AJUSTES VOZ</h2>
        <label class="field"><span class="field-label">MOTOR</span><select id="engine"></select></label>
        <label class="field"><span class="field-label">VOZ</span><select id="voice"></select></label>
        <label class="field"><span class="field-label">SALIDA</span><select id="device"></select></label>
        <label class="field"><span class="field-label">VELOCIDAD <i id="rate-val">0%</i></span><input type="range" id="rate" min="-50" max="100" step="5" value="0" /></label>
        <label class="field"><span class="field-label">TONO <i id="pitch-val">0Hz</i></span><input type="range" id="pitch" min="-50" max="50" step="5" value="0" /></label>
        <label class="field"><span class="field-label">VOLUMEN <i id="volume-val">100%</i></span><input type="range" id="volume" min="0" max="100" step="5" value="100" /></label>
      </section>

      <section class="card">
        <h2>AJUSTES MICRÓFONO</h2>
        <label class="field"><span class="field-label">ENTRADA</span><select id="input-device"></select></label>
        <label class="field"><span class="field-label">VOLUMEN <i id="input-gain-val">100%</i></span><input id="input-gain" type="range" min="0" max="200" step="10" value="100" /></label>
        <div class="row2">
          <button class="ghost-btn" id="denoise" type="button" aria-pressed="true" title="Quita retumbe y siseo del micrófono antes de transcribir">FILTRAR</button>
          <button class="ghost-btn" id="lock-floor" type="button" aria-pressed="false" title="Fija el último fondo medido por el dictado"><span id="lock-label">FIJAR</span></button>
        </div>
        <label class="field"><span class="field-label">TOLERANCIA <i id="tolerance-value">+6 dB</i></span><input id="tolerance" type="range" min="0" max="18" step="1" value="6" /></label>
        <div class="hint" id="floor">Fondo sin medir todavía.</div>
      </section>

      <section class="card">
        <h2>AJUSTES WHISPER</h2>
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
      </section>
    </div>
    <div class="notice" id="notice" hidden></div>
  </div>
  ${themeScript(this.context.extensionUri, webview, nonce)}
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    VoiceSettingsPanel.current = undefined;
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
