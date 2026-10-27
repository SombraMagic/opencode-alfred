/**
 * Motor Edge TTS: voces neuronales de Microsoft Edge, gratis y sin clave.
 *
 * Usa la misma API que "Edge read aloud" a través del servicio no oficial
 * de Microsoft (ver edge-ws.ts). Requiere internet; puede cambiar sin aviso.
 */
import { listEdgeVoices, speakEdge } from "../edge-ws.js";
import type { MotorId, SynthOptions, SynthResult, TtsMotor, VoiceInfo } from "../types.js";

export class EdgeMotor implements TtsMotor {
  readonly id: MotorId = "edge";
  readonly label = "Microsoft Edge (TTS)";
  readonly free = true;
  readonly needsNetwork = true;

  async isAvailable(): Promise<boolean> {
    try {
      await this.listVoices();
      return true;
    } catch {
      return false;
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const voices = await listEdgeVoices();
    return voices.map((v) => ({
      id: v.id,
      name: v.name,
      locale: v.locale,
      gender: v.gender,
      engine: "edge",
    }));
  }

  async synthesize(text: string, voice: string, options: SynthOptions = {}): Promise<SynthResult> {
    // El servicio aplica límites de peticiones (HTTP 429) y puede tardar:
    // acotamos cada intento para no dejar la llamada colgada.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await withTimeout(
          this.synthesizeOnce(text, voice, options),
          SYNTH_TIMEOUT_MS,
          `Edge TTS tardó más de ${SYNTH_TIMEOUT_MS / 1000}s`,
        );
      } catch (err) {
        lastError = err;
        if (!isRateLimited(err) && !isTimeout(err)) throw err;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private async synthesizeOnce(
    text: string,
    voice: string,
    options: SynthOptions,
  ): Promise<SynthResult> {
    const data = await withTimeout(
      speakEdge(text, voice, {
        rate: options.rate ?? 0,
        pitch: options.pitch ?? 0,
        volume: options.volume ?? 100,
      }),
      SYNTH_TIMEOUT_MS,
      `Edge TTS tardó más de ${SYNTH_TIMEOUT_MS / 1000}s`,
    );
    return { data, format: "mp3", text, engine: this.id, voice };
  }
}

/** true si el error es el límite de peticiones del servicio. */
function isRateLimited(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

/** true si el error es nuestro propio timeout. */
function isTimeout(err: unknown): boolean {
  return String((err as { message?: string })?.message ?? err).includes("tardó más de");
}

/** Límite de tiempo por intento de síntesis. */
const SYNTH_TIMEOUT_MS = 30_000;

/** Rechaza la promesa si tarda demasiado. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
