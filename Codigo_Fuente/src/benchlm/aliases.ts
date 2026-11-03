/**
 * Alias de BenchLM por modelo: convertir lo que escribe la persona en el identificador de
 * BenchLM y sanear lo que hay guardado en `globalState`. Sin `vscode`, para poder probarlo.
 */

/** Tope de una clave de modelo guardada y del alias que la acompaña. */
export const MAX_ALIAS = 200;

/** Slug al estilo BenchLM: minúsculas y todo lo que no sea `[a-z0-9]` convertido en `-`. */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Identificador de BenchLM de un modelo. Vale el slug suelto (`claude-sonnet-4-5`) o la URL de
 * su ficha (`https://benchlm.ai/models/claude-sonnet-4-5/`, con query o hash): de la URL se queda
 * el último tramo de la ruta. Devuelve "" si no queda nada.
 */
export function normalizeAlias(value: string): string {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "";
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(text);
  if (url) {
    // Sin query ni hash, y sin barras de los extremos: una URL sin ruta no es un modelo.
    const path = url[1].replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
    const segments = path.split("/");
    text = segments.length > 1 ? segments[segments.length - 1] : "";
  }
  return slugify(text);
}

/** Lo guardado en `globalState`, sin fiarse: solo claves y valores de texto, recortados y acotados. */
export function readAliases(value: unknown): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return aliases;
  }
  for (const [rawKey, rawAlias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawAlias !== "string") {
      continue;
    }
    const key = rawKey.trim().slice(0, MAX_ALIAS);
    const alias = rawAlias.trim().slice(0, MAX_ALIAS);
    if (!key || !alias) {
      continue;
    }
    aliases[key] = alias;
  }
  return aliases;
}
