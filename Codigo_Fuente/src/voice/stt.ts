/**
 * Motores de voz a texto.
 *
 *  - sapi:    reconocedor de Windows, sin instalar nada. Escucha en su propio
 *             proceso de PowerShell (System.Speech) y devuelve frases.
 *  - whisper: Whisper local (transformers.js + onnxruntime). Se instala bajo
 *             demanda, en la carpeta de datos de la extensión.
 *  - nube:    API compatible con OpenAI (`/audio/transcriptions`).
 *
 * Los dos últimos graban el micrófono con voz-core (waveIn) y reciben un WAV
 * de 16 kHz mono, que es justo lo que esperan.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mixToMono, noiseFloorDb, denoiseWav, startRecording, wavOf, wavToPcm, type Recorder } from "./core/index.js";

export type SttEngine = "sapi" | "whisper" | "nube";

/** Endpoint de la nube por defecto (compatible con OpenAI). */
export const CLOUD_URL_DEFAULT = "https://api.openai.com/v1/audio/transcriptions";

/** Clave de `secrets` donde vive la clave de la API de transcripción. */
export const KEY_SECRET = "voz.dictado.apiKey";

export const STT_ENGINES: Array<{ id: SttEngine; label: string; hint: string }> = [
  { id: "sapi", label: "Windows (SAPI)", hint: "Gratis, local, inmediato." },
  { id: "whisper", label: "Whisper local", hint: "Local. Se descarga una vez." },
  { id: "nube", label: "Nube (OpenAI)", hint: "La mejor precisión. Necesita clave." },
];

/** Idiomas ofrecidos. SAPI sólo tiene instalado el que tenga Windows. */
export const STT_LANGUAGES = [
  { id: "es-ES", label: "Español (España)" },
  { id: "es-MX", label: "Español (México)" },
  { id: "en-US", label: "English (US)" },
  { id: "fr-FR", label: "Français" },
  { id: "de-DE", label: "Deutsch" },
  { id: "it-IT", label: "Italiano" },
  { id: "pt-BR", label: "Português (Brasil)" },
];

export interface SapiHandlers {
  onText(text: string): void;
  onState(state: { listening?: boolean; error?: string }): void;
  /** Nivel del micro (0..1), unas 10 veces por segundo mientras escucha. */
  onLevel?(value: number): void;
  /** Aviso no fatal (p. ej. se vuelve al micro por defecto). */
  onWarn?(text: string): void;
}

/** Micro y filtro que SAPI aplica al audio que graba la extensión. */
export interface SapiMicOptions {
  device?: number;
  /** Multiplicador (1 = sin cambios). */
  gain: number;
  denoise: boolean;
  /** Fondo fijado en dBFS; 0/ausente = se mide sobre los últimos 2 s. */
  floorDb?: number;
  toleranceDb: number;
}

/** Bloque mínimo que se filtra (100 ms: la puerta necesita 5 tramos de 20 ms). */
const DENOISE_BLOCK_BYTES = 3200;
/** Cola de audio sobre la que se mide el fondo (2 s). */
const FLOOR_TAIL_BYTES = 64000;

let sapiCounter = 0;

/**
 * Puente con el reconocedor de Windows.
 *
 * El proceso se arranca en la primera pulsación y queda en espera. Escuchar o
 * no se decide con un fichero bandera: así no hay que cargar el motor en cada
 * pulsación (casi un segundo) ni perder las primeras palabras.
 */
export class SapiDictado {
  private child?: ChildProcess;
  private buffer = "";
  private readonly dir = join(tmpdir(), `voz-dictado-${process.pid}-${++sapiCounter}`);
  private failed = false;
  /** El proceso recibe el audio por stdin (la extensión graba) en vez de abrir el micro. */
  private streamMode = false;
  private rec?: Recorder;
  private pump?: ReturnType<typeof setInterval>;
  private pending: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private opts?: SapiMicOptions;
  private pumpTicks = 0;

