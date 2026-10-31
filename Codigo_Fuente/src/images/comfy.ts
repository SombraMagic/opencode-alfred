/**
 * Cliente HTTP de ComfyUI: texto a imagen e imagen a imagen. Sin la API de VS Code, para
 * poder probarlo con un bundle y un `node` sueltos. El flujo se manda en formato API
 * (ids de nodo como cadenas) y el PNG se recoge del histórico del servidor.
 */

/** Tope de cada petición corta: sondeo, catálogo, envío del flujo e historial. */
const SHORT_TIMEOUT_MS = 15_000;
/** La descarga del PNG puede tardar: el servidor lo escribe antes de contestar. */
const VIEW_TIMEOUT_MS = 60_000;
/** Cada cuánto se mira el histórico del flujo. */
const POLL_MS = 1000;
/** Tope de una generación entera; después se avisa y se deja de sondear. */
const JOB_TIMEOUT_MS = 10 * 60_000;
/** Id de cliente del flujo: el servidor solo lo usa para agrupar, basta con que sea único. */
const CLIENT_ID = `alfred-${process.pid}`;

export interface ComfyServer {
  /** Dirección sin puerto, por ejemplo `http://127.0.0.1`. */
  url: string;
  port: number;
}

export interface ComfyLora {
  name: string;
  weight: number;
}

export interface ComfyGenerateRequest extends ComfyServer {
  prompt: string;
  negative: string;
  model: string;
  width: number;
  height: number;
  loras: ComfyLora[];
  /** Imagen de partida para img2img; sin ella el flujo es de texto a imagen. */
  source?: Buffer;
  /** Cuánto se aparta del original (0.1..1). Solo cuenta con imagen de partida. */
  denoise?: number;
  /** Fase visible para el panel durante la generación. */
  onProgress?: (text: string) => void;
}

/** Nodo del flujo en formato API: clase y entradas, con las conexiones como `[id, salida]`. */
type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

interface ObjectInfo {
  input?: { required?: Record<string, unknown> };
}

interface HistoryEntry {
  status?: {
    completed?: boolean;
    status_str?: string;
    messages?: unknown;
  };
  outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>;
}

function baseOf(server: ComfyServer): string {
  return `${server.url.replace(/\/+$/, "")}:${server.port}`;
}

