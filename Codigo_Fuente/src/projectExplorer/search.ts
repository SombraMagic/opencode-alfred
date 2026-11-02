/**
 * Búsqueda del Explorador del proyecto sobre el árbol ya escaneado:
 * nombre/ruta (síncrona, en memoria) y contenido (asíncrona, en el host,
 * con concurrencia acotada y cancelación por AbortSignal).
 */

import { open, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { Tree } from "./scanner";

/** Ficheros mayores de 1 MB no se leen para contenido. */
export const MAX_CONTENT_BYTES = 1024 * 1024;
/** Tope de ficheros devueltos por la búsqueda de contenido. */
export const MAX_CONTENT_HITS = 1000;
/** Lecturas simultáneas de contenido. */
const CONTENT_CONCURRENCY = 8;
/** Ventanilla para detectar binarios (NUL en los primeros 8 KB). */
const BINARY_PROBE = 8192;
/** Carpetas que nunca se leen para contenido (se buscan igual por nombre). */
const SKIP_SEGMENT_RE = /(^|\/)(node_modules|dist|build)(\/|$)/;

export interface ContentHit {
  rel: string;
  /** Número de línea (1-based) de la primera coincidencia. */
  line: number;
  /** Primera línea coincidente, recortada. */
  text: string;
}

export interface NameMatch {
  rel: string;
  id: number;
}

function visible(name: string, showHidden: boolean): boolean {
  return showHidden || !name.startsWith(".");
}

/**
 * Coincidencias por nombre de fichero/carpeta o por segmento de carpeta del
 * camino. Case-insensitive, sobre el árbol en memoria.
 */
export function searchNames(tree: Tree, query: string, showHidden: boolean): NameMatch[] {
  const q = query.toLowerCase();
  if (!q) {
    return [];
  }
  const out: NameMatch[] = [];
  for (const [id, e] of tree.entries) {
    if (id === tree.rootId) {
      continue;
    }
    if (!visible(e.name, showHidden)) {
      continue;
    }
    if (e.kind === "missing") {
      continue;
    }
    if (e.name.toLowerCase().includes(q)) {
      out.push({ rel: e.rel, id });
      continue;
    }
    // Carpeta del camino (todos menos el último segmento).
    const dir = e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/")) : "";
    if (dir && dir.toLowerCase().includes(q)) {
      out.push({ rel: e.rel, id });
    }
  }
  return out;
}

function utf16Bom(buf: Buffer): boolean {
  return buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff));
}

function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le", 2);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: sin decodificador nativo, se vuelven los pares de bytes.
    const swapped = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const b = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = b;
    }
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf8", 3);
  }
  return buf.toString("utf8");
}

function firstMatch(text: string, q: string): { line: number; text: string } | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.toLowerCase().includes(q)) {
      const trimmed = line.trim();
      return { line: i + 1, text: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed };
    }
  }
  return null;
}

/**
 * Búsqueda de contenido. Candidatos: ficheros del árbol <= 1 MB, fuera de
 * node_modules/dist/build, sin NUL en los primeros 8 KB y texto UTF-8/UTF-16
 * con BOM. `skipped` son ids ya encontrados por nombre. Tolerante a errores:
 * un fichero ilegible se ignora, no aborta la búsqueda.
 */
export async function searchContents(
  tree: Tree,
  rootAbs: string,
  query: string,
  showHidden: boolean,
  opts: { signal?: AbortSignal; skipped?: ReadonlySet<number> } = {}
): Promise<ContentHit[]> {
  const q = query.toLowerCase();
  if (!q) {
    return [];
  }
  const candidates: number[] = [];
  for (const [id, e] of tree.entries) {
    if (id === tree.rootId) {
      continue;
    }
    if (e.kind !== "file" || e.error) {
      continue;
    }
    if (e.size <= 0 || e.size > MAX_CONTENT_BYTES) {
      continue;
    }
    if (!visible(e.name, showHidden)) {
      continue;
    }
    if (SKIP_SEGMENT_RE.test(e.rel)) {
      continue;
    }
    if (opts.skipped?.has(id)) {
      continue;
    }
    if (e.name.toLowerCase().includes(q)) {
      // Ya salió en la búsqueda por nombre: no hace falta leerlo.
      continue;
    }
    candidates.push(id);
  }

  const hits: ContentHit[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted || hits.length >= MAX_CONTENT_HITS) {
        return;
      }
      const idx = cursor;
      if (idx >= candidates.length) {
        return;
      }
      cursor += 1;
      const e = tree.entries.get(candidates[idx]);
      if (!e) {
        continue;
      }
      const abs = path.join(rootAbs, ...e.rel.split("/"));
      let handle: FileHandle | undefined;
      try {
        handle = await open(abs, "r");
        const buf = Buffer.alloc(MAX_CONTENT_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MAX_CONTENT_BYTES, 0);
        const slice = buf.subarray(0, bytesRead);
        // Un BOM UTF-16 justifica los NUL del codificado: la sonda de binario va después.
        if (!utf16Bom(slice) && slice.subarray(0, BINARY_PROBE).includes(0)) {
          continue;
        }
        const m = firstMatch(decode(slice), q);
        if (m) {
          hits.push({ rel: e.rel, line: m.line, text: m.text });
        }
      } catch {
        // Ilegible o desaparecido: se ignora.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONTENT_CONCURRENCY; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return hits;
}
