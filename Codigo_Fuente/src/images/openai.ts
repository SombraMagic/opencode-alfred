/**
 * Cliente HTTP de imágenes de OpenAI, o de un servicio compatible que hable su API. Sin
 * la API de VS Code. La clave llega como argumento y no se registra en ningún sitio.
 */

const DEFAULT_BASE = "https://api.openai.com";
/** Una imagen puede tardar; el resto de peticiones del panel no esperan tanto. */
const TIMEOUT_MS = 180_000;
/** La descarga de una imagen que llega como URL no puede quedarse colgada. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MIN_SIDE = 64;
const MAX_SIDE = 2048;
/** Tope de una imagen bajada por URL: más grande no es una imagen. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
/** Tamaño al que caen los modelos de la tabla cuando el pedido no está admitido. */
const DEFAULT_SIZE = "1024x1024";
/** Id de modelo que acepta la API: lo demás no viaja. */
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

/** Modelos conocidos con los tamaños que admite cada uno. */
export const OPENAI_MODELS: Record<string, readonly string[]> = {
  "gpt-image-1": ["1024x1024", "1536x1024", "1024x1536"],
  "dall-e-3": ["1024x1024", "1792x1024", "1024x1792"],
  "dall-e-2": ["256x256", "512x512", "1024x1024"],
};

export interface OpenAiRequest {
  key: string;
  model: string;
  prompt: string;
  width: number;
  height: number;
  /** Base del servicio (`https://api.openai.com`, `http://localhost:8000/v1`…). */
  baseUrl?: string;
}

/** Imagen generada y el aviso de tamaño, si hubo que moverlo al de por defecto. */
export interface OpenAiResult {
  bytes: Buffer;
  message: string;
}

/**
 * Endpoint de generación: quita las barras finales y respeta el `/vN` que ya traiga la
 * base; sin él se antepone `/v1`.
 */
export function endpointOf(baseUrl?: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "") || DEFAULT_BASE;
  return /\/v\d+$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
}

function clampSide(raw: number): number {
  const value = Number.isFinite(raw) ? Math.round(raw) : 1024;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, value));
}

/**
 * Descarga los bytes de una imagen que el servicio devuelve como URL. Con tope de 32 MB:
 * por la cabecera si la trae y, si no, cortando la lectura.
 */
async function download(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(
      `No se pudo descargar la imagen de ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    throw new Error(`No se pudo descargar la imagen de ${url} (${res.status}).`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error("La imagen del servicio pasa de 32 MB.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("La imagen del servicio pasa de 32 MB.");
      }
      chunks.push(Buffer.from(value));
    }
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) {
    throw new Error(`La imagen de ${url} llegó vacía.`);
  }
  return bytes;
}

/** Genera una imagen y devuelve sus bytes PNG (base64 o URL, según el servicio). */
export async function generateImage(req: OpenAiRequest): Promise<OpenAiResult> {
  if (!MODEL_RE.test(req.model)) {
    throw new Error(`Modelo de imagen no válido: ${req.model}.`);
  }
  const endpoint = endpointOf(req.baseUrl);

  // Con un modelo conocido, un tamaño que no admite cae al de por defecto y se avisa;
  // con uno escrito a mano se manda el tamaño pedido tal cual (acotado).
  const sizes = OPENAI_MODELS[req.model];
  let size = `${clampSide(req.width)}x${clampSide(req.height)}`;
  let message = "";
  if (sizes) {
    const wanted = `${req.width}x${req.height}`;
    if (sizes.includes(wanted)) {
      size = wanted;
    } else {
      size = DEFAULT_SIZE;
      message = `${req.model} no admite ${wanted.replace("x", "×")}: se generó a ${DEFAULT_SIZE.replace(
        "x",
        "×"
      )}.`;
    }
  }

  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, size, n: 1 };
  // `gpt-image-1` responde siempre en base64 y no admite el parámetro.
  if (req.model === "dall-e-3" || req.model === "dall-e-2") {
    body.response_format = "b64_json";
  }

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${req.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `No se pudo conectar con ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = (await res.json().catch(() => undefined)) as
      | { error?: { message?: unknown } }
      | undefined;
    const text =
      typeof detail?.error?.message === "string" ? detail.error.message : `HTTP ${res.status}`;
    throw new Error(`El servicio respondió ${res.status} en ${endpoint}: ${text}`);
  }

  const data = (await res.json()) as {
    data?: Array<{ b64_json?: unknown; url?: unknown }>;
  };
  const first = data?.data?.[0];
  if (typeof first?.b64_json === "string" && first.b64_json) {
    return { bytes: Buffer.from(first.b64_json, "base64"), message };
  }
  // Servidores compatibles que contestan con una URL en vez de base64.
  if (typeof first?.url === "string" && first.url) {
    return { bytes: await download(first.url), message };
  }
  throw new Error("El servicio no devolvió la imagen.");
}
