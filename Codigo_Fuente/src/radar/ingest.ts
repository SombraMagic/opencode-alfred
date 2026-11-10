/**
 * Ingesta de feeds: descarga condicional con tope de tamaño y tiempo, normalización,
 * deduplicación por enlace canónico + hash del título y reglas por tema. Sin `vscode`.
 */

import { createHash } from "node:crypto";
import { RETENCION_DIAS } from "./db";
import { parseFeed, type FeedItem } from "./feed";
import type { RadarFuente, RadarNoticia, RadarTema } from "./types";

/** Tope de bytes por feed: más allá es un fichero que no es un feed. */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
/** Tiempo de espera de la descarga. */
export const FEED_TIMEOUT_MS = 20_000;
/** Concurrencia máxima de descargas. */
export const CONCURRENCIA = 4;

/** Cabeceras de la descarga condicional anterior. */
export interface FeedPrevio {
  etag?: string;
  lastModified?: string;
}

/** Resultado de la descarga de un feed. */
export type DescargaFeed =
  /** Sin cambios desde la última pasada: no hay que parsear. */
  | { tipo: "sinCambios" }
  /** Cuerpo nuevo, con las cabeceras que hay que recordar. */
  | { tipo: "nuevo"; body: string; etag?: string; lastModified?: string };

/** Lee el cuerpo con tope de bytes: un Content-Length mentiroso no cuela. */
async function leerConTope(response: Response, maxBytes: number): Promise<string> {
  const declarado = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declarado) && declarado > maxBytes) {
    throw new Error(`el feed declara ${declarado} bytes, por encima del tope de ${maxBytes}.`);
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`el feed supera el tope de ${maxBytes} bytes.`);
        }
        trozos.push(value);
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const unido = new Uint8Array(total);
  let off = 0;
  for (const t of trozos) {
    unido.set(t, off);
    off += t.byteLength;
  }
  return new TextDecoder("utf-8").decode(unido);
}

/**
 * Descarga un feed con `etag`/`last-modified`. Un 304 sale barato; los fallos de red
 * lanzan con un mensaje en español que el llamador anota sin tumbar la pasada.
 */
export async function descargarFeed(
  url: string,
  previo: FeedPrevio
): Promise<DescargaFeed> {
  const headers: Record<string, string> = {
    "user-agent": "opencode-alfred-radar/1.0 (+https://github.com/SombraMagic/opencode-alfred)",
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };
  if (previo.etag) {
    headers["if-none-match"] = previo.etag;
  }
  if (previo.lastModified) {
    headers["if-modified-since"] = previo.lastModified;
  }
  // El cuerpo se lee dentro del mismo `try` que el `fetch`: un tiempo de espera al
  // descargar también se traduce (el `TimeoutError` que lanza el `AbortSignal`).
  let response: Response;
  let body = "";
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(FEED_TIMEOUT_MS), redirect: "follow" });
    if (response.status !== 304 && response.ok) {
      const tipo = response.headers.get("content-type") ?? "";
      if (tipo && !/xml|json|text/i.test(tipo)) {
        throw new Error(`content-type inesperado (${tipo}).`);
      }
      body = await leerConTope(response, MAX_FEED_BYTES);
    }
  } catch (err) {
    const causa =
      err instanceof Error
        ? err.name === "TimeoutError"
          ? `no respondió en ${FEED_TIMEOUT_MS / 1000} s`
          : err.cause instanceof Error
            ? err.cause.message
            : err.message
        : String(err);
    throw new Error(`no se pudo descargar: ${causa}`);
  }
  if (response.status === 304) {
    return { tipo: "sinCambios" };
  }
  if (!response.ok) {
    throw new Error(`el servidor respondió ${response.status}.`);
  }
  return {
    tipo: "nuevo",
    body,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
  };
}

/** Minúsculas, sin tildes y con el espacio colapsado: las reglas no distinguen acentos. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Enlace canónico para deduplicar: sin fragmento, sin parámetros de campaña
 * (`utm_*`, `fbclid`, `ref`, `ref_src`), host en minúsculas y sin barra final.
 * Si la URL no parsea, se usa el texto recortado.
 */
export function enlaceCanonico(url: string): string {
  const crudo = url.trim();
  try {
    const u = new URL(crudo);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const clave of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|ref_src$|source$)/i.test(clave)) {
        u.searchParams.delete(clave);
      }
    }
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return crudo.slice(0, 2000);
  }
}

/** sha256 hex del enlace canónico y el título normalizado: clave única de la noticia. */
export function hashNoticia(enlace: string, titulo: string): string {
  return createHash("sha256")
    .update(`${enlaceCanonico(enlace)}|${normalizarTexto(titulo)}`, "utf8")
    .digest("hex");
}

/** Veredicto de las reglas por tema sobre el texto normalizado (título + resumen). */
export interface VeredictoReglas {
  /** Pasa a la capa del LLM. */
  pasa: boolean;
  /** Tema cuya regla de inclusión casó primero; vacío si no casó ninguno. */
  tema: string;
}

/** Reglas compiladas una vez por pasada: casan por palabra, no por subcadena suelta. */
export interface ReglasCompiladas {
  excluir: RegExp[];
  incluir: { re: RegExp; tema: string }[];
}

