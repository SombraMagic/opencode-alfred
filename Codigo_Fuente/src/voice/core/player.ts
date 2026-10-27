/**
 * Reproducción en Windows con selección del dispositivo de salida.
 *
 * Se usa la API waveOut de winmm.dll mediante FFI (koffi), porque la WebView
 * de VS Code no permite seleccionar dispositivo de salida (su política de
 * permisos no incluye 'speaker-selection' y setSinkId no está disponible).
 *
 * La ruta verificada es:
 *   waveOutOpen(dispositivo) -> waveOutPrepareHeader -> waveOutWrite -> cerrar
 *
 * shortcut: sólo se reproduce PCM 16-bit; el resto de formatos se convierten
 *           a PCM antes de reproducir. Actualizar si se necesita MP3 directo.
 */
import { createRequire } from "node:module";
import { toPcm, type Pcm } from "./pcm.js";

/**
 * require resuelto desde este fichero. El bundle es CJS (lo exige VS Code),
 * así que __filename siempre existe.
 */
const require = createRequire(__filename);

export interface OutputDevice {
  /** Índice de waveOut. */
  index: number;
  name: string;
  /** true si es el dispositivo predeterminado de Windows. */
  isDefault: boolean;
}

interface WaveFormatEx {
  wFormatTag: number;
  nChannels: number;
  nSamplesPerSec: number;
  nAvgBytesPerSec: number;
  nBlockAlign: number;
  wBitsPerSample: number;
}

/** waveOut puede reproducir 8 y 16 bit PCM. */
const WAVE_FORMAT_PCM = 1;
const WAVE_MAPPER = 0xFFFFFFFF;

let koffi: any;
let winmm: any;
let waveFormatEx: any;

function loadWinmm() {
  if (winmm) return;
  koffi = require("koffi");
  const lib = koffi.load("winmm.dll");

  waveFormatEx = koffi.struct("WAVEFORMATEX", {
    wFormatTag: "uint16",
    nChannels: "uint16",
    nSamplesPerSec: "uint32",
    nAvgBytesPerSec: "uint32",
    nBlockAlign: "uint16",
    wBitsPerSample: "uint16",
    cbSize: "uint16",
  });

  lib.waveOutGetNumDevs = lib.func("int __stdcall waveOutGetNumDevs()");
  lib.waveOutGetDevCapsW = lib.func(
    `int __stdcall waveOutGetDevCapsW(uint32_t, void*, uint32_t)`,
  );
  lib.waveOutOpen = lib.func(
    `int __stdcall waveOutOpen(void*, uint32_t, WAVEFORMATEX*, uint64_t, uint64_t, uint32_t)`,
  );
  lib.waveOutPrepareHeader = lib.func("int __stdcall waveOutPrepareHeader(void*, void*, uint32_t)");
  lib.waveOutWrite = lib.func("int __stdcall waveOutWrite(void*, void*, uint32_t)");
  lib.waveOutUnprepareHeader = lib.func("int __stdcall waveOutUnprepareHeader(void*, void*, uint32_t)");
  lib.waveOutReset = lib.func("int __stdcall waveOutReset(void*)");
  lib.waveOutClose = lib.func("int __stdcall waveOutClose(void*)");
  lib.waveOutGetErrorTextA = lib.func("int __stdcall waveOutGetErrorTextA(uint32_t, char*, uint32_t)");

  winmm = lib;
}

/** Texto de error de waveOut, para diagnóstico. */
function errorText(code: number): string {
  try {
    const buf = Buffer.alloc(256);
    winmm.waveOutGetErrorTextA(code, koffi.address(buf), 256);
    return buf.toString("ascii").split("\0")[0];
  } catch {
    return `código ${code}`;
  }
}

const WAVECAPS_SIZE = 92;

