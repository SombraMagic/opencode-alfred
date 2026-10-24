/**
 * Panel de dictado (zona inferior de VS Code): voz a texto.
 *
 * Tres columnas: configuración, bloc de notas y controles. El botón del
 * micrófono se mantiene pulsado para hablar; al soltarlo, SAPI ya tiene texto
 * y Whisper o la nube transcriben lo grabado.
 *
 * MANOS LIBRES: un clic escucha sin soltar nada. Whisper y la nube graban por
 * turnos: al detectar una pausa larga se corta el fragmento, se transcribe y
 * se sigue grabando; el texto entra en el bloc sin esperar al final.
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SapiDictado,
  STT_ENGINES,
  WHISPER_MODELS,
  cloudText,
  loadWhisper,
  whisperInstalled,
  whisperText,
  type SttEngine,
} from "../voice/stt.js";
import {
  denoiseWav,
  noiseFloorDb,
  startRecording,
  voiceMs,
  type Recorder,
} from "../voice/core/index.js";

/** Idiomas ofrecidos. SAPI sólo tiene instalado el que tenga Windows. */
const LANGUAGES = [
  { id: "es-ES", label: "Español (España)" },
  { id: "es-MX", label: "Español (México)" },
  { id: "en-US", label: "English (US)" },
  { id: "fr-FR", label: "Français" },
  { id: "de-DE", label: "Deutsch" },
  { id: "it-IT", label: "Italiano" },
  { id: "pt-BR", label: "Português (Brasil)" },
];

const KEY_SECRET = "voz.dictado.apiKey";
/** El bloc de notas sobrevive al panel y a VS Code. */
const KEY_NOTE = "voz.dictado.note";

/** Manos libres: esta pausa cierra el fragmento y lo manda a transcribir. */
const PAUSE_MS = 2000;
/** Fragmentos más cortos que esto son ruido, no voz. */
const MIN_CHUNK_MS = 400;
/** Voz mínima (medida sobre el audio) para molestarse en transcribir. */
const MIN_VOICE_MS = 150;
/** Tope por fragmento: el búfer del micrófono aguanta 60 s. */
const MAX_CHUNK_MS = 25_000;
/**
 * Nivel (0..1) por debajo del cual se considera silencio.
 * Con 0.02 los picos de un ventilador (~0.037) contaban como voz y cortaban
 * fragmentos vacíos cada dos segundos.
 */
const SILENCE_LEVEL = 0.05;

