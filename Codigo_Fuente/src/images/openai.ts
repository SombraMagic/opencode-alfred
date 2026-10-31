/**
 * Cliente HTTP de imágenes de OpenAI. Sin la API de VS Code. La clave llega como
 * argumento y no se registra en ningún sitio.
 */

const ENDPOINT = "https://api.openai.com/v1/images/generations";
/** Una imagen puede tardar; el resto de peticiones del panel no esperan tanto. */
const TIMEOUT_MS = 180_000;

/** Modelos del desplegable con los tamaños que admite cada uno. */
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
}

/** Genera una imagen y devuelve sus bytes PNG (OpenAI contesta en base64). */
export async function generateImage(req: OpenAiRequest): Promise<Buffer> {
  const sizes = OPENAI_MODELS[req.model];
  if (!sizes) {
    throw new Error(`Modelo de OpenAI desconocido: ${req.model}.`);
  }
  // Un tamaño que el modelo no admite no rompe la petición: se va al cuadrado de siempre.
  const size = sizes.includes(`${req.width}x${req.height}`)
    ? `${req.width}x${req.height}`
    : "1024x1024";
  const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, size, n: 1 };
  // `gpt-image-1` responde siempre en base64 y no admite el parámetro.
  if (req.model === "dall-e-3" || req.model === "dall-e-2") {
    body.response_format = "b64_json";
  }

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${req.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `No se pudo conectar con OpenAI: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    const detail = (await res.json().catch(() => undefined)) as
      | { error?: { message?: unknown } }
      | undefined;
    const text =
      typeof detail?.error?.message === "string" ? detail.error.message : `HTTP ${res.status}`;
    throw new Error(`OpenAI respondió ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { data?: Array<{ b64_json?: unknown }> };
  const b64 = data?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    throw new Error("OpenAI no devolvió la imagen.");
  }
  return Buffer.from(b64, "base64");
}
