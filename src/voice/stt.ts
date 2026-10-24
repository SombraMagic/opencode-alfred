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
import { mixToMono, wavToPcm } from "./core/index.js";

export type SttEngine = "sapi" | "whisper" | "nube";

export const STT_ENGINES: Array<{ id: SttEngine; label: string; hint: string }> = [
  { id: "sapi", label: "Windows (SAPI)", hint: "Gratis, local, inmediato." },
  { id: "whisper", label: "Whisper local", hint: "Local. Se descarga una vez." },
  { id: "nube", label: "Nube (OpenAI)", hint: "La mejor precisión. Necesita clave." },
];

export interface SapiHandlers {
  onText(text: string): void;
  onState(state: { listening?: boolean; error?: string }): void;
}

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
  private readonly dir = join(tmpdir(), `voz-dictado-${process.pid}`);
  private failed = false;

  constructor(
    private readonly script: string,
    private readonly language: string,
    private readonly handlers: SapiHandlers,
  ) {}

  /** Empieza a escuchar (arranca el proceso si aún no está). */
  start(): void {
    this.ensure();
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "active"), "");
  }

  /** Deja de escuchar: la frase en curso aún puede llegar. */
  stop(): void {
    rmSync(join(this.dir, "active"), { force: true });
    rmSync(join(this.dir, "quit"), { force: true });
  }

  private ensure(): void {
    if (this.failed) throw new Error("El reconocedor de Windows no arrancó.");
    if (this.child && !this.child.killed) return;

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
      ],
      { windowsHide: true },
    );
    this.child = child;

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
      this.child = undefined;
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
      if (ev.ev === "final" && ev.text) this.handlers.onText(String(ev.text));
      else if (ev.ev === "state") this.handlers.onState({ listening: Boolean(ev.listening) });
      else if (ev.ev === "error") {
        this.failed = true;
        this.handlers.onState({ error: String(ev.text ?? "error del reconocedor") });
      }
    } catch {
      // Línea suelta (aviso de PowerShell): se ignora.
    }
  }

  dispose() {
    if (!this.child) return;
    try {
      writeFileSync(join(this.dir, "quit"), "");
    } catch {
      // La carpeta pudo desaparecer: el proceso también acabará.
    }
    const child = this.child;
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
  if (!opts.key) throw new Error("Falta la clave de la API. Guárdala en la columna de configuración.");

  const form = new FormData();
  form.append("file", new Blob([opts.wav as unknown as ArrayBuffer], { type: "audio/wav" }), "dictado.wav");
  form.append("model", opts.model);
  form.append("language", opts.language.slice(0, 2).toLowerCase());
  form.append("response_format", "json");

  const res = await fetch(opts.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.key}` },
    body: form,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`La nube respondió ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as { text?: string };
  return String(data.text ?? "").trim();
}