  constructor(
    private readonly script: string,
    private readonly language: string,
    private readonly handlers: SapiHandlers,
    private readonly micOptions?: () => SapiMicOptions,
  ) {}

  /** Empieza a escuchar (arranca el proceso si aún no está). */
  start(): void {
    // La extensión abre el micro con los ajustes del panel; si no puede, SAPI usa el suyo.
    this.stopRecorder();
    let rec: Recorder | undefined;
    if (this.micOptions) {
      try {
        this.opts = this.micOptions();
        rec = startRecording({ device: this.opts.device, gain: this.opts.gain });
      } catch (err) {
        this.handlers.onWarn?.(
          `No se pudo abrir el micrófono elegido (${err instanceof Error ? err.message : String(err)}); se usa el micrófono por defecto de Windows.`,
        );
      }
    }
    try {
      // Un proceso ya vivo en el otro modo no sirve: se relanza.
      if (this.child && this.streamMode !== Boolean(rec)) {
        const old = this.child;
        this.child = undefined;
        old.kill();
      }
      this.ensure(Boolean(rec));
    } catch (err) {
      rec?.stop();
      throw err;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "active"), "");
    if (rec) this.startPump(rec);
  }

  /** Deja de escuchar: la frase en curso aún puede llegar. */
  stop(): void {
    this.stopRecorder();
    // Un silencio al final cierra la frase que SAPI tenga abierta (el fin de locución se mide en audio).
    if (this.streamMode) this.write(Buffer.alloc(32000));
    rmSync(join(this.dir, "active"), { force: true });
    rmSync(join(this.dir, "quit"), { force: true });
    this.handlers.onLevel?.(0);
  }

  private write(data: Buffer) {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(data);
  }

  private stopRecorder() {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
    try {
      this.rec?.stop();
    } catch {
      // Ya cerrado.
    }
    this.rec = undefined;
    this.pending = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
  }

  /** Cada 50 ms pasa a SAPI el audio nuevo (con filtro de ruido si está activo) y mueve el vúmetro. */
  private startPump(rec: Recorder) {
    this.rec = rec;
    this.pumpTicks = 0;
    this.pump = setInterval(() => {
      try {
        let cur = this.rec;
        if (!cur) return;
        let chunk = cur.pull();
        // El búfer del grabador es de 60 s y no circular: se reabre antes de llenarlo.
        if (cur.remainingMs() < 2000) {
          chunk = Buffer.concat([chunk, cur.pull()]);
          cur.stop();
          cur = startRecording({ device: this.opts?.device, gain: this.opts?.gain });
          this.rec = cur;
        }
        this.feed(chunk);
        if (++this.pumpTicks % 2 === 0) this.handlers.onLevel?.(cur.level());
      } catch (err) {
        this.stopRecorder();
        this.failed = true;
        this.handlers.onState({ error: `Se perdió el micrófono: ${err instanceof Error ? err.message : String(err)}` });
      }
    }, 50);
  }

  private feed(chunk: Buffer) {
    if (chunk.length === 0) return;
    const o = this.opts;
    if (!o?.denoise) {
      this.write(chunk);
      return;
    }
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.pending.length < DENOISE_BLOCK_BYTES) return;
    const block = this.pending;
    this.pending = Buffer.alloc(0);
    // Fondo: el fijado en el panel o, si no, el medido en los últimos 2 s (la puerta
    // necesita una referencia que un bloque de 100 ms de voz no da).
    this.tail = Buffer.concat([this.tail, block]).subarray(-FLOOR_TAIL_BYTES);
    const floor = o.floorDb || noiseFloorDb(wavOf(this.tail)) || undefined;
    const clean = denoiseWav(wavOf(block), { floorDb: floor, toleranceDb: o.toleranceDb });
    this.write(clean.subarray(44));
  }

  private ensure(stream: boolean): void {
    if (this.failed) throw new Error("El reconocedor de Windows no arrancó.");
    if (this.child && !this.child.killed) return;
    this.streamMode = stream;

    mkdirSync(this.dir, { recursive: true });
    rmSync(join(this.dir, "quit"), { force: true });
    rmSync(join(this.dir, "active"), { force: true });

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        this.script,
        "-Dir",
        this.dir,
        "-Culture",
        this.language,
        ...(stream ? ["-Stream"] : []),
      ],
      { windowsHide: true },
    );
    this.child = child;
    // Cerrar el proceso con el flujo a medias no debe tumbar la extensión por un EPIPE.
    child.stdin?.on("error", () => {});

    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.handlers.onState({ error: text });
    });
    child.on("exit", () => {
      if (this.child !== child) return; // relanzado en otro modo: este ya no cuenta
      this.stopRecorder();
      this.child = undefined;
      this.handlers.onLevel?.(0);
      if (!this.failed) this.handlers.onState({ listening: false });
    });
    child.on("error", (err) => {
      this.failed = true;
      this.handlers.onState({ error: `No se pudo arrancar PowerShell: ${err.message}` });
    });
  }

  private handleLine(line: string) {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    try {
      const ev = JSON.parse(text);
      if (ev.ev === "level") {
        // Con flujo el vúmetro sale del grabador de la extensión.
        if (this.streamMode && this.rec) return;
        // Solo con el micro activo: un evento tardío tras stop() no debe reanimar el vúmetro.
        if (existsSync(join(this.dir, "active"))) {
          this.handlers.onLevel?.(Math.max(0, Math.min(1, Number(ev.value) / 100 || 0)));
        }
      } else if (ev.ev === "final" && ev.text) this.handlers.onText(String(ev.text));
      else if (ev.ev === "warn") {
        // El flujo falló y SAPI abrió el micro por defecto: el audio de la extensión ya no se lee.
        this.stopRecorder();
        this.streamMode = false;
        this.handlers.onWarn?.(String(ev.text ?? "Se usa el micrófono por defecto de Windows."));
      } else if (ev.ev === "state") this.handlers.onState({ listening: Boolean(ev.listening) });
      else if (ev.ev === "error") {
        this.failed = true;
        this.handlers.onState({ error: String(ev.text ?? "error del reconocedor") });
      }
    } catch {
      // Línea suelta (aviso de PowerShell): se ignora.
    }
  }

  dispose() {
    this.stopRecorder();
    this.handlers.onLevel?.(0);
    if (!this.child) return;
    try {
      writeFileSync(join(this.dir, "quit"), "");
    } catch {
      // La carpeta pudo desaparecer: el proceso también acabará.
    }
    const child = this.child;
    child.stdin?.end(); // fin de audio: el script sale solo
    setTimeout(() => child.kill(), 1500);
    this.child = undefined;
  }
}

