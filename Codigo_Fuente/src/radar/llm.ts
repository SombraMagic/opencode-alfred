/**
 * Capa LLM del filtro: chat completions compatible con OpenAI sobre `fetch`, sin
 * dependencias nuevas. Los tres proveedores (Ollama local, OpenAI y DeepSeek) hablan
 * el mismo dialecto; la clave llega desde el host y nunca se escribe en un fichero.
 * Sin `vscode`.
 */

import { baseOf, ollamaTags } from "../ollama/client";
import type { RadarProveedor } from "./types";

/** Tamaño del lote: se puntúan 20 titulares por llamada, nunca uno por noticia. */
export const TAM_LOTE = 20;

/** Tope de noticias que se puntúan en una sola pasada. */
export const MAX_PUNTUAR_PASADA = 200;

/** Titular que entra al lote. `n` es el número dentro del lote. */
export interface LlmTitular {
  n: number;
  titulo: string;
  /** Contexto extra; se recorta antes de enviar. */
  resumen: string;
}

/** Puntuación devuelta por el modelo para un titular del lote. */
export interface LlmScore {
  n: number;
  /** 0-100, ya acotado. */
  puntuacion: number;
  /** Uno de los temas pedidos; vacío si el modelo no se decidió. */
  tema: string;
  /** Resumen de una línea, en español. */
  resumen: string;
}

/** Opciones de la llamada. */
export interface LlmOpts {
  proveedor: RadarProveedor;
  /** Vacío en Ollama = el primer modelo instalado. */
  modelo: string;
  /** Solo openai/deepseek; en Ollama se ignora. */
  clave?: string;
  /** Base local de Ollama (defecto `http://127.0.0.1:11434`). */
  ollamaBase?: string;
  /** Nombres de tema entre los que el modelo debe elegir. */
  temas: string[];
  /** Señal de cancelación del llamador. */
  signal?: AbortSignal;
}

const OLLAMA_BASE_DEFECTO = "http://127.0.0.1:11434";

/** Punto final de chat completions por proveedor. */
export function endpointDe(proveedor: RadarProveedor, ollamaBase?: string): string {
  switch (proveedor) {
    case "ollama":
      return `${baseOf(ollamaBase || OLLAMA_BASE_DEFECTO)}/v1/chat/completions`;
    case "openai":
      return "https://api.openai.com/v1/chat/completions";
    case "deepseek":
      return "https://api.deepseek.com/v1/chat/completions";
  }
}

/** Nombre del proveedor en los mensajes de error. */
export function nombreProveedor(proveedor: RadarProveedor): string {
  switch (proveedor) {
    case "ollama":
      return "Ollama local";
    case "openai":
      return "OpenAI";
    case "deepseek":
      return "DeepSeek";
  }
}

/** Tiempo de espera: el modelo local puede arrancar en frío. */
function timeoutDe(proveedor: RadarProveedor): number {
  return proveedor === "ollama" ? 180_000 : 60_000;
}

/** Prompt del sistema: el mismo para los tres proveedores. */
function systemPrompt(temas: string[]): string {
  const lista = temas.length > 0 ? temas.map((t) => `«${t}»`).join(", ") : "«General»";
  return [
    "Eres el filtro de un radar de noticias de inteligencia artificial, programación y artículos técnicos.",
    "Para cada titular numerado que recibe el usuario:",
    "1. Puntúa de 0 a 100 su interés para una desarrolladora: 0 = ruido (política, deportes, marketing, criptomonedas especulativas), 100 = novedad técnica relevante.",
    `2. Asigna UN tema de esta lista: ${lista}. Si no encaja en ninguno, deja el tema vacío.`,
    "3. Escribe un resumen de UNA frase en español, informativo y sin adornos.",
    'Responde SOLO con JSON válido, sin markdown ni texto fuera del JSON, con esta forma exacta: {"resultados":[{"n":1,"puntuacion":87,"tema":"IA","resumen":"..."}]}',
    "Incluye una entrada por cada titular recibido, con su mismo número n.",
  ].join("\n");
}

/** Contenido del usuario: la lista numerada de titulares. */
function userPrompt(titulares: LlmTitular[]): string {
  return titulares
    .map((t) => {
      const contexto = t.resumen.trim().slice(0, 200);
      return `${t.n}. ${t.titulo.trim()}${contexto ? ` — ${contexto}` : ""}`;
    })
    .join("\n");
}

/** Modelo de Ollama cuando la configuración no fija ninguno: el primero instalado. */
async function modeloOllama(ollamaBase?: string): Promise<string> {
  const base = baseOf(ollamaBase || OLLAMA_BASE_DEFECTO);
  const tags = await ollamaTags(base);
  if (tags.length === 0) {
    throw new Error("Ollama no tiene ningún modelo instalado; descarga uno desde MENTE LOCAL.");
  }
  return tags[0].name;
}