/** Toda petición pasa por aquí: el fallo de red también se cuenta en español. */
async function talk(target: string, init: RequestInit, timeout: number): Promise<Response> {
  try {
    return await fetch(target, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new Error(
      `No se pudo conectar con ComfyUI: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(
      detail
        ? `ComfyUI respondió ${res.status} en ${what}: ${detail}`
        : `ComfyUI respondió ${res.status} en ${what}.`
    );
  }
  return (await res.json()) as T;
}

/** Versión del servidor. Si no responde, lanza: el panel lo pinta como «Sin conexión». */
export async function probe(server: ComfyServer): Promise<string> {
  const res = await talk(`${baseOf(server)}/system_stats`, {}, SHORT_TIMEOUT_MS);
  const data = await readJson<{ system?: { comfyui_version?: unknown } }>(res, "la versión");
  const version = data?.system?.comfyui_version;
  return typeof version === "string" || typeof version === "number" ? String(version) : "desconocida";
}

/** Lista de valores de un campo de `/object_info`: `input.required.<campo>[0]`. */
function choices(info: ObjectInfo, field: string): string[] {
  const entry = info?.input?.required?.[field];
  const list = Array.isArray(entry) ? entry[0] : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

/**
 * `/object_info/<clase>` envuelve la ficha del nodo con su nombre de clase
 * (`{ "LoraLoader": { input: ... } }`); se pela la capa si la ficha viene dentro.
 */
function unwrapNode(raw: unknown): ObjectInfo {
  const direct = raw as ObjectInfo | undefined;
  if (direct?.input) {
    return direct;
  }
  const inner = raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>)[0] : undefined;
  return (inner as ObjectInfo | undefined) ?? {};
}

/** Checkpoints y LoRA instalados en el servidor. */
export async function catalog(server: ComfyServer): Promise<{ models: string[]; loras: string[] }> {
  const base = baseOf(server);
  const [checkpoints, loras] = await Promise.all([
    talk(`${base}/object_info/CheckpointLoaderSimple`, {}, SHORT_TIMEOUT_MS)
      .then((res) => readJson<unknown>(res, "el catálogo de checkpoints"))
      .then(unwrapNode),
    talk(`${base}/object_info/LoraLoader`, {}, SHORT_TIMEOUT_MS)
      .then((res) => readJson<unknown>(res, "el catálogo de LoRA"))
      .then(unwrapNode),
  ]);
  return { models: choices(checkpoints, "ckpt_name"), loras: choices(loras, "lora_name") };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Semilla del sampler: el servidor no la repite entre flujos por su cuenta. */
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Flujo de texto a imagen (o img2img con `uploaded`) con los LoRA encadenados. */
function buildWorkflow(req: ComfyGenerateRequest, uploaded?: string): Workflow {
  const workflow: Workflow = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: req.model } },
  };
  let model: [string, number] = ["1", 0];
  let clip: [string, number] = ["1", 1];
  let next = 10;
  for (const lora of req.loras) {
    const id = String(next++);
    workflow[id] = {
      class_type: "LoraLoader",
      inputs: {
        lora_name: lora.name,
        strength_model: lora.weight,
        strength_clip: lora.weight,
        model,
        clip,
      },
    };
    model = [id, 0];
    clip = [id, 1];
  }
  workflow["2"] = { class_type: "CLIPTextEncode", inputs: { text: req.prompt, clip } };
  workflow["3"] = { class_type: "CLIPTextEncode", inputs: { text: req.negative, clip } };

  let latent: [string, number];
  let denoise = 1;
  if (uploaded) {
    workflow["8"] = { class_type: "LoadImage", inputs: { image: uploaded } };
    workflow["9"] = { class_type: "VAEEncode", inputs: { pixels: ["8", 0], vae: ["1", 2] } };
    latent = ["9", 0];
    denoise = req.denoise ?? 0.6;
  } else {
    workflow["4"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: req.width, height: req.height, batch_size: 1 },
    };
    latent = ["4", 0];
  }

  workflow["5"] = {
    class_type: "KSampler",
    inputs: {
      model,
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: latent,
      seed: randomSeed(),
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise,
    },
  };
  workflow["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } };
  workflow["7"] = {
    class_type: "SaveImage",
    inputs: { images: ["6", 0], filename_prefix: "alfred" },
  };
  return workflow;
}

/** Sube la imagen de partida y devuelve el nombre con el que la verá `LoadImage`. */
async function uploadSource(base: string, bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), "alfred-origen.png");
  form.append("overwrite", "true");
  const res = await talk(`${base}/upload/image`, { method: "POST", body: form }, SHORT_TIMEOUT_MS);
  const data = await readJson<{ name?: unknown; subfolder?: unknown }>(
    res,
    "la subida de la imagen"
  );
  const name = typeof data.name === "string" ? data.name : "";
  if (!name) {
    throw new Error("ComfyUI no devolvió el nombre de la imagen subida.");
  }
  const subfolder = typeof data.subfolder === "string" ? data.subfolder : "";
  return subfolder ? `${subfolder}/${name}` : name;
}

/** Primer error de nodo útil de la respuesta de `/prompt`. */
function firstNodeError(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "";
  }
  for (const entry of Object.values(raw as Record<string, unknown>)) {
    const errors = (entry as { errors?: unknown } | undefined)?.errors;
    if (!Array.isArray(errors)) {
      continue;
    }
    for (const error of errors) {
      const item = error as { message?: unknown; details?: unknown };
      const text = [item?.message, item?.details]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(" ");
      if (text) {
        return text;
      }
    }
  }
  return "";
}

/** Motivo de un flujo que terminó con error (`status.messages` con `execution_error`). */
function executionError(raw: unknown): string {
  if (!Array.isArray(raw)) {
    return "sin detalle";
  }
  for (const message of raw) {
    if (!Array.isArray(message) || message[0] !== "execution_error") {
      continue;
    }
    const detail = message[1] as { exception_message?: unknown } | undefined;
    if (typeof detail?.exception_message === "string" && detail.exception_message) {
      return detail.exception_message;
    }
  }
  return "sin detalle";
}

/**
 * Genera una imagen y devuelve sus bytes PNG: sube la imagen de partida si la hay,
 * encola el flujo, sondea el histórico y descarga el resultado.
 */
export async function generate(req: ComfyGenerateRequest): Promise<Buffer> {
  const base = baseOf(req);
  const uploaded =
    req.source && req.source.length ? await uploadSource(base, req.source) : undefined;

  req.onProgress?.("En cola…");
  const res = await talk(
    `${base}/prompt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        prompt: buildWorkflow(req, uploaded),
      }),
    },
    SHORT_TIMEOUT_MS
  );
  if (!res.ok) {
    // La validación del flujo vuelve en `node_errors`; el motivo de ahí es el útil.
    const body = (await res.json().catch(() => undefined)) as
      | { node_errors?: unknown; error?: { message?: unknown } }
      | undefined;
    const reason =
      firstNodeError(body?.node_errors) ||
      (typeof body?.error?.message === "string" ? body.error.message : `HTTP ${res.status}`);
    throw new Error(`ComfyUI rechazó el flujo: ${reason}`);
  }
  const queued = (await res.json()) as { prompt_id?: unknown; node_errors?: unknown };
  const broken = firstNodeError(queued.node_errors);
  if (broken) {
    throw new Error(`ComfyUI rechazó el flujo: ${broken}`);
  }
  const promptId = typeof queued.prompt_id === "string" ? queued.prompt_id : "";
  if (!promptId) {
    throw new Error("ComfyUI no aceptó el flujo.");
  }

  req.onProgress?.("Generando…");
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let entry: HistoryEntry | undefined;
  for (;;) {
    const history = await readJson<Record<string, HistoryEntry>>(
      await talk(`${base}/history/${promptId}`, {}, SHORT_TIMEOUT_MS),
      "el historial"
    );
    entry = history[promptId];
    if (entry?.status?.completed) {
      break;
    }
    if (entry?.status?.status_str === "error") {
      throw new Error(`ComfyUI falló al generar: ${executionError(entry.status.messages)}`);
    }
    if (Date.now() > deadline) {
      throw new Error("ComfyUI no terminó la imagen a tiempo.");
    }
    await sleep(POLL_MS);
  }

  const image = entry?.outputs?.["7"]?.images?.[0];
  if (!image?.filename) {
    throw new Error("ComfyUI terminó sin devolver la imagen.");
  }
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? "",
    type: image.type ?? "output",
  });
  const png = await talk(`${base}/view?${query.toString()}`, {}, VIEW_TIMEOUT_MS);
  if (!png.ok) {
    throw new Error(`ComfyUI no devolvió la imagen (${png.status}).`);
  }
  const bytes = Buffer.from(await png.arrayBuffer());
  if (!bytes.length) {
    throw new Error("ComfyUI devolvió una imagen vacía.");
  }
  return bytes;
}
