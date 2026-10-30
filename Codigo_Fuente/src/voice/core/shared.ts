/**
 * Estado compartido entre la extensión y el servidor MCP.
 *
 * Son procesos distintos: la extensión corre dentro de VS Code y el MCP lo
 * lanza el agente. No comparten memoria ni entorno, así que el único canal
 * común sin dependencias es un fichero en %APPDATA%\voz.
 *
 * - config.json: ajustes (motor, voz, velocidad...). Lo escribe la extensión
 *   cuando el usuario cambia algo y lo lee el MCP en cada llamada, para que
 *   ambos hablen igual.
 * - now.json: evento de reproducción. Lo escribe quien habla y lo vigila la
 *   extensión para mover el ecualizador aunque la voz venga del MCP.
 * - entorno.json: rutas del proyecto abierto que necesita el MCP (la pizarra en
 *   `.alfred/adjuntos`). La extensión lo escribe al activar y el MCP lo lee en cada
 *   llamada: la ruta depende del proyecto abierto.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TtsMotor } from "./types.js";

export interface VozConfig {
  engine?: string;
  voice?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  device?: number;
}

/** Evento de reproducción, para que otra ventana mueva el ecualizador. */
export interface PlaybackEvent {
  id: string;
  /** Epoch en ms del inicio de la reproducción. */
  startedAt: number;
  durationMs: number;
  envelope: number[];
  energy: number[];
  /** Texto dicho, para que el panel lo deje escrito y se pueda repetir. */
  text?: string;
}

/** Carpeta de estado compartido. */
export function stateDir(): string {
  // VOZ_STATE_DIR permite aislarlo (pruebas) sin tocar el APPDATA del usuario.
  if (process.env.VOZ_STATE_DIR) return process.env.VOZ_STATE_DIR;
  const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(base, "voz");
}

/** Configuración compartida; {} si no existe o está corrupta. */
export function readConfig(): VozConfig {
  try {
    return JSON.parse(readFileSync(join(stateDir(), "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Fusiona y guarda la configuración compartida. */
export function writeConfig(patch: VozConfig): void {
  const merged = { ...readConfig(), ...patch };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "config.json"), JSON.stringify(merged, null, 2), "utf8");
}

/** Publica el evento de reproducción (lo consume la extensión). */
export function publishPlayback(event: PlaybackEvent): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "now.json"), JSON.stringify(event), "utf8");
}

/** Entorno compartido: dónde vive lo que no es voz (la pizarra del proyecto). */
export interface Entorno {
  pizarraDir?: string;
}

/** Entorno compartido; {} si no existe o está corrupto. */
export function readEntorno(): Entorno {
  try {
    return JSON.parse(readFileSync(join(stateDir(), "entorno.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Fusiona y guarda el entorno compartido (tmp + rename: el MCP puede leerlo a la vez). */
export function writeEntorno(patch: Entorno): void {
  const merged = { ...readEntorno(), ...patch };
  const file = join(stateDir(), "entorno.json");
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(stateDir(), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
  } catch (err) {
    // No se deja el temporal a medias si el disco falla.
    try {
      unlinkSync(tmp);
    } catch {
      // Tampoco existía.
    }
    throw err;
  }
  renameSync(tmp, file);
}

/**
 * Voz pedida si existe en el motor; si no, la primera disponible.
 *
 * Evita el fallo típico de guardar una voz de Edge y luego cambiar a SAPI:
 * el identificador ya no existe y la síntesis fallaría.
 */
export async function resolveVoice(motor: TtsMotor, wanted?: string): Promise<string> {
  const voices = await motor.listVoices();
  if (wanted && voices.some((v) => v.id === wanted)) return wanted;
  return voices[0]?.id ?? "";
}
