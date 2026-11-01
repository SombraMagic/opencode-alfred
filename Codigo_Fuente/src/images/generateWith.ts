/**
 * Genera una imagen con la configuración ya establecida del panel del generador, sin
 * pasar por el fichero compartido con los agentes (no depende de «COMPARTIR CON ALFRED»).
 * Sin `vscode`: el host le pasa lo leído de `globalState`/`secrets`.
 */
import { catalog, generate as generateComfy } from "./comfy";
import { generateImage } from "./openai";
import { savePng } from "./share";

export interface ImageSettingsInput {
  provider: "comfyui" | "openai";
  url: string;
  port: number;
  openaiUrl: string;
  /** Clave de `secrets`; solo se usa con OpenAI y no sale de este proceso. */
  openaiKey?: string;
  /** `prefs` del panel (globalState `opencodeAgents.imageGen`). */
  prefs: {
    model: string;
    openaiModel: string;
    width: number;
    height: number;
    steps: number;
    cfg: number;
    seed: number;
    seedRandom: boolean;
  };
  /** Carpeta del historial del panel. */
  imagenesDir: string;
}

const DEFAULT_OPENAI_MODEL = "gpt-image-1";
const MAX_PROMPT = 4000;

/** Lado de la imagen: entero, múltiplo de 8 y entre 64 y 2048 (igual que el panel del generador). */
function sanitizeSide(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : 512;
  return Math.min(2048, Math.max(64, Math.round(Math.round(value) / 8) * 8));
}

/** Genera con los ajustes recibidos y guarda el PNG en la carpeta del historial. */
export async function generateWithSettings(
  settings: ImageSettingsInput,
  prompt: string,
  onProgress?: (text: string) => void
): Promise<{ file: string; note?: string }> {
  const text = prompt.trim();
  if (!text || text.length > MAX_PROMPT) {
    throw new Error(`El prompt está vacío o pasa de ${MAX_PROMPT} caracteres.`);
  }
  const { prefs } = settings;
  if (settings.provider === "openai") {
    if (!settings.openaiKey) {
      throw new Error("Falta la clave de OpenAI. Guárdala en el panel del generador.");
    }
    const result = await generateImage({
      key: settings.openaiKey,
      model: prefs.openaiModel || DEFAULT_OPENAI_MODEL,
      prompt: text,
      width: sanitizeSide(prefs.width),
      height: sanitizeSide(prefs.height),
      baseUrl: settings.openaiUrl,
    });
    return { file: await savePng(settings.imagenesDir, result.bytes), note: result.message || undefined };
  }
  const server = { url: settings.url, port: settings.port };
  const model = prefs.model || (await catalog(server)).models[0] || "";
  if (!model) {
    throw new Error("ComfyUI no tiene modelos instalados.");
  }
  const bytes = await generateComfy({
    ...server,
    prompt: text,
    negative: "",
    model,
    width: sanitizeSide(prefs.width),
    height: sanitizeSide(prefs.height),
    loras: [],
    steps: prefs.steps,
    cfg: prefs.cfg,
    seed: prefs.seedRandom ? undefined : prefs.seed,
    onProgress,
  });
  return { file: await savePng(settings.imagenesDir, bytes) };
}
