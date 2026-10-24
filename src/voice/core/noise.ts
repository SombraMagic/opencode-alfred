/**
 * Limpieza del micrófono antes de transcribir.
 *
 * Recibe el WAV que produce `wavOf` (16 kHz mono 16-bit, cabecera de 44 bytes)
 * y devuelve otro WAV del mismo tamaño: nunca se alarga ni se acorta, así el
 * resto del dictado no cambia.
 *
 *  - Paso alto a ~100 Hz: quita retumbe, zumbido eléctrico y offset DC.
 *  - Puerta suave: lo que queda por debajo de la tolerancia sobre el ruido de
 *    fondo se atenúa como mucho −15 dB, abriendo en 5 ms y cerrando en 150 ms.
 *    Abrir rápido evita comerse el inicio de las palabras; cerrar despacio, las
 *    colas.
 *
 * Si la grabación no tiene pausas (rango dinámico < 12 dB) la puerta no se
 * aplica: es la forma barata de no comerse el habla continua. En ese caso sólo
 * queda el paso alto. Con un fondo fijado por el usuario sí se aplica siempre:
 * para eso lo ha fijado.
 *
 * `voiceMs` usa la misma medida de energía para decidir si un fragmento tiene
 * voz antes de mandarlo a transcribir.
 *
 * shortcut: no separa voz de ruido con la misma energía; para eso haría falta
 *           RNNoise o similar. Cambiar si el ruido sigue colándose.
 */
import { RECORD_RATE } from "./recorder.js";

const HEADER = 44;
/** Tramos en los que se mide el ruido de fondo. */
const FRAME_MS = 20;
/** Atenuación máxima de la puerta (dB). */
const GATE_DB = -15;
/** dB sobre el ruido de fondo a los que abre la puerta, si no se indica otra. */
const DEFAULT_TOLERANCE_DB = 6;
/** Apertura y cierre de la puerta (ms). */
const OPEN_MS = 5;
const CLOSE_MS = 150;
/** Frecuencia de corte del paso alto (Hz): por debajo está el retumbe. */
const HIGH_PASS_HZ = 100;

export interface DenoiseOptions {
  /** Ruido de fondo fijado (dBFS). Si falta, se mide en cada fragmento. */
  floorDb?: number;
  /** dB sobre el fondo a los que abre la puerta. Por defecto 6. */
  toleranceDb?: number;
}

export function denoiseWav(wav: Buffer, options: DenoiseOptions = {}): Buffer {
  // Sólo el WAV del grabador: si llega otra cosa, se deja intacta.
  if (wav.length <= HEADER || wav.toString("ascii", 0, 4) !== "RIFF") return wav;

  const count = Math.floor((wav.length - HEADER) / 2);
  const samples = new Float32Array(count);

  // Paso alto de un polo.
  const a = Math.exp((-2 * Math.PI * HIGH_PASS_HZ) / RECORD_RATE);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < count; i++) {
    const v = wav.readInt16LE(HEADER + i * 2) / 32768;
    prevOut = a * (prevOut + v - prevIn);
    prevIn = v;
    samples[i] = prevOut;
  }

  gate(samples, options);

  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return Buffer.concat([wav.subarray(0, HEADER), pcm]);
}

/**
 * Ruido de fondo medido en el WAV (dBFS), o `null` si no hay señal.
 * Es el valor que usaría la puerta si no estuviera fijado.
 */
export function noiseFloorDb(wav: Buffer): number | null {
  if (wav.length <= HEADER || wav.toString("ascii", 0, 4) !== "RIFF") return null;

  const rms = frameRms(readSamples(wav));
  if (rms.length < 5) return null;

  const floor = Float32Array.from(rms).sort()[Math.floor(rms.length * 0.2)];
  return floor > 0 ? 20 * Math.log10(floor) : null;
}

/**
 * Milisegundos de voz real en el WAV: distingue hablar de ruido de fondo.
 *
 * El umbral se mide contra el propio ruido de la grabación (percentil 20), así
 * que sube en una sala ruidosa y baja en una callada. Nunca baja de 0.0035
 * (−49 dBFS), para que un micro muteado o un silencio digital den 0.
 *
 * Si no hay pausas (todo el fragmento suena igual) no se puede separar voz de
 * ruido: cuenta como voz sólo si es claramente fuerte (≥ 0.03, −30 dBFS).
 */
export function voiceMs(wav: Buffer): number {
  if (wav.length <= HEADER || wav.toString("ascii", 0, 4) !== "RIFF") return 0;

  const rms = frameRms(readSamples(wav));
  if (rms.length < 5) return 0;

  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(rms.length * 0.2)];
  const peak = sorted[rms.length - 1];

  if (peak < 0.0035) return 0;
  if (peak < floor * 4) return peak >= 0.03 ? rms.length * FRAME_MS : 0;

  const threshold = Math.max(floor * 3, 0.0035);
  let voiced = 0;
  for (const v of rms) if (v >= threshold) voiced++;
  return voiced * FRAME_MS;
}

/** Energía (RMS) por tramos de `FRAME_MS`. */
function frameRms(samples: Float32Array): Float32Array {
  const size = Math.round((RECORD_RATE * FRAME_MS) / 1000);
  const frames = Math.floor(samples.length / size);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) sum += samples[i] * samples[i];
    rms[f] = Math.sqrt(sum / size);
  }
  return rms;
}

/** PCM 16-bit del WAV a float (−1..1). */
function readSamples(wav: Buffer): Float32Array {
  const count = Math.floor((wav.length - HEADER) / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = wav.readInt16LE(HEADER + i * 2) / 32768;
  return out;
}

/** Baja −15 dB, con transiciones suaves, lo que está bajo el ruido de fondo. */
function gate(samples: Float32Array, options: DenoiseOptions): void {
  const size = Math.round((RECORD_RATE * FRAME_MS) / 1000);
  const rms = frameRms(samples);
  const frames = rms.length;
  if (frames < 5) return;

  const sorted = Float32Array.from(rms).sort();
  const fixed = options.floorDb !== undefined;
  const floor = fixed ? Math.pow(10, options.floorDb! / 20) : sorted[Math.floor(frames * 0.2)];
  const peak = sorted[frames - 1];
  if (floor <= 0) return;
  // Sin pausas claras no se puede separar ruido de voz: mejor no tocar.
  // Con un fondo fijado se respeta el ajuste aunque no haya pausas.
  if (!fixed && peak < floor * 4) return;

  const quiet = Math.pow(10, GATE_DB / 20);
  const tolerance = options.toleranceDb ?? DEFAULT_TOLERANCE_DB;
  const threshold = floor * Math.pow(10, tolerance / 20);
  const open = 1 - Math.exp(-1 / ((RECORD_RATE * OPEN_MS) / 1000));
  const close = 1 - Math.exp(-1 / ((RECORD_RATE * CLOSE_MS) / 1000));

  let gain = 1;
  for (let i = 0; i < samples.length; i++) {
    const target = rms[Math.min(frames - 1, Math.floor(i / size))] < threshold ? quiet : 1;
    gain += (target - gain) * (target > gain ? open : close);
    samples[i] *= gain;
  }
}