/** Lista las salidas de audio disponibles. */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  if (process.platform !== "win32") return [];
  loadWinmm();
  const count = winmm.waveOutGetNumDevs();
  const devices: OutputDevice[] = [];

  for (let i = 0; i < count; i++) {
    const caps = Buffer.alloc(WAVECAPS_SIZE);
    const rc = winmm.waveOutGetDevCapsW(i, koffi.address(caps), WAVECAPS_SIZE);
    if (rc !== 0) continue;
    // szPname está en el offset 8, 32 WCHAR.
    const name = caps.toString("utf16le", 8, 72).split("\0")[0].trim();
    if (name) devices.push({ index: i, name, isDefault: false });
  }

  if (devices.length > 0) devices[0].isDefault = true;
  return devices;
}

/**
 * Reproduce PCM en el dispositivo indicado.
 * `deviceIndex` es el índice de waveOut; undefined = WAVE_MAPPER (el del sistema).
 */
export async function playPcm(
  pcm: Pcm,
  deviceIndex?: number,
  onEnd?: () => void,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("La reproducción con selección de dispositivo sólo está soportada en Windows.");
  }
  loadWinmm();

  const pcm16 = toPcm16(pcm);
  const fmt: WaveFormatEx = {
    wFormatTag: WAVE_FORMAT_PCM,
    nChannels: pcm.channels.length,
    nSamplesPerSec: pcm.sampleRate,
    nAvgBytesPerSec: pcm.sampleRate * pcm.channels.length * 2,
    nBlockAlign: pcm.channels.length * 2,
    wBitsPerSample: 16,
  };

  const fmtBuf = Buffer.alloc(18);
  fmtBuf.writeUInt16LE(fmt.wFormatTag, 0);
  fmtBuf.writeUInt16LE(fmt.nChannels, 2);
  fmtBuf.writeUInt32LE(fmt.nSamplesPerSec, 4);
  fmtBuf.writeUInt32LE(fmt.nAvgBytesPerSec, 8);
  fmtBuf.writeUInt16LE(fmt.nBlockAlign, 12);
  fmtBuf.writeUInt16LE(fmt.wBitsPerSample, 14);

  const hSlot = koffi.alloc("uint64", 1);
  const device = deviceIndex === undefined ? WAVE_MAPPER : deviceIndex;
  const openRc = winmm.waveOutOpen(hSlot, device, koffi.address(fmtBuf), 0, 0, 0);
  if (openRc !== 0) {
    throw new Error(`No se pudo abrir el dispositivo de audio: ${errorText(openRc)}`);
  }
  const handle = koffi.decode(hSlot, "uint64");

  const pcmPtr = koffi.alloc("uint8", pcm16.length);
  koffi.encode(pcmPtr, "uint8", pcm16, pcm16.length);

  const hdrBuf = Buffer.alloc(48);
  hdrBuf.writeBigUInt64LE(BigInt(pcmPtr), 0);
  hdrBuf.writeUInt32LE(pcm16.length, 8);
  const hdrPtr = koffi.alloc("char", 48);
  koffi.encode(hdrPtr, "char", hdrBuf, 48);
  const prepRc = winmm.waveOutPrepareHeader(handle, hdrPtr, 48);
  if (prepRc !== 0) {
    winmm.waveOutClose(handle);
    throw new Error(`No se pudo preparar el audio: ${errorText(prepRc)}`);
  }

  const writeRc = winmm.waveOutWrite(handle, hdrPtr, 48);
  if (writeRc !== 0) {
    winmm.waveOutUnprepareHeader(handle, hdrPtr, 48);
    winmm.waveOutClose(handle);
    throw new Error(`No se pudo reproducir el audio: ${errorText(writeRc)}`);
  }

  // waveOut no notifica el final: esperamos la duración conocida.
  const waitMs = Math.min(pcm.durationMs + 250, 10 * 60 * 1000);
  await new Promise((r) => setTimeout(r, waitMs));

  winmm.waveOutUnprepareHeader(handle, hdrPtr, 48);
  winmm.waveOutReset(handle);
  winmm.waveOutClose(handle);
  onEnd?.();
}

/** Convierte float a PCM 16-bit interleaved. */
function toPcm16(pcm: Pcm): Buffer {
  const chans = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const out = Buffer.alloc(frames * chans * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chans; c++) {
      const v = Math.max(-1, Math.min(1, pcm.channels[c][i]));
      out.writeInt16LE(Math.round(v * 32767), (i * chans + c) * 2);
    }
  }
  return out;
}
