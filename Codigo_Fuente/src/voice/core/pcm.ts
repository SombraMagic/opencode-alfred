/**
 * Conversión de audio a PCM y extracción de la envolvente para el ecualizador.
 *
 * - WAV: se lee directamente (PCM 16-bit little-endian).
 * - MP3: se decodifica con mpg123 (WASM, sin binarios nativos).
 */
import type { TtsMotor } from "./types.js";

export interface Pcm {
  /** Muestras interleaved por canal. */
  channels: Float32Array[];
  sampleRate: number;
  durationMs: number;
}

/** Decodifica MP3/WAV a PCM float. */
export async function toPcm(data: Buffer, format: "wav" | "mp3"): Promise<Pcm> {
  if (format === "wav") return wavToPcm(data);
  return mp3ToPcm(data);
}

export function wavToPcm(buf: Buffer): Pcm {
  if (buf.length < 44) throw new Error("WAV inválido: demasiado corto");

  let off = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let audioFormat = 1;
  let dataOff = -1;
  let dataLen = 0;

  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;

    if (id === "fmt ") {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size % 2);
  }

  if (dataOff < 0) throw new Error("WAV inválido: falta el chunk 'data'");
  if (audioFormat !== 1) throw new Error(`WAV inválido: solo se admite PCM (format ${audioFormat})`);
  if (bitsPerSample !== 16) throw new Error(`WAV inválido: solo se admite 16 bit (${bitsPerSample})`);

  const frames = Math.floor(dataLen / 2 / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * 2;
      out[c][i] = buf.readInt16LE(p) / 32768;
    }
  }

  return { channels: out, sampleRate, durationMs: Math.round((frames / sampleRate) * 1000) };
}

export async function mp3ToPcm(buf: Buffer): Promise<Pcm> {
  // mpg123-decoder es ESM y el bundle es CJS: se carga al vuelo.
  const { MPEGDecoder } = await import("mpg123-decoder");
  const decoder = new MPEGDecoder();
  await decoder.ready;
  const result = decoder.decode(new Uint8Array(buf));
  const durationMs = Math.round((result.samplesDecoded / result.sampleRate) * 1000);
  return { channels: result.channelData, sampleRate: result.sampleRate, durationMs };
}

/**
 * Envolvente de amplitud en `bands` bandas, normalizada a 0..1.
 * Es lo que alimenta el ecualizador esférico.
 */
export function envelope(pcm: Pcm, bands = 32): number[] {
  const mono = mixToMono(pcm.channels);
  if (mono.length === 0) return new Array(bands).fill(0);

  const size = Math.max(1, Math.floor(mono.length / bands));
  const env: number[] = [];
  let peak = 0;

  for (let b = 0; b < bands; b++) {
    let max = 0;
    const start = b * size;
    const end = Math.min(start + size, mono.length);
    for (let i = start; i < end; i++) {
      const v = Math.abs(mono[i]);
      if (v > max) max = v;
    }
    env.push(max);
    if (max > peak) peak = max;
  }

  if (peak > 0) {
    for (let i = 0; i < bands; i++) env[i] = Math.min(1, env[i] / peak);
  }
  return env;
}

/** Mezcla los canales a mono. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}
