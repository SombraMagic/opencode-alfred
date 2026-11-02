/**
 * Exportación de tablas MariaDB a CSV, JSON y SQL. La tabla se recorre en streaming con
 * `eachRow` del driver, nunca se carga entera en memoria, y el fichero se escribe en un
 * temporal que se renombra al acabar: si algo falla, no queda un export a medias.
 * Sin `vscode`.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { DbSession } from "./driver";
import { ident, qualified, quoteCell } from "./quote";
import type { DbCell, DbColumn } from "./types";

/** Formatos de salida soportados. */
export type ExportFormat = "csv" | "json" | "sql";

/** Filas por sentencia INSERT del formato SQL. */
const SQL_BATCH = 100;

/** Filas entre avisos de progreso. */
const PROGRESS_EVERY = 1000;

/** Tope del recorrido: el defecto del driver (30 s) se queda corto en tablas grandes. */
const SCAN_TIMEOUT_MS = 3600000;

/** Manejador del temporal: escribir, cerrar renombrando o tirar el temporal. */
export interface AtomicFile {
  /** Escribe con contrapresión: la promesa se resuelve cuando el troco va al disco. */
  write(chunk: string): Promise<void>;
  /** Cierra el flujo y renombra el temporal al destino. */
  finish(): Promise<void>;
  /** Tira el flujo y borra el temporal. Nunca lanza. */
  abort(): Promise<void>;
  /** Bytes escritos acumulados (aproximados, para el progreso). */
  readonly bytes: number;
}

function comoError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Abre `filePath + ".tmp"` para escritura secuencial. Lo comparte el exportador con el
 * volcador JS para que los dos dejen el fichero entero o ninguno.
 */
export async function openAtomicFile(filePath: string): Promise<AtomicFile> {
  const tmp = `${filePath}.tmp`;
  await mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  const stream: WriteStream = createWriteStream(tmp);
  let fallo: Error | undefined;
  let bytes = 0;
  stream.on("error", (e) => {
    fallo = comoError(e);
  });
  const cierre = new Promise<void>((resolve, reject) => {
    stream.once("error", (e) => reject(comoError(e)));
    stream.once("close", () => resolve());
  });
  // Si el cuerpo aborta antes de cerrar, el rechazo puede llegar sin nadie que lo espere.
  cierre.catch(() => undefined);
  return {
    get bytes(): number {
      return bytes;
    },
    async write(chunk: string): Promise<void> {
      if (fallo) {
        throw fallo;
      }
      bytes += Buffer.byteLength(chunk);
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (e) => (e ? reject(comoError(e)) : resolve()));
      });
      if (fallo) {
        throw fallo;
      }
    },
    async finish(): Promise<void> {
      stream.end();
      try {
        await cierre;
      } finally {
        if (fallo) {
          await rm(tmp, { force: true }).catch(() => undefined);
          throw fallo;
        }
      }
      await rename(tmp, filePath);
    },
    async abort(): Promise<void> {
      try {
        stream.destroy();
      } catch {
        // ya estaba roto
      }
      try {
        await cierre;
      } catch {
        // el flujo falló a mitad: se borra el temporal igual
      }
      await rm(tmp, { force: true }).catch(() => undefined);
    },
  };
}

/** Celda en texto plano para CSV: los binarios van en base64. */
function csvText(cell: DbCell): string {
  if (cell === null) {
    return "";
  }
  return typeof cell === "string" ? cell : cell.b64;
}

/** Campo CSV: entre comillas y con las dobles duplicadas si lleva `,` `"` o saltos. */
function csvCell(cell: DbCell): string {
  const text = csvText(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Valor de celda para el JSON compacto: nulo, cadena o objeto binario. */
function jsonCell(cell: DbCell): string {
  if (cell === null) {
    return "null";
  }
  if (typeof cell === "string") {
    return JSON.stringify(cell);
  }
  return JSON.stringify({ b64: cell.b64, bytes: cell.bytes });
}

function jsonRow(columns: DbColumn[], row: DbCell[]): string {
  const partes = columns.map((c, i) => `${JSON.stringify(c.name)}:${jsonCell(row[i] ?? null)}`);
  return `{${partes.join(",")}}`;
}

/**
 * Vuelca la tabla a `filePath` en el formato pedido. `columns` fija el orden y las
 * columnas a exportar. Devuelve el número de filas y los bytes del fichero final.
 */
export async function exportTable(
  s: DbSession,
  db: string,
  table: string,
  columns: DbColumn[],
  format: ExportFormat,
  filePath: string,
  onProgress?: (rows: number) => void
): Promise<{ rows: number; bytes: number }> {
  if (columns.length === 0) {
    throw new Error("La tabla no tiene columnas que exportar.");
  }
  const listaCols = columns.map((c) => ident(c.name)).join(", ");
  const sql = `SELECT ${listaCols} FROM ${qualified(db, table)}`;
  const file = await openAtomicFile(filePath);
  let rows = 0;
  let lote: string[] = [];
  const insertHead = `INSERT INTO ${qualified(db, table)} (${listaCols}) VALUES `;
  try {
    if (format === "csv") {
      await file.write(`\uFEFF${columns.map((c) => csvCell(c.name)).join(",")}\r\n`);
    } else if (format === "json") {
      await file.write("[");
    } else {
      await file.write("SET NAMES utf8mb4;\n");
    }
    await s.eachRow(
      sql,
      [],
      async (row) => {
        if (format === "csv") {
          await file.write(`${row.map(csvCell).join(",")}\r\n`);
        } else if (format === "json") {
          await file.write(`${rows > 0 ? "," : ""}${jsonRow(columns, row)}`);
        } else {
          lote.push(`(${row.map(quoteCell).join(", ")})`);
          if (lote.length >= SQL_BATCH) {
            await file.write(`${insertHead}${lote.join(", ")};\n`);
            lote = [];
          }
        }
        rows++;
        if (rows % PROGRESS_EVERY === 0 && onProgress) {
          onProgress(rows);
        }
      },
      { timeoutMs: SCAN_TIMEOUT_MS }
    );
    if (format === "sql" && lote.length > 0) {
      await file.write(`${insertHead}${lote.join(", ")};\n`);
    }
    if (format === "json") {
      await file.write("]");
    }
    await file.finish();
  } catch (e) {
    await file.abort();
    throw comoError(e);
  }
  const bytes = (await stat(filePath)).size;
  return { rows, bytes };
}
