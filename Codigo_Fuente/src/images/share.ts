/**
 * Generador de imágenes compartido con los agentes, por la carpeta de estado de voz
 * (`%APPDATA%\voz`, aislable con `VOZ_STATE_DIR`). Son dos procesos distintos: la
 * extensión escribe sus ajustes (y la clave de OpenAI, que el MCP no puede leer de
 * `secrets`) y el MCP deja el último disparo para que el panel lo pinte.
 *
 * Sin la API de VS Code: lo usan el panel y el servidor MCP.
 */
import { readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { stateDir } from "../voice/core/shared.js";
import { writeAtomic } from "../pizarra/files";
import { catalog, probe } from "./comfy";
import { endpointOf } from "./openai";

export interface ImageShare {
  enabled: boolean;
  provider: "comfyui" | "openai";
  url: string;
  port: number;
  openaiUrl: string;
  /** Clave solo mientras está compartido: el proceso MCP no ve `secrets`. */
  openaiKey?: string;
  model: string;
  imagenesDir: string;
  updatedAt: number;
}

export interface ImageShot {
  id: string;
  prompt: string;
  negative: string;
  file: string;
  at: number;
}

const SHARE_FILE = "imagenes.json";
const SHOT_FILE = "imagen-generada.json";
const WORK_FILE = "imagen-trabajando.json";
const DEFAULT_URL = "http://localhost";
const DEFAULT_PORT = 8188;
const DEFAULT_OPENAI_URL = "https://api.openai.com";
const MAX_URL = 200;
const MAX_MODEL = 200;
const MAX_SHOT_TEXT = 4000;

function shareFile(): string {
  return join(stateDir(), SHARE_FILE);
}

/** Fichero del último disparo del MCP: el panel lo vigila para rellenar los prompts. */
export function shotFile(): string {
  return join(stateDir(), SHOT_FILE);
}

/** Fichero con la generación del MCP en curso: el panel de voz enciende su tarjeta. */
export function workFile(): string {
  return join(stateDir(), WORK_FILE);
}

/** Base HTTP admitida: sin barras finales y con tope; si no vale, la de por defecto. */
function cleanUrl(raw: unknown, fallback: string): string {
  const url = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return /^https?:\/\//.test(url) && url.length <= MAX_URL ? url : fallback;
}

/**
 * Ajustes leídos del disco, ya saneados. `undefined` solo si no hay fichero o el JSON
 * está roto: un campo raro vuelve a su defecto y `enabled` que no sea `true` queda
 * apagado, para que un fichero a medias nunca active el generador.
 */
export function readImageShare(): ImageShare | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(shareFile(), "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  const port =
    typeof data.port === "number" && Number.isInteger(data.port) && data.port >= 1 && data.port <= 65535
      ? data.port
      : DEFAULT_PORT;
  const share: ImageShare = {
    enabled: data.enabled === true,
    provider: data.provider === "openai" ? "openai" : "comfyui",
    url: cleanUrl(data.url, DEFAULT_URL),
    port,
    openaiUrl: cleanUrl(data.openaiUrl, DEFAULT_OPENAI_URL),
    model:
      typeof data.model === "string" && data.model.length <= MAX_MODEL ? data.model.trim() : "",
    imagenesDir: typeof data.imagenesDir === "string" ? data.imagenesDir : "",
    updatedAt:
      typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt) ? data.updatedAt : 0,
  };
  const key = typeof data.openaiKey === "string" ? data.openaiKey.trim() : "";
  if (key) {
    share.openaiKey = key;
  }
  return share;
}