// ── Whisper local ───────────────────────────────────────────────────────────

/** Modelos ofrecidos en la interfaz. */
export const WHISPER_MODELS = [
  { id: "onnx-community/whisper-tiny", label: "Tiny · 40 MB · rápido" },
  { id: "onnx-community/whisper-base", label: "Base · 80 MB · equilibrado" },
  { id: "onnx-community/whisper-small", label: "Small · 250 MB · preciso" },
];

let whisperModule: any;
let whisperPipe: { model: string; pipe: any } | undefined;

/** true si transformers.js ya está instalado en `dir`. */
export function whisperInstalled(dir: string): boolean {
  return existsSync(join(dir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs"));
}

/**
 * Instala transformers.js bajo demanda y devuelve el módulo.
 * Se hace con npm en lugar de empaquetarlo: son más de 100 MB de binarios.
 */
export async function loadWhisper(
  dir: string,
  onLog: (message: string) => void,
): Promise<any> {
  if (whisperModule) return whisperModule;

  if (!whisperInstalled(dir)) {
    onLog("Instalando Whisper (una sola vez)…");
    mkdirSync(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.env.ComSpec ?? "cmd.exe",
        ["/c", "npm", "install", "@huggingface/transformers", "--no-audit", "--no-fund", "--loglevel=error"],
        { cwd: dir, windowsHide: true, timeout: 10 * 60 * 1000 },
        (err, _out, stderr) => {
          if (err) reject(new Error(`No se pudo instalar Whisper: ${String(stderr).slice(0, 300)}`));
          else resolve();
        },
      );
    });
  }

  const entry = `file://${join(dir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")}`;
  whisperModule = await import(entry);
  whisperModule.env.cacheDir = join(dir, ".cache");
  return whisperModule;
}