function escapeRegExp(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Expresión de una regla: la palabra o frase completa, sin pegar a otras letras o
 * dígitos. La regla se normaliza igual que el texto (minúsculas y sin tildes) para que
 * «computación» case con «computacion». */
function regexDeRegla(regla: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(normalizarTexto(regla))}(?![a-z0-9])`, "i");
}

/** Precompila las reglas de los temas activos. */
export function compilarReglas(temas: RadarTema[]): ReglasCompiladas {
  const excluir: RegExp[] = [];
  const incluir: { re: RegExp; tema: string }[] = [];
  for (const tema of temas) {
    for (const regla of tema.excluir) {
      if (regla.trim()) {
        excluir.push(regexDeRegla(regla));
      }
    }
  }
  for (const tema of temas) {
    for (const regla of tema.incluir) {
      if (regla.trim()) {
        incluir.push({ re: regexDeRegla(regla), tema: tema.nombre });
      }
    }
  }
  return { excluir, incluir };
}

/**
 * Filtro barato por reglas: excluido gana siempre; sin exclusión, pasa si casa con
 * alguna inclusión. Sin ninguna regla de inclusión configurada, todo pasa (el LLM decide).
 *
 * Con `temaFijo` (fuente temática: xkcd, Rock Paper Shotgun…) se salta la inclusión y
 * pasa con ese tema: el feed entero es de ese tema y exigirle palabras clave solo servía
 * para tirar titulares buenos («Review: …» de un juego no dice «juego»). La exclusión
 * sigue aplicando: ahí viven el spam, los cupones y los casinos.
 */
export function pasaReglasCompiladas(
  reglas: ReglasCompiladas,
  textoNormalizado: string,
  temaFijo = ""
): VeredictoReglas {
  for (const re of reglas.excluir) {
    if (re.test(textoNormalizado)) {
      return { pasa: false, tema: "" };
    }
  }
  if (temaFijo) {
    return { pasa: true, tema: temaFijo };
  }
  for (const { re, tema } of reglas.incluir) {
    if (re.test(textoNormalizado)) {
      return { pasa: true, tema };
    }
  }
  return { pasa: reglas.incluir.length === 0, tema: "" };
}

/** Convierte las entradas de un feed en noticias normalizadas, con su veredicto de reglas. */
export function normalizarItems(
  items: FeedItem[],
  fuente: RadarFuente,
  temas: RadarTema[],
  ahora: number
): RadarNoticia[] {
  const reglas = compilarReglas(temas);
  const vistos = new Set<string>();
  const out: RadarNoticia[] = [];
  const corte = ahora - RETENCION_DIAS * 24 * 60 * 60 * 1000;
  for (const item of items) {
    const titulo = item.titulo.trim();
    const enlace = item.enlace.trim();
    if (!titulo || !enlace) {
      continue; // Sin título ni enlace no hay noticia que guardar.
    }
    if (item.publicada > 0 && item.publicada < corte) {
      continue; // Archivo del feed: más vieja que la retención, la purga la borraría igual.
    }
    const hash = hashNoticia(enlace, titulo);
    if (vistos.has(hash)) {
      continue; // El propio feed se repite (p. ej. con y sin utm): se queda la primera.
    }
    vistos.add(hash);
    const veredicto = pasaReglasCompiladas(
      reglas,
      normalizarTexto(`${titulo} ${item.resumen}`),
      fuente.temaFijo ?? ""
    );
    out.push({
      hash,
      fuenteId: fuente.id,
      fuenteNombre: fuente.nombre,
      titulo: titulo.slice(0, 1000),
      enlace: enlace.slice(0, 2000),
      resumen: item.resumen,
      autor: item.autor,
      // Sin fecha o con fecha futura (feed mal configurado) cuenta como recién llegada.
      publicada: item.publicada > 0 && item.publicada <= ahora + 60 * 60 * 1000 ? item.publicada : ahora,
      recogida: ahora,
      descartada: !veredicto.pasa,
      temaRegla: veredicto.tema,
    });
  }
  return out;
}

/** Descarga y parsea una fuente; los fallos lanzan con mensaje en español. */
export async function leerFuente(
  fuente: RadarFuente,
  previo: FeedPrevio,
  temas: RadarTema[],
  ahora: number
): Promise<{ noticias: RadarNoticia[]; descarga: DescargaFeed }> {
  const descarga = await descargarFeed(fuente.url, previo);
  if (descarga.tipo === "sinCambios") {
    return { noticias: [], descarga };
  }
  const items = parseFeed(descarga.body, fuente.url);
  if (items.length === 0 && !/<(rss|feed|rdf:RDF)\b/i.test(descarga.body)) {
    // Un 200 con una página de error o un bloqueo no es un feed: sin esto se guardaba
    // el etag y la fuente quedaba «sana» para siempre, sin una sola noticia.
    throw new Error("la respuesta no parece un feed (¿página de error o bloqueo?)");
  }
  return { noticias: normalizarItems(items, fuente, temas, ahora), descarga };
}

/** Map con concurrencia acotada, preservando el orden de los resultados. */
export async function mapConcurrente<T, R>(
  items: readonly T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.max(1, Math.min(limite, items.length)) }, async () => {
    for (;;) {
      const i = siguiente++;
      if (i >= items.length) {
        return;
      }
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(trabajadores);
  return out;
}