/** Claves ordenadas y sin `updatedAt`: así el sondeo de 5 s no reescribe lo que no cambió. */
function stable(share: ImageShare | undefined): string {
  if (!share) {
    return "";
  }
  const { updatedAt: _ignored, ...rest } = share;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/** Fusiona con lo que haya en disco y escribe; sin cambios reales no se toca el fichero. */
export async function writeImageShare(patch: Partial<ImageShare>): Promise<void> {
  const current = readImageShare();
  const next: ImageShare = {
    enabled: patch.enabled ?? current?.enabled ?? false,
    provider: patch.provider ?? current?.provider ?? "comfyui",
    url: patch.url ?? current?.url ?? DEFAULT_URL,
    port: patch.port ?? current?.port ?? DEFAULT_PORT,
    openaiUrl: patch.openaiUrl ?? current?.openaiUrl ?? DEFAULT_OPENAI_URL,
    model: patch.model ?? current?.model ?? "",
    imagenesDir: patch.imagenesDir ?? current?.imagenesDir ?? "",
    updatedAt: Date.now(),
  };
  // Un `openaiKey: undefined` explícito borra la clave; ausente, se conserva la de disco.
  const key = "openaiKey" in patch ? patch.openaiKey : current?.openaiKey;
  if (key) {
    next.openaiKey = key;
  }
  if (stable(next) === stable(current)) {
    return;
  }
  await writeAtomic(shareFile(), Buffer.from(JSON.stringify(next), "utf8"));
}

/** Deja el fichero apagado y sin clave: no se comparte nada ni se guarda ningún secreto. */
export async function clearImageShare(): Promise<void> {
  const cleared = { enabled: false, updatedAt: Date.now() };
  await writeAtomic(shareFile(), Buffer.from(JSON.stringify(cleared), "utf8"));
}

/**
 * ¿Está operativo lo compartido? Nunca lanza: el detalle es lo que se enseña en el panel
 * y lo que devuelve el MCP cuando no puede generar.
 */
export async function checkImageShare(share: ImageShare): Promise<{ ok: boolean; detail: string }> {
  if (share.provider === "openai") {
    if (!share.openaiKey) {
      return { ok: false, detail: "Falta la clave de OpenAI." };
    }
    if (!/^https?:\/\//.test(share.openaiUrl) || !endpointOf(share.openaiUrl)) {
      return { ok: false, detail: "La dirección del servicio no es válida." };
    }
    return { ok: true, detail: `Servicio compatible: ${share.openaiUrl}` };
  }
  try {
    const server = { url: share.url, port: share.port };
    const version = await probe(server);
    const { models } = await catalog(server);
    if (!models.length) {
      return { ok: false, detail: "ComfyUI no tiene modelos instalados." };
    }
    return { ok: true, detail: `ComfyUI ${version} · ${models.length} modelos` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Nombre de la imagen: marca de tiempo local y cuatro hex para no pisar otra del mismo segundo. */
export function imageName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `img-${stamp}-${randomBytes(2).toString("hex")}.png`;
}

/** Escribe el PNG con nombre único en la carpeta indicada (tmp + rename). */
export async function savePng(dir: string, bytes: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, imageName());
  await writeAtomic(file, bytes);
  return file;
}

/** Ancho y alto de un PNG desde su cabecera IHDR, sin leer la imagen entera. */
export async function pngSize(file: string): Promise<{ width: number; height: number }> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await handle.read(header, 0, 24, 0);
    if (bytesRead < 24) {
      return { width: 0, height: 0 };
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

/** Publica el último disparo del MCP; el panel lo vigila y rellena los dos prompts. */
export async function publishShot(event: ImageShot): Promise<void> {
  await writeAtomic(shotFile(), Buffer.from(JSON.stringify(event), "utf8"));
}

/** Último disparo publicado, o `undefined` si no hay fichero o no tiene la forma esperada. */
export function readShot(): ImageShot | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(shotFile(), "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  if (
    typeof data.id !== "string" ||
    !data.id ||
    typeof data.file !== "string" ||
    !data.file ||
    typeof data.prompt !== "string"
  ) {
    return undefined;
  }
  return {
    id: data.id,
    prompt: data.prompt.slice(0, MAX_SHOT_TEXT),
    negative:
      typeof data.negative === "string" ? data.negative.slice(0, MAX_SHOT_TEXT) : "",
    file: data.file,
    at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0,
  };
}

/** Publica si el MCP está generando ahora mismo. Atómico: el panel lo vigila cada segundo. */
export async function publishWork(on: boolean): Promise<void> {
  await writeAtomic(workFile(), Buffer.from(JSON.stringify({ on, at: Date.now() }), "utf8"));
}

/** Último estado de trabajo del MCP, o `undefined` si no hay fichero o está roto. */
export function readWork(): { on: boolean; at: number } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(workFile(), "utf8"));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  return {
    on: data.on === true,
    at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0,
  };
}