/** Corta el silencio de los extremos: acelera y evita alucinaciones. */
function trimSilence(samples: Float32Array, threshold = 0.008): Float32Array {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;
  if (end - start < 1600) return samples; // menos de 100 ms: no tocar
  return samples.subarray(start, end);
}

/** Transcribe un WAV con Whisper local. */
export async function whisperText(opts: {
  dir: string;
  model: string;
  wav: Buffer;
  language: string;
  onLog: (message: string) => void;
}): Promise<string> {
  const mod = await loadWhisper(opts.dir, opts.onLog);
  const pcm = wavToPcm(opts.wav);
  let samples = mixToMono(pcm.channels);

  // El micrófono ya graba a 16 kHz; esto cubre WAV de otra procedencia.
  if (pcm.sampleRate !== 16000) {
    const ratio = 16000 / pcm.sampleRate;
    const out = new Float32Array(Math.floor(samples.length * ratio));
    for (let i = 0; i < out.length; i++) {
      const x = i / ratio;
      const i0 = Math.floor(x);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0);
    }
    samples = out;
  }

  if (whisperPipe?.model !== opts.model) {
    opts.onLog(
      whisperPipe ? "Cambiando de modelo…" : "Cargando Whisper (la primera vez descarga el modelo)…",
    );
    const pipe = await mod.pipeline("automatic-speech-recognition", opts.model, {
      dtype: "q8",
      progress_callback: (p: any) => {
        if (p?.status === "progress" && p.file && typeof p.progress === "number") {
          opts.onLog(`Descargando ${p.file}: ${Math.round(p.progress)}%`);
        }
      },
    });
    whisperPipe = { model: opts.model, pipe };
  }

  const result = await whisperPipe.pipe(trimSilence(samples), {
    language: whisperLanguage(opts.language),
    task: "transcribe",
  });
  return String(Array.isArray(result) ? result.map((r: any) => r.text).join(" ") : result.text ?? "").trim();
}

/** es-ES -> spanish (Whisper usa nombres, no códigos). */
function whisperLanguage(language: string): string {
  const names: Record<string, string> = {
    es: "spanish",
    en: "english",
    fr: "french",
    de: "german",
    it: "italian",
    pt: "portuguese",
  };
  return names[language.slice(0, 2).toLowerCase()] ?? "spanish";
}

// ── Nube ────────────────────────────────────────────────────────────────────

/**
 * Transcribe con una API compatible con OpenAI.
 * Devuelve el texto y, si la API no responde, un error legible.
 */
export async function cloudText(opts: {
  url: string;
  model: string;
  key: string;
  language: string;
  wav: Buffer;
}): Promise<string> {
  if (!opts.key) throw new Error("Falta la clave de la API. Guárdala en los ajustes WHISPER del panel de voz.");

  const form = new FormData();
  form.append("file", new Blob([opts.wav as unknown as ArrayBuffer], { type: "audio/wav" }), "dictado.wav");
  form.append("model", opts.model);
  form.append("language", opts.language.slice(0, 2).toLowerCase());
  form.append("response_format", "json");

  const res = await fetch(opts.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.key}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`La nube respondió ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { text?: string };
  return String(data.text ?? "").trim();
}
