/**
 * Condition de búsqueda y orden para la tabla de datos de MariaDB. Todo con nombres
 * validados por `ident()` y el término como parametro. Sin `vscode`.
 */

import { escapeLike, ident } from "./quote";
import type { DbColumn } from "./types";

/** Tipos que no se pueden comparar en texto sin romper el resultado. */
const BINARY_TYPES = new Set([
  "binary",
  "varbinary",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
]);

/**
 * `WHERE` de búsqueda texto sobre todas las columnas no binarias, con `LIKE` escapado.
 * Devuelve `undefined` si el término esta vacio o si no queda ninguna columna util.
 */
export function searchWhere(
  columns: DbColumn[],
  term: string
): { sql: string; params: string[] } | undefined {
  if (term.trim() === "") {
    return undefined;
  }
  const escaped = escapeLike(term);
  if (escaped === "") {
    return undefined;
  }
  const usables = columns.filter((c) => !BINARY_TYPES.has(c.dataType.toLowerCase()));
  if (usables.length === 0) {
    return undefined;
  }
  const conds = usables.map((c) => `CAST(${ident(c.name)} AS CHAR) LIKE ? ESCAPE '\\\\'`);
  const params = usables.map(() => `%${escaped}%`);
  return { sql: conds.join(" OR "), params };
}

/**
 * `ORDER BY` listo para concatenar, con espacio inicial. Cadena vacia si no se pide
 * orden o si la columna no existe en la lista.
 */
export function orderByClause(
  columns: DbColumn[],
  orderBy?: { column: string; dir: "asc" | "desc" }
): string {
  if (!orderBy || !orderBy.column) {
    return "";
  }
  const col = columns.find((c) => c.name === orderBy.column);
  if (!col) {
    return "";
  }
  return ` ORDER BY ${ident(col.name)} ${orderBy.dir === "desc" ? "DESC" : "ASC"}`;
}
