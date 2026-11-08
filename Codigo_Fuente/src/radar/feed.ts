/**
 * Parser propio de RSS 2.0 y Atom, sin dependencias. Tolerante a XML mal formado:
 * un feed roto devuelve pocas o ninguna entrada, nunca lanza. Sin `vscode`.
 */

/** Entrada de feed ya normalizada. */
export interface FeedItem {
  titulo: string;
  enlace: string;
  resumen: string;
  autor: string;
  /** Epoch ms; 0 si la fecha falta o no se entiende. */
  publicada: number;
}

/** Tope de entradas por feed: suficiente para 3 días de retención. */
const MAX_ITEMS = 200;
/** Longitud máxima de los campos tras limpiar. */
const MAX_TITULO = 500;
const MAX_RESUMEN = 600;
const MAX_AUTOR = 200;
const MAX_ENLACE = 2000;

/** Quita `<![CDATA[...]]>` y devuelve el contenido crudo de la etiqueta. */
function inner(tag: string, bloque: string): string {
  // Etiqueta con o sin prefijo (`dc:creator`, `content:encoded`…) y atributos.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, "i");
  const m = re.exec(bloque);
  if (!m) {
    return "";
  }
  return m[1] ?? "";
}

/** Contenido de `<tag ...>` o del atributo indicado (`href` en los `<link>` de Atom). */
function attr(tag: string, nombre: string, bloque: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?\\s${nombre}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(bloque);
  if (!m) {
    return "";
  }
  return m[2] ?? m[3] ?? "";
}

/** Deshace CDATA y entidades XML numéricas y con nombre. */
export function decodificarEntidades(texto: string): string {
  let out = texto.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Doble CDATA anidado (feeds que escapan dos veces): una pasada más, sin bucle.
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return out.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entidad: string) => {
    switch (entidad.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entidad.toLowerCase().startsWith("#x")
          ? parseInt(entidad.slice(2), 16)
          : parseInt(entidad.slice(1), 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
          return match;
        }
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
  });
}

/** Quita etiquetas HTML y colapsa espacios: los resúmenes vienen como HTML. */
export function limpiarHtml(texto: string): string {
  return texto
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Texto plano final: entidades fuera, HTML fuera, espacio colapsado, longitud acotada. */
function textoPlano(crudo: string, max: number): string {
  const plano = limpiarHtml(decodificarEntidades(crudo));
  return plano.length > max ? plano.slice(0, max - 1).trimEnd() + "…" : plano;
}

/**
 * Fecha a epoch ms. Acepta RFC 822 (RSS) e ISO 8601 (Atom). Formatos raros o
 * ausentes dan 0: la noticia sigue valiendo, solo pierde su fecha.
 */
export function fechaAEpoch(crudo: string): number {
  const texto = crudo.trim();
  if (!texto) {
    return 0;
  }
  let ms = Date.parse(texto);
  if (Number.isFinite(ms)) {
    return ms;
  }
  // "Sat, 08 Nov 2026 10:00:00 GMT" con espacio de más o zona rara: se recorta y reintenta.
  const recortado = texto.replace(/\s*\((?:[A-Z]{3,4}|GMT|UTC)\)$/i, "").trim();
  ms = Date.parse(recortado);
  return Number.isFinite(ms) ? ms : 0;
}

/** Resuelve un enlace relativo contra la URL del feed; si no puede, devuelve el crudo. */
export function resolverEnlace(enlace: string, urlBase: string): string {
  const limpio = enlace.trim();
  if (!limpio) {
    return "";
  }
  try {
    return new URL(limpio, urlBase || undefined).toString();
  } catch {
    return limpio;
  }
}

/** Extrae los bloques `<item>…</item>` o `<entry>…</entry>` con una pasada tolerante. */
function bloques(xml: string, etiqueta: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${etiqueta}(?:\\s[^>]*)?>([\\s\\S]*?)</${etiqueta}\\s*>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && out.length < MAX_ITEMS) {
    out.push(m[1] ?? "");
  }
  if (out.length === 0) {
    // Cierre ausente o mal escrito: se parte por la apertura y se llega hasta la siguiente.
    const reAbre = new RegExp(`<${etiqueta}(?:\\s[^>]*)?>`, "gi");
    const cortes: number[] = [];
    let a: RegExpExecArray | null;
    while ((a = reAbre.exec(xml)) !== null && cortes.length <= MAX_ITEMS) {
      cortes.push(a.index + a[0].length);
    }
    for (let i = 0; i < cortes.length && out.length < MAX_ITEMS; i++) {
      const fin = i + 1 < cortes.length ? cortes[i + 1] : xml.length;
      out.push(xml.slice(cortes[i], fin));
    }
  }
  return out;
}

