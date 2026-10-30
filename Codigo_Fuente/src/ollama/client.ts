/** Cliente HTTP del API local de Ollama. Sin `vscode`: se puede probar en node. */

export interface OllamaTag {
  name: string;
  size: number;
  modified_at: string;
  details?: { family?: string; parameter_size?: string };
}

/** Progreso de una descarga, tal como lo manda el NDJSON de `/api/pull`. */
export interface OllamaPullLine {
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

const DEFAULT_TIMEOUT = 15_000;

function baseOf(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

/** Error legible en español: fetch solo dice «fetch failed». */
function unreachable(baseURL: string, err: unknown): Error {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new Error(`Ollama no respondió en ${baseURL}.`);
  }
  const cause =
    err instanceof Error
      ? err.cause instanceof Error
        ? err.cause.message
        : err.message
      : String(err);
  return new Error(`No se pudo hablar con Ollama en ${baseURL}: ${cause}`);
}

async function bodyText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/**
 * Una petición al API. `timeoutMs` 0 desactiva el tope; con `init.signal` manda el
 * llamador (una descarga larga no puede caducar por su cuenta).
 */
export async function ollamaRequest<T>(
  baseURL: string,
  route: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT
): Promise<T> {
  const signal =
    init?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  let response: Response;
  try {
    response = await fetch(`${baseOf(baseURL)}${route}`, { ...init, signal });
  } catch (err) {
    if (init?.signal?.aborted) {
      throw new Error("Operación cancelada.");
    }
    throw unreachable(baseURL, err);
  }
  const text = await bodyText(response);
  if (!response.ok) {
    const detail = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    throw new Error(
      `Ollama respondió ${response.status} en ${route}${detail ? `: ${detail}` : "."}`
    );
  }
  if (!text) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Respuesta ilegible de Ollama en ${route}.`);
  }
}

export async function ollamaVersion(baseURL: string): Promise<string> {
  const data = await ollamaRequest<{ version?: unknown }>(baseURL, "/api/version");
  if (typeof data?.version !== "string" || !data.version.trim()) {
    throw new Error("Ollama respondió sin versión.");
  }
  return data.version.trim();
}

export async function ollamaTags(baseURL: string): Promise<OllamaTag[]> {
  const data = await ollamaRequest<{ models?: unknown }>(baseURL, "/api/tags");
  const list = Array.isArray(data?.models) ? data.models : [];
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .filter((item) => typeof item.name === "string")
    .map((item) => {
      const details =
        item.details && typeof item.details === "object"
          ? (item.details as Record<string, unknown>)
          : undefined;
      return {
        name: item.name as string,
        size: typeof item.size === "number" ? item.size : 0,
        modified_at: typeof item.modified_at === "string" ? item.modified_at : "",
        details: details
          ? {
              family: typeof details.family === "string" ? details.family : undefined,
              parameter_size:
                typeof details.parameter_size === "string" ? details.parameter_size : undefined,
            }
          : undefined,
      };
    });
}

/** Nombres de los modelos cargados ahora mismo en memoria. */
export async function ollamaLoaded(baseURL: string): Promise<string[]> {
  const data = await ollamaRequest<{ models?: unknown }>(baseURL, "/api/ps");
  const list = Array.isArray(data?.models) ? data.models : [];
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => (typeof item.name === "string" ? item.name : ""))
    .filter((name) => name.length > 0);
}

/** Descarga un modelo leyendo el NDJSON línea a línea. Corta al `signal`. */
export async function ollamaPull(
  baseURL: string,
  model: string,
  onLine: (line: OllamaPullLine) => void,
  signal: AbortSignal
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseOf(baseURL)}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) {
      throw new Error("Descarga cancelada.");
    }
    throw unreachable(baseURL, err);
  }
  if (!response.ok) {
    const detail = await bodyText(response);
    throw new Error(
      `Ollama respondió ${response.status} al descargar «${model}»${detail ? `: ${detail.slice(0, 300)}` : "."}`
    );
  }
  if (!response.body) {
    throw new Error(`Ollama no abrió el flujo de descarga de «${model}».`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";

  const consume = (raw: string): void => {
    const line = raw.trim();
    if (!line) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Una línea a medias no es un fallo de Ollama: se ignora.
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      throw new Error(`Ollama no pudo descargar «${model}»: ${parsed.error.trim()}`);
    }
    onLine({
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      completed: typeof parsed.completed === "number" ? parsed.completed : undefined,
      total: typeof parsed.total === "number" ? parsed.total : undefined,
    });
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      rest += decoder.decode(value, { stream: true });
      let index = rest.indexOf("\n");
      while (index >= 0) {
        consume(rest.slice(0, index));
        rest = rest.slice(index + 1);
        index = rest.indexOf("\n");
      }
    }
    consume(rest + decoder.decode());
  } catch (err) {
    if (signal.aborted) {
      throw new Error("Descarga cancelada.");
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    // Tras `done` cancelar es inocuo; sin esto, un `error` de Ollama deja el flujo abierto.
    void reader.cancel().catch(() => {});
  }
}

export async function ollamaRemove(baseURL: string, model: string): Promise<void> {
  await ollamaRequest(baseURL, "/api/delete", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
}
