/**
 * Escritura de filas en MariaDB: actualizar una celda, insertar una fila y borrar filas
 * por lotes. Los valores siempre viajan como parámetros del driver y los nombres de
 * base, tabla y columna se validan con `ident()`. Sin `vscode`.
 */

import type { DbSession } from "./driver";
import { ident, qualified } from "./quote";
import type { DbCell, DbColumn } from "./types";

/** Fila identificada por las columnas de su clave primaria o de un índice único. */
export interface RowIdentity {
  columns: string[];
  values: DbCell[];
}

/** Filas por sentencia en los borrados en lote. */
const DELETE_BATCH = 100;

/** Tabla sin identidad: mejor no tocarla. */
const NO_IDENTITY = "La tabla no tiene clave primaria ni índice único: no se puede editar con seguridad.";

/** Parametro apto para mysql2. */
type Param = string | Buffer | null;

/** Celda → parametro: binario como Buffer, nulo como NULL, texto tal cual (los números
 * viajan como cadena y el servidor los castea al comparar o insertar). */
export function toParam(cell: DbCell): Param {
  if (cell === null) {
    return null;
  }
  if (typeof cell === "string") {
    return cell;
  }
  return Buffer.from(cell.b64, "base64");
}

/** `col = ?` o `col IS NULL` según la celda, con su parametro ya preparado. */
function matchPart(column: string, value: DbCell): { sql: string; params: Param[] } {
  if (value === null) {
    return { sql: `${ident(column)} IS NULL`, params: [] };
  }
  return { sql: `${ident(column)} = ?`, params: [toParam(value)] };
}

/** Comprueba que la identidad tiene columnas y valores coherentes. */
function checkIdentity(columns: string[], values: DbCell[]): void {
  if (columns.length === 0) {
    throw new Error(NO_IDENTITY);
  }
  if (values.length !== columns.length) {
    throw new Error("El número de valores de la identidad no coincide con el de sus columnas.");
  }
}

/**
 * Actualiza una celda de la fila señalada por la identidad. `LIMIT 1` acota el daño y
 * mysql2 cuenta las filas coincidentes: si no afecta exactamente a una, la fila ya no
 * está donde estaba (la cambió otro o se fue), y eso es error, no un silencio.
 */
export async function updateRowCell(
  s: DbSession,
  db: string,
  table: string,
  identity: RowIdentity,
  column: DbColumn,
  value: DbCell
): Promise<void> {
  checkIdentity(identity.columns, identity.values);
  const where = identity.columns.map((name, i) => matchPart(name, identity.values[i]));
  const params: Param[] = [toParam(value)];
  for (const w of where) {
    params.push(...w.params);
  }
  const sql =
    `UPDATE ${qualified(db, table)} SET ${ident(column.name)} = ? ` +
    `WHERE ${where.map((w) => w.sql).join(" AND ")} LIMIT 1`;
  const res = await s.query(sql, params);
  if (res.affected !== 1) {
    throw new Error(`La edición no afectó a la fila (coinciden ${res.affected}): recarga la tabla.`);
  }
}

/**
 * Inserta una fila. Solo se nombran las columnas conocidas que trae `values`: las
 * demás quedan en su defecto del `CREATE TABLE` (no se manda NULL a la fuerza, salvo
 * que el usuario marque la celda como nula de forma explícita). Las claves que no
 * corresponden a ninguna columna se ignoran.
 */
export async function insertRow(
  s: DbSession,
  db: string,
  table: string,
  columns: DbColumn[],
  values: Record<string, DbCell>
): Promise<{ insertId?: string }> {
  const porClave = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  const nombres: string[] = [];
  const params: Param[] = [];
  const vistas = new Set<string>();
  for (const clave of Object.keys(values)) {
    const col = porClave.get(clave.toLowerCase());
    if (!col || vistas.has(col.name.toLowerCase())) {
      continue;
    }
    const cell = values[clave];
    if (cell === undefined) {
      continue;
    }
    vistas.add(col.name.toLowerCase());
    nombres.push(ident(col.name));
    params.push(toParam(cell));
  }
  const lista = nombres.length > 0 ? ` (${nombres.join(", ")})` : "";
  const valores = nombres.length > 0 ? params.map(() => "?").join(", ") : "";
  const res = await s.query(`INSERT INTO ${qualified(db, table)}${lista} VALUES (${valores})`, params);
  return res.insertId === undefined ? {} : { insertId: res.insertId };
}

/**
 * Borra filas en lotes de 100, una sentencia por lote: `IN (...)` cuando la identidad
 * es una sola columna sin nulos y OR de tuplas en el resto de casos. Devuelve el total
 * de filas afectadas y, si un lote falla, las ya borradas con el error. Con identidad
 * vacía, ni lo intenta.
 */
export async function deleteRows(
  s: DbSession,
  db: string,
  table: string,
  identity: { columns: string[]; rows: DbCell[][] }
): Promise<{ deleted: number; error?: string }> {
  if (identity.columns.length === 0) {
    throw new Error(NO_IDENTITY);
  }
  if (identity.rows.length === 0) {
    return { deleted: 0 };
  }
  const tabla = qualified(db, table);
  let deleted = 0;
  for (let start = 0; start < identity.rows.length; start += DELETE_BATCH) {
    const lote = identity.rows.slice(start, start + DELETE_BATCH);
    const params: Param[] = [];
    const partes: string[] = [];
    for (const row of lote) {
      if (row.length !== identity.columns.length) {
        throw new Error("El número de valores de una fila no coincide con el de las columnas de la identidad.");
      }
      const conds = identity.columns.map((name, i) => {
        const m = matchPart(name, row[i]);
        params.push(...m.params);
        return m.sql;
      });
      partes.push(`(${conds.join(" AND ")})`);
    }
    const todoScalar = identity.columns.length === 1 && lote.every((r) => r[0] !== null);
    const sql = todoScalar
      ? `DELETE FROM ${tabla} WHERE ${ident(identity.columns[0])} IN (${lote.map(() => "?").join(", ")})`
      : `DELETE FROM ${tabla} WHERE ${partes.join(" OR ")}`;
    try {
      const res = await s.query(sql, params);
      deleted += res.affected;
    } catch (e) {
      return { deleted, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { deleted };
}