export class VozDictado {
  static readonly viewId = "voz.dictado";

  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private ready = false;
  private pending: unknown[] = [];
  private sapi?: SapiDictado;
  private recorder?: Recorder;
  private levelTimer?: ReturnType<typeof setInterval>;
  /** Último ruido de fondo medido (dBFS): lo usa FIJAR FONDO. */
  private lastFloorDb?: number;
  private busy = false;
  private handsFree = false;
  private heard = false;
  private chunkStart = 0;
  private lastVoice = 0;
  /** Transcribe los fragmentos de uno en uno, en orden. */
  private chain: Promise<void> = Promise.resolve();

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

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.pushInitial();
      }),
    );
    this.context.subscriptions.push(...this.disposables);

    view.webview.html = this.html(view.webview);
    await this.pushInitial();
  }

  /** Ajustes del dictado. */
  private settings() {
    const cfg = vscode.workspace.getConfiguration("voz");
    return {
      engine: cfg.get<SttEngine>("dictado.engine", "sapi"),
      language: cfg.get("dictado.language", "es-ES"),
      whisperModel: cfg.get("dictado.whisperModel", WHISPER_MODELS[2].id),
      cloudModel: cfg.get("dictado.cloudModel", "whisper-1"),
      cloudUrl: cfg.get("dictado.cloudUrl", "https://api.openai.com/v1/audio/transcriptions"),
      denoise: cfg.get<boolean>("dictado.denoise", true),
      tolerance: cfg.get<number>("dictado.noiseTolerance", 6),
      noiseFloor: cfg.get<number>("dictado.noiseFloor", 0),
    };
  }

  private async pushInitial() {
    const s = this.settings();
    const hasKey = Boolean(await this.context.secrets.get(KEY_SECRET));
    this.post({
      type: "init",
      engine: s.engine,
      language: s.language,
      whisperModel: s.whisperModel,
      cloudModel: s.cloudModel,
      hasKey,
      denoise: s.denoise,
      tolerance: s.tolerance,
      noiseFloor: s.noiseFloor,
      note: this.context.globalState.get<string>(KEY_NOTE, ""),
      engines: STT_ENGINES,
      models: WHISPER_MODELS,
      languages: LANGUAGES,
      whisperReady: whisperInstalled(this.whisperDir()),
    });
  }

  private whisperDir() {
    return join(this.context.globalStorageUri.fsPath, "whisper");
  }

  private post(msg: unknown) {
    if (this.ready) this.view?.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  private flush() {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const msg of queued) this.view?.webview.postMessage(msg);
  }

  private state(state: "idle" | "listening" | "working" | "error", message = "") {
    this.post({ type: "state", state, message });
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":
        this.flush();
        break;
      case "start":
        await this.startListening();
        break;
      case "stop":
        await this.stopListening();
        break;
      case "handsFree":
        await this.setHandsFree(Boolean(msg.on));
        break;
      case "setEngine":
        await this.updateSetting("dictado.engine", msg.engine);
        break;
      case "setLanguage":
        await this.updateSetting("dictado.language", msg.language);
        break;
      case "setWhisperModel":
        await this.updateSetting("dictado.whisperModel", msg.model);
        break;
      case "setCloudModel":
        await this.updateSetting("dictado.cloudModel", msg.model);
        break;
      case "setDenoise":
        await this.updateSetting("dictado.denoise", Boolean(msg.on));
        break;
      case "setTolerance":
        await this.updateSetting("dictado.noiseTolerance", Number(msg.db));
        break;
      case "lockFloor":
        await this.lockFloor(Boolean(msg.on));
        break;
      case "saveKey":
        await this.context.secrets.store(KEY_SECRET, String(msg.key ?? ""));
        this.post({ type: "key", hasKey: Boolean(msg.key) });
        this.state("idle", msg.key ? "Clave guardada." : "Clave borrada.");
        break;
      case "saveNote":
        await this.context.globalState.update(KEY_NOTE, String(msg.text ?? ""));
        break;
      case "sendPrompt":
        await this.sendPrompt(String(msg.text ?? ""));
        break;
      case "installWhisper": {
        this.state("working", "Instalando Whisper…");
        try {
          await loadWhisper(this.whisperDir(), (m) => this.state("working", m));
          this.post({ type: "whisperReady", ready: true });
          this.state("idle", "Whisper instalado.");
        } catch (err) {
          this.fail(err);
        }
        break;
      }
    }
  }

  private async updateSetting(key: string, value: unknown) {
    await vscode.workspace.getConfiguration("voz").update(key, value, vscode.ConfigurationTarget.Global);
  }

  /** Fija (o suelta) el ruido de fondo al último valor medido. */
  private async lockFloor(on: boolean) {
    if (on && this.lastFloorDb === undefined) {
      this.state("idle", "Habla algo para medir el fondo antes de fijarlo.");
      return;
    }
    const db = on ? Number(this.lastFloorDb!.toFixed(1)) : 0;
    await this.updateSetting("dictado.noiseFloor", db);
    this.post({ type: "floorLock", on, db });
    this.state("idle", on ? `Fondo fijado en ${db} dB.` : "Fondo automático.");
  }

  /** Manda al panel el fondo medido, para ver cómo se ajusta solo. */
  private reportFloor(db: number | null) {
    if (db === null) return;
    this.lastFloorDb = db;
    this.post({ type: "floor", db: Number(db.toFixed(1)) });
  }

  /** Crea el puente con SAPI la primera vez y lo pone a escuchar. */
  private startSapi() {
    const s = this.settings();
    if (!this.sapi) {
      this.sapi = new SapiDictado(join(this.context.extensionUri.fsPath, "resources", "stt-sapi.ps1"), s.language, {
        onText: (text) => this.post({ type: "text", text }),
        onState: (st) => {
          if (st.error) {
            this.sapi = undefined;
            this.offHandsFree();
            this.state("error", st.error);
          }
        },
      });
    }
    this.post({ type: "engine", engine: s.engine });
    this.sapi.start();
  }

  /** Pulsación del botón: empieza a escuchar (o a grabar). */
  private async startListening() {
    if (this.busy || this.handsFree) return;
    const s = this.settings();
    this.state("listening");

    try {
      if (s.engine === "sapi") {
        this.startSapi();
        return;
      }

      // Whisper y nube: el micrófono lo abre la extensión.
      this.recorder = startRecording();
      this.post({ type: "engine", engine: s.engine });
      this.levelTimer = setInterval(() => {
        this.post({ type: "level", value: this.recorder?.level() ?? 0 });
      }, 100);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Suelta del botón: transcribe lo grabado y limpia. */
  private async stopListening() {
    if (this.handsFree) return;
    const s = this.settings();
    if (s.engine === "sapi") {
      this.sapi?.stop();
      this.state("idle");
      return;
    }

    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    const rec = this.recorder;
    this.recorder = undefined;
    if (!rec) return;

    const { wav, durationMs } = rec.stop();
    this.post({ type: "level", value: 0 });
    this.reportFloor(noiseFloorDb(wav));
    if (durationMs < 300) {
      this.state("idle", "Demasiado corto.");
      return;
    }
    if (voiceMs(wav) < MIN_VOICE_MS) {
      this.state("idle", "No se oyó nada.");
      return;
    }
    await this.transcribe(wav, durationMs);
  }

  /** Clic en MANOS LIBRES: escucha hasta el siguiente clic. */
  private async setHandsFree(on: boolean) {
    if (on === this.handsFree) return;
    const s = this.settings();
    this.handsFree = on;
    this.post({ type: "handsFree", on });

    if (on) {
      this.state("listening", "Manos libres: habla y haz pausas");
      if (s.engine === "sapi") {
        try {
          this.startSapi();
        } catch (err) {
          this.offHandsFree();
          this.fail(err);
        }
        return;
      }
      try {
        if (!this.recorder) this.recorder = startRecording();
        this.heard = false;
        this.chunkStart = Date.now();
        this.lastVoice = this.chunkStart;
        this.post({ type: "engine", engine: s.engine });
        this.levelTimer = setInterval(() => void this.tick(), 100);
      } catch (err) {
        this.offHandsFree();
        this.fail(err);
      }
      return;
    }

    if (s.engine === "sapi") {
      this.sapi?.stop();
      this.state("idle", "Manos libres desactivado.");
      return;
    }
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    await this.cutChunk();
  }

  private offHandsFree() {
    if (!this.handsFree) return;
    this.handsFree = false;
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.post({ type: "handsFree", on: false });
  }

  /** Vúmetro y detector de pausa del modo manos libres. */
  private async tick() {
    const rec = this.recorder;
    if (!rec) return;
    const level = rec.level();
    this.post({ type: "level", value: level });

    const now = Date.now();
    if (level >= SILENCE_LEVEL) {
      this.lastVoice = now;
      this.heard = true;
    }
    const paused = this.heard && now - this.lastVoice >= PAUSE_MS;
    if (paused || now - this.chunkStart >= MAX_CHUNK_MS) await this.cutChunk();
  }

  /**
   * Cierra el fragmento en curso: reabre el micrófono antes de transcribir para
   * no perder lo que se diga mientras Whisper o la nube trabajan.
   */
  private async cutChunk() {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = undefined;

    const { wav, durationMs } = rec.stop();
    this.reportFloor(noiseFloorDb(wav));
    this.heard = false;
    this.chunkStart = Date.now();
    this.lastVoice = this.chunkStart;

    if (this.handsFree && !this.recorder) {
      try {
        this.recorder = startRecording();
      } catch (err) {
        this.offHandsFree();
        this.post({ type: "level", value: 0 });
        this.fail(err);
        return;
      }
    } else {
      this.post({ type: "level", value: 0 });
    }

    // La decisión se toma sobre el audio grabado, no sobre el último sondeo.
    if (durationMs >= MIN_CHUNK_MS && voiceMs(wav) >= MIN_VOICE_MS) void this.transcribe(wav, durationMs);
    else if (!this.handsFree) this.state("idle");
  }

  /** Transcribe un WAV; los fragmentos de manos libres se encolan en orden. */
  private transcribe(wav: Buffer, durationMs: number): Promise<void> {
    const work = async () => {
      const s = this.settings();
      // El filtro va al transcribir, no al grabar: sigue el ajuste del panel y
      // no altera el vúmetro.
      const audio = s.denoise
        ? denoiseWav(wav, {
            // 0 significa "mide el fondo en cada fragmento".
            floorDb: s.noiseFloor || undefined,
            toleranceDb: s.tolerance,
          })
        : wav;
      this.busy = true;
      this.state("working", `Transcribiendo ${(durationMs / 1000).toFixed(1)} s…`);
      try {
        let text = "";
        if (s.engine === "whisper") {
          text = await whisperText({
            dir: this.whisperDir(),
            model: s.whisperModel,
            wav: audio,
            language: s.language,
            onLog: (m) => this.state("working", m),
          });
          this.post({ type: "whisperReady", ready: true });
        } else {
          const key = (await this.context.secrets.get(KEY_SECRET)) ?? "";
          text = await cloudText({ url: s.cloudUrl, model: s.cloudModel, key, language: s.language, wav: audio });
        }
        if (text) this.post({ type: "text", text });
        else this.state(this.handsFree ? "listening" : "idle", "No se entendió nada.");
        if (text) this.state(this.handsFree ? "listening" : "idle");
      } catch (err) {
        this.fail(err);
        this.state(this.handsFree ? "listening" : "idle");
      } finally {
        this.busy = false;
      }
    };
    this.chain = this.chain.then(work, work);
    return this.chain;
  }

  /** Manda el bloc de notas al terminal activo (donde suele correr el agente). */
  private async sendPrompt(raw: string) {
    // Una sola línea: en los agentes de terminal, cada salto de línea envía.
    const text = raw.replace(/\s*\r?\n+\s*/g, " ").trim();
    if (!text) {
      this.state("error", "El bloc está vacío.");
      return;
    }

    const terminal = vscode.window.activeTerminal;
    if (terminal) {
      terminal.show(true);
      // Los TUI (Claude, opencode) toman el bloque como pegado y no lo envían: el
      // Enter va en una escritura aparte, cuando el texto ya está en su cuadro.
      terminal.sendText(text, false);
      setTimeout(() => {
        try {
          terminal.sendText("\r", false);
        } catch {
          // La terminal se cerró entre el texto y el Enter.
        }
      }, 100);
      this.state("idle", `Enviado a ${terminal.name}.`);
      return;
    }

    await vscode.env.clipboard.writeText(text);
    this.state("idle", "Sin terminal abierta: copiado al portapapeles.");
    void vscode.window.showInformationMessage(
      "VOZ: no hay terminal activa; el prompt se ha copiado al portapapeles.",
    );
  }

  private fail(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.state("error", message);
    void vscode.window.showErrorMessage(`VOZ dictado: ${message}`);
  }

  /** Genera el HTML del panel. Público para las comprobaciones. */
  html(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const nonce = Math.random().toString(36).slice(2);
    const css = [
      webview.asWebviewUri(vscode.Uri.joinPath(media, "tokens.css")),
      webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css")),
      webview.asWebviewUri(vscode.Uri.joinPath(media, "dictado.css")),
    ]
      .map((uri) => `<link rel="stylesheet" href="${uri}" />`)
      .join("\n");
    const script = `<script nonce="${nonce}" src="${webview.asWebviewUri(
      vscode.Uri.joinPath(media, "dictado.js"),
    )}"></script>`;

    // El marcado vive en media/dictado.html: así la prueba visual usa
    // exactamente el mismo HTML que la extensión.
    const template = readFileSync(join(this.context.extensionUri.fsPath, "media", "dictado.html"), "utf8");
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replace("<!--CSS-->", css)
      .replace("<!--SCRIPT-->", script);
  }

  dispose() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.recorder?.stop();
    this.sapi?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
