/**
 * Botonera de comandos del panel de dictado, compartida con el MCP `mcp_alfred`.
 * Sin `vscode`: vive en `%APPDATA%\voz\dictado-comandos.json` (`stateDir()`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../voice/core/shared.js";
import { writeAtomic } from "../pizarra/files";

export const MAX_BOTONES = 10;
export const MAX_COMANDO = 200;

export interface Comandos {
  botones: string[];
  /** Índice del botón encendido, o null. */
  activo: number | null;
}

export function comandosFile(): string {
  return join(stateDir(), "dictado-comandos.json");
}

/** Texto de un botón saneado, o "" si no vale (vacío, con saltos de línea o demasiado largo). */
export function limpiarComando(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  return t.length > MAX_COMANDO || /[\r\n]/.test(t) ? "" : t;
}

function sanear(raw: any): Comandos {
  const lista: unknown[] = Array.isArray(raw?.botones) ? raw.botones : [];
  const botones = lista.map(limpiarComando).filter(Boolean).slice(0, MAX_BOTONES);
  const a = raw?.activo;
  const activo = Number.isInteger(a) && a >= 0 && a < botones.length ? (a as number) : null;
  return { botones, activo };
}

/** Lee la botonera; fichero ausente o roto = vacía. */
export function leerComandos(): Comandos {
  try {
    return sanear(JSON.parse(readFileSync(comandosFile(), "utf8")));
  } catch {
    return { botones: [], activo: null };
  }
}

/** Sanea y escribe (tmp + rename). Devuelve lo guardado. */
export async function escribirComandos(c: Comandos): Promise<Comandos> {
  const limpio = sanear(c);
  await writeAtomic(comandosFile(), Buffer.from(JSON.stringify(limpio, null, 2), "utf8"));
  return limpio;
}