/** Extrae el JSON de la respuesta: modelos locales que envuelven en ```json …```. */
function extraerJson(texto: string): string {
  const limpio = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const abre = limpio.indexOf("{");
  const cierra = limpio.lastIndexOf("}");
  if (abre < 0 || cierra <= abre) {
    throw new Error("La respuesta del modelo no trae un JSON legible.");
  }
  return limpio.slice(abre, cierra + 1);
}

/** Valida y acota lo que devolvió el modelo; lo ilegible se descarta por titular. */
function parsearResultados(texto: string, temas: string[], esperados: number[]): LlmScore[] {
  const datos = JSON.parse(extraerJson(texto)) as unknown;
  const contenedor = datos as Record<string, unknown>;
  const lista = Array.isArray(contenedor?.resultados)
    ? contenedor.resultados
    : Array.isArray(datos)
      ? datos
      : undefined;
  if (!lista) {
    throw new Error("La respuesta del modelo no trae la lista «resultados».");
  }
  const validos = new Set(esperados);
  const temasNorm = new Map(temas.map((t) => [t.toLowerCase(), t]));
  const out: LlmScore[] = [];
  for (const crudo of lista) {
    if (!crudo || typeof crudo !== "object") {
      continue;
    }
    const item = crudo as Record<string, unknown>;
    const n = Math.round(Number(item.n));
    if (!validos.has(n)) {
      continue;
    }
    let puntuacion = Math.round(Number(item.puntuacion));
    if (!Number.isFinite(puntuacion)) {
      continue;
    }
    puntuacion = Math.min(100, Math.max(0, puntuacion));
    const temaCrudo = typeof item.tema === "string" ? item.tema.trim() : "";
    const tema = temasNorm.get(temaCrudo.toLowerCase()) ?? (temas.includes(temaCrudo) ? temaCrudo : "");
    const resumen =
      typeof item.resumen === "string"
        ? item.resumen.replace(/\s+/g, " ").trim().slice(0, 300)
        : "";
    out.push({ n, puntuacion, tema, resumen });
  }
  return out;
}

/** Una llamada al endpoint con el cuerpo dado; traduce los fallos a español. */
async function llamar(
  url: string,
  cuerpo: Record<string, unknown>,
  opts: LlmOpts
): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.proveedor !== "ollama") {
    if (!opts.clave) {
      throw new Error(`Falta la clave de ${nombreProveedor(opts.proveedor)}: guárdala en la pestaña CONFIGURACIÓN del radar.`);
    }
    headers["authorization"] = `Bearer ${opts.clave}`;
  }
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutDe(opts.proveedor))])
    : AbortSignal.timeout(timeoutDe(opts.proveedor));
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(cuerpo),
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new Error("Puntuación cancelada.");
    }
    const causa =
      err instanceof Error
        ? err.name === "TimeoutError"
          ? `no respondió en ${timeoutDe(opts.proveedor) / 1000} s`
          : err.cause instanceof Error
            ? err.cause.message
            : err.message
        : String(err);
    throw new Error(`${nombreProveedor(opts.proveedor)} no está accesible: ${causa}`);
  }
  const texto = await response.text().catch(() => "");
  if (!response.ok) {
    const detalle = texto.trim().slice(0, 300);
    throw new Error(
      `${nombreProveedor(opts.proveedor)} respondió ${response.status}${detalle ? `: ${detalle}` : "."}`
    );
  }
  const datos = JSON.parse(texto || "{}") as {
    choices?: { message?: { content?: unknown } }[];
  };
  const contenido = datos.choices?.[0]?.message?.content;
  if (typeof contenido !== "string" || !contenido.trim()) {
    throw new Error(`${nombreProveedor(opts.proveedor)} respondió sin contenido.`);
  }
  return contenido;
}

/**
 * Puntúa un lote (máximo `TAM_LOTE` titulares). Devuelve solo las entradas que el
 * modelo devolvió bien formadas; los titulares ausentes quedan sin puntuar.
 */
export async function puntuarLote(opts: LlmOpts, titulares: LlmTitular[]): Promise<LlmScore[]> {
  if (titulares.length === 0) {
    return [];
  }
  const lote = titulares.slice(0, TAM_LOTE);
  const modelo =
    opts.modelo.trim() ||
    (opts.proveedor === "ollama"
      ? await modeloOllama(opts.ollamaBase)
      : opts.proveedor === "openai"
        ? "gpt-4o-mini"
        : "deepseek-chat");
  const cuerpo: Record<string, unknown> = {
    model: modelo,
    temperature: 0.2,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt(opts.temas) },
      { role: "user", content: userPrompt(lote) },
    ],
  };
  const url = endpointDe(opts.proveedor, opts.ollamaBase);
  let contenido: string;
  try {
    contenido = await llamar(url, { ...cuerpo, response_format: { type: "json_object" } }, opts);
  } catch (err) {
    // Servidores compatibles viejos que rechazan `response_format`: se reintenta sin él.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("400") && msg.toLowerCase().includes("response_format")) {
      contenido = await llamar(url, cuerpo, opts);
    } else {
      throw err;
    }
  }
  return parsearResultados(contenido, opts.temas, lote.map((t) => t.n));
}