/** Enlace de un bloque: RSS lo lleva como texto; Atom, en `href` (rel alternate o el primero). */
function enlaceDe(bloque: string, esAtom: boolean, urlBase: string): string {
  if (!esAtom) {
    const texto = decodificarEntidades(inner("link", bloque)).trim();
    if (texto && /^https?:\/\//i.test(texto)) {
      return texto.slice(0, MAX_ENLACE);
    }
    // RSS con link Atom de autopista o `<link href>`: se prueba el atributo antes de rendirse.
    const href = attr("link", "href", bloque);
    if (href) {
      return resolverEnlace(href, urlBase).slice(0, MAX_ENLACE);
    }
    // Último recurso: el guid con forma de URL (permalink).
    const guid = decodificarEntidades(inner("guid", bloque)).trim();
    if (/^https?:\/\//i.test(guid)) {
      return guid.slice(0, MAX_ENLACE);
    }
    return texto ? resolverEnlace(texto, urlBase).slice(0, MAX_ENLACE) : "";
  }
  // Atom: varios `<link>`; se prefiere rel="alternate" y, si no, el primero con href.
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let primero = "";
  while ((m = re.exec(bloque)) !== null) {
    const tag = m[0];
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const url = href ? (href[2] ?? href[3] ?? "") : "";
    if (!url) {
      continue;
    }
    const rel = /\brel\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const relValor = rel ? (rel[2] ?? rel[3] ?? "").toLowerCase() : "alternate";
    if (relValor === "alternate") {
      return resolverEnlace(url, urlBase).slice(0, MAX_ENLACE);
    }
    if (!primero) {
      primero = url;
    }
  }
  return primero ? resolverEnlace(primero, urlBase).slice(0, MAX_ENLACE) : "";
}

/** Autor: `<author>` plano (RSS), con `<name>` dentro (Atom) o `dc:creator`. */
function autorDe(bloque: string): string {
  const crudo = inner("author", bloque) || inner("dc:creator", bloque) || inner("creator", bloque);
  if (!crudo) {
    return "";
  }
  const nombre = inner("name", crudo);
  return textoPlano(nombre || crudo, MAX_AUTOR);
}

/** Fecha: la primera legible de las habituales en RSS y Atom. */
function fechaDe(bloque: string): number {
  const campos = ["pubDate", "published", "dc:date", "date", "updated"];
  for (const campo of campos) {
    const ms = fechaAEpoch(decodificarEntidades(inner(campo, bloque)));
    if (ms > 0) {
      return ms;
    }
  }
  return 0;
}

/**
 * Parsea el XML de un feed RSS 2.0 o Atom y devuelve sus entradas normalizadas.
 * Nunca lanza: un documento vacío o roto devuelve [].
 */
export function parseFeed(xml: string, urlBase: string): FeedItem[] {
  if (typeof xml !== "string" || !xml.trim()) {
    return [];
  }
  // Atom: `<feed …>` con `<entry>`; RSS: `<rss …>` con `<item>`. Se decide por el primero que aparezca.
  const feedAt = xml.search(/<feed[\s>]/i);
  const rssAt = xml.search(/<rss[\s>]/i);
  const esAtom = feedAt >= 0 && (rssAt < 0 || feedAt < rssAt);
  const etiqueta = esAtom ? "entry" : "item";

  const out: FeedItem[] = [];
  for (const bloque of bloques(xml, etiqueta)) {
    const titulo = textoPlano(inner("title", bloque), MAX_TITULO);
    const enlace = enlaceDe(bloque, esAtom, urlBase);
    if (!titulo && !enlace) {
      continue; // Entrada vacía o bloque basura: se salta en silencio.
    }
    const resumenCrudo =
      inner("description", bloque) ||
      inner("summary", bloque) ||
      inner("content:encoded", bloque) ||
      inner("content", bloque);
    out.push({
      titulo,
      enlace,
      resumen: textoPlano(resumenCrudo, MAX_RESUMEN),
      autor: autorDe(bloque),
      publicada: fechaDe(bloque),
    });
  }
  return out;
}
