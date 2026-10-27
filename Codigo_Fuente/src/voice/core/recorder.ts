/**
 * Grabación del micrófono por waveIn (winmm) para los motores que necesitan
 * audio: Whisper local y la nube.
 *
 * SAPI no pasa por aquí: su reconocedor escucha directamente.
 *
 * Se reserva el búfer entero al empezar (60 s) y se recorta al soltar. Es más
 * simple que reciclar trozos pequeños y no pierde audio: a 16 kHz mono 16-bit
 * son 1,9 MB.
 *
 * shortcut: 60 s como máximo por dictado. Subir el tope si se necesitan
 *           grabaciones largas.
 */
import { createRequire } from "node:module";

// El bundle es CJS (lo exige VS Code), así que __filename siempre existe.
const require = createRequire(__filename);

/** Frecuencia de Whisper: 16 kHz. La nube también lo acepta. */
export const RECORD_RATE = 16000;
const MAX_SECONDS = 60;
const WAVE_FORMAT_PCM = 1;
const WAVE_MAPPER = 0xFFFFFFFF;
const WAVEHDR_SIZE = 48;
const BUFFER_BYTES = RECORD_RATE * 2 * MAX_SECONDS;

export interface Recording {
  /** WAV 16 kHz mono 16-bit, listo para Whisper o para la nube. */
  wav: Buffer;
  durationMs: number;
}

export interface Recorder {
  stop(): Recording;
  /** Nivel capturado desde el último sondeo (0..1), para el vúmetro. */
  level(): number;
}

let koffi: any;
let winmm: any;
let formatBuf: Buffer | undefined;

function load() {
  if (winmm) return;
  koffi = require("koffi");
  const lib = koffi.load("winmm.dll");
  lib.waveInGetNumDevs = lib.func("int __stdcall waveInGetNumDevs()");
  lib.waveInOpen = lib.func(
    `int __stdcall waveInOpen(void*, uint32_t, void*, uint64_t, uint64_t, uint32_t)`,
  );
  lib.waveInPrepareHeader = lib.func("int __stdcall waveInPrepareHeader(void*, void*, uint32_t)");
  lib.waveInUnprepareHeader = lib.func(
    "int __stdcall waveInUnprepareHeader(void*, void*, uint32_t)",
  );
  lib.waveInAddBuffer = lib.func("int __stdcall waveInAddBuffer(void*, void*, uint32_t)");
  lib.waveInStart = lib.func("int __stdcall waveInStart(void*)");
  lib.waveInStop = lib.func("int __stdcall waveInStop(void*)");
  lib.waveInReset = lib.func("int __stdcall waveInReset(void*)");
  lib.waveInClose = lib.func("int __stdcall waveInClose(void*)");
  lib.waveInGetErrorTextA = lib.func(
    "int __stdcall waveInGetErrorTextA(uint32_t, char*, uint32_t)",
  );

  // WAVEFORMATEX de 16 kHz, mono, 16 bit.
  formatBuf = Buffer.alloc(18);
  formatBuf.writeUInt16LE(WAVE_FORMAT_PCM, 0);
  formatBuf.writeUInt16LE(1, 2);
  formatBuf.writeUInt32LE(RECORD_RATE, 4);
  formatBuf.writeUInt32LE(RECORD_RATE * 2, 8);
  formatBuf.writeUInt16LE(2, 12);
  formatBuf.writeUInt16LE(16, 14);
  winmm = lib;
}

function errorText(code: number): string {
  try {
    const buf = Buffer.alloc(256);
    winmm.waveInGetErrorTextA(code, koffi.address(buf), 256);
    return buf.toString("ascii").split("\0")[0];
  } catch {
    return `código ${code}`;
  }
}

/** true si Windows tiene algún micrófono utilizable. */
export function hasMicrophone(): boolean {
  if (process.platform !== "win32") return false;
  load();
  return winmm.waveInGetNumDevs() > 0;
}

/**
 * Abre el micrófono predeterminado y empieza a grabar.
 * Lanza un error claro si no hay dispositivo o está ocupado.
 */
export function startRecording(): Recorder {
  if (process.platform !== "win32") {
    throw new Error("El dictado por micrófono sólo está soportado en Windows.");
  }
  load();
  if (winmm.waveInGetNumDevs() === 0) {
    throw new Error("No hay ningún micrófono conectado.");
  }

  const hSlot = koffi.alloc("uint64", 1);
  const rc = winmm.waveInOpen(hSlot, WAVE_MAPPER, koffi.address(formatBuf), 0, 0, 0);
  if (rc !== 0) throw new Error(`No se pudo abrir el micrófono: ${errorText(rc)}`);
  const handle = koffi.decode(hSlot, "uint64");

  const dataPtr = koffi.alloc("uint8", BUFFER_BYTES);
  const hdr = Buffer.alloc(WAVEHDR_SIZE);
  hdr.writeBigUInt64LE(BigInt(dataPtr), 0);
  hdr.writeUInt32LE(BUFFER_BYTES, 8);
  const hdrPtr = koffi.alloc("char", WAVEHDR_SIZE);
  koffi.encode(hdrPtr, "char", hdr, WAVEHDR_SIZE);

  const fail = (what: string, code: number) => {
    winmm.waveInClose(handle);
    throw new Error(`No se pudo grabar (${what}): ${errorText(code)}`);
  };

  const prep = winmm.waveInPrepareHeader(handle, hdrPtr, WAVEHDR_SIZE);
  if (prep !== 0) fail("preparar", prep);
  const add = winmm.waveInAddBuffer(handle, hdrPtr, WAVEHDR_SIZE);
  if (add !== 0) fail("búfer", add);
  const start = winmm.waveInStart(handle);
  if (start !== 0) fail("arrancar", start);

  let stopped = false;

  return {
    level(): number {
      if (stopped) return 0;
      // Sólo el último tramo (100 ms), no el búfer entero.
      const bytes = readRecorded(hdrPtr);
      const from = Math.max(0, bytes - RECORD_RATE * 2 * 0.1);
      const count = Math.floor((bytes - from) / 2);
      if (count <= 0) return 0;
      const arr = koffi.decode(dataPtr, from, "int16", count) as Int16Array;
      let peak = 0;
      for (const v of arr) peak = Math.max(peak, Math.abs(v));
      return Math.min(1, peak / 8000);
    },
    stop(): Recording {
      if (stopped) return { wav: wavOf(Buffer.alloc(0)), durationMs: 0 };
      stopped = true;
      winmm.waveInStop(handle);
      winmm.waveInReset(handle);
      const bytes = readRecorded(hdrPtr);
      winmm.waveInUnprepareHeader(handle, hdrPtr, WAVEHDR_SIZE);
      winmm.waveInClose(handle);

      const pcm = Buffer.alloc(Math.min(bytes, BUFFER_BYTES));
      if (pcm.length > 0) {
        const arr = koffi.decode(dataPtr, "uint8", pcm.length) as number[];
        Buffer.from(arr).copy(pcm);
      }
      return { wav: wavOf(pcm), durationMs: Math.round((pcm.length / 2 / RECORD_RATE) * 1000) };
    },
  };
}

/** dwBytesRecorded de la cabecera (offset 12). */
function readRecorded(hdrPtr: unknown): number {
  const raw = Buffer.from(koffi.decode(hdrPtr, "uint8", WAVEHDR_SIZE) as number[]);
  return Math.min(raw.readUInt32LE(12), BUFFER_BYTES);
}

/** Envuelve PCM 16-bit mono en un WAV mínimo. */
export function wavOf(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RECORD_RATE, 24);
  head.writeUInt32LE(RECORD_RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
