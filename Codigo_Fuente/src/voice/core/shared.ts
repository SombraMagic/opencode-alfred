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
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
