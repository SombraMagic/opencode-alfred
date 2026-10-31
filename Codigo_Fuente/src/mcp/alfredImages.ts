/**
 * Herramientas de imagen del MCP `mcp_alfred`: generar con el generador que la persona
 * compartió desde el panel y consultar si sigue operativo. Sin `vscode`: los ajustes
 * llegan por el estado compartido de `%APPDATA%\voz`.
 */
import { randomUUID } from "node:crypto";
import { catalog, generate } from "../images/comfy";
import { generateImage } from "../images/openai";
import {
  checkImageShare,
  pngSize,
  publishShot,
  publishWork,
  readImageShare,
  savePng,
} from "../images/share";

/** Tope del prompt y del negativo, como en el panel. */
const MAX_PROMPT = 4000;
const MIN_SIDE = 64;
const MAX_SIDE = 2048;
const DEFAULT_SIDE = 1024;
const DEFAULT_OPENAI_MODEL = "gpt-image-1";

const NOT_SHARED =
  "El generador de imágenes no está compartido con los agentes. Actívalo en el panel Generador de imágenes (ALFRED → CONTROL).";

export const IMAGE_TOOLS = [
  {
    name: "generar_imagen",
    description:
      "Genera una imagen con el generador que la persona compartió (ComfyUI u OpenAI) y la guarda en su carpeta de imágenes. Solo funciona mientras esté compartido: si no, devuelve un aviso y no genera nada.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Qué se quiere ver. Obligatorio." },
        negative: {
          type: "string",
          description: "Lo que no debe salir. Solo lo usa ComfyUI.",
        },
        width: {
          type: "integer",
          minimum: MIN_SIDE,
          maximum: MAX_SIDE,
          description: "Ancho en píxeles; 1024 por defecto.",
        },
        height: {
          type: "integer",
          minimum: MIN_SIDE,
          maximum: MAX_SIDE,
          description: "Alto en píxeles; 1024 por defecto.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "consultar_estado",
    description:
      "Dice si el generador de imágenes está compartido con los agentes y operativo, con su modelo. No genera nada; no falla cuando está apagado.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Lado pedido: entero entre 64 y 2048; sin un número válido, 1024. */
function side(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_SIDE;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, value));
}

/** `generar_imagen`: comprueba lo compartido, genera, guarda y publica el disparo. */
async function generarImagen(args: Record<string, unknown>): Promise<string> {
  const share = readImageShare();
  if (!share || !share.enabled) {
    throw new Error(NOT_SHARED);
  }
  const status = await checkImageShare(share);
  if (!status.ok) {
    throw new Error(status.detail);
  }
  if (!share.imagenesDir) {
    throw new Error("La carpeta de imágenes compartida no es válida.");
  }

  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) {
    throw new Error(`El prompt está vacío o pasa de ${MAX_PROMPT} caracteres.`);
  }
  const negative =
    typeof args.negative === "string" ? args.negative.trim().slice(0, MAX_PROMPT) : "";
  const width = side(args.width);
  const height = side(args.height);

  let bytes: Buffer;
  let note = "";
  // La tarjeta del panel de voz se enciende mientras dure, aunque la generación falle.
  await publishWork(true);
  try {
    if (share.provider === "comfyui") {
      const model = share.model || (await catalog({ url: share.url, port: share.port })).models[0] || "";
      if (!model) {
        throw new Error("ComfyUI no tiene modelos instalados.");
      }
      bytes = await generate({
        url: share.url,
        port: share.port,
        prompt,
        negative,
        model,
        width,
        height,
        loras: [],
      });
    } else {
      const model = share.model || DEFAULT_OPENAI_MODEL;
      const result = await generateImage({
        key: share.openaiKey ?? "",
        model,
        prompt,
        width,
        height,
        baseUrl: share.openaiUrl,
      });
      bytes = result.bytes;
      note = [result.message, negative ? "OpenAI no usa prompt negativo." : ""]
        .filter(Boolean)
        .join(" ");
    }

    const file = await savePng(share.imagenesDir, bytes);
    await publishShot({ id: randomUUID(), prompt, negative, file, at: Date.now() });
    const size = await pngSize(file);
    return `Imagen generada a ${size.width}×${size.height}: ${file}${note ? ` ${note}` : ""}`;
  } finally {
    await publishWork(false);
  }
}

/** `consultar_estado`: información, no error, aunque esté apagado. */
async function consultarEstado(): Promise<string> {
  const share = readImageShare();
  if (!share || !share.enabled) {
    return "OFF — El generador de imágenes no está compartido con los agentes.";
  }
  const status = await checkImageShare(share);
  if (!status.ok) {
    return `OFF — ${status.detail}`;
  }
  return `ON — ${status.detail} · modelo ${share.model || "automático"}`;
}

const IMAGE_CALLS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  generar_imagen: generarImagen,
  consultar_estado: consultarEstado,
};

/** Ejecuta una herramienta de imagen; `undefined` si el nombre no es suyo. */
export async function callImageTool(
  name: string,
  args: Record<string, unknown>
): Promise<string | undefined> {
  const call = IMAGE_CALLS[name];
  return call ? call(args) : undefined;
}
