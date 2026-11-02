/**
 * Operaciones de esquema MariaDB: listas de bases, tablas, columnas, índices y claves
 * foráneas, más las acciones de crear, borrar, vaciar y renombrar.
 * Consultas siempre parametrizadas y nombres siempre por `ident()`. Sin `vscode`.
 */

import type { DbSession } from "./driver";
import { ident, qualified, quoteValue } from "./quote";
import type {
  DbColumn,
  DbForeignKey,
  DbIndex,
  DbTableInfo,
  DbTableSpec,
  DbTableSpecColumn,
} from "./types";

/** Esquemas del sistema que no se listan. */
const SYSTEM_SCHEMAS = ["information_schema", "performance_schema", "mysql", "sys"];

/** Tipos de columna admitidos al crear una tabla. */
const COLUMN_TYPES = [
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "MEDIUMINT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "VARCHAR",
  "CHAR",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "TINYTEXT",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "YEAR",
  "BOOLEAN",
  "JSON",
  "BLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "TINYBLOB",
  "ENUM",
  "SET",
  "UUID",
];

/** Únicos tipos que admiten `auto_increment`. */
const INTEGER_TYPES = ["INT", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT"];

/** Tipos cuya longitud lleva decimales (`10,2`). */
const DECIMAL_TYPES = ["DECIMAL", "FLOAT", "DOUBLE"];

/** Tipos de cadena: longitud de un solo número. */
const STRING_TYPES = ["VARCHAR", "CHAR"];

/** `120` o `10,2`. Lo que no encaje aquí es inyección. */
const LENGTH_RE = /^\d{1,6}(,\d{1,6})?$/;

function texto(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return String(value);
}

function nuloOTexto(value: unknown): string | null {
  return value === null || value === undefined ? null : texto(value);
}

/**
 * MariaDB devuelve el defecto como lo escribiría en el DDL: las cadenas van entre
 * comillas (`'hola'`) y las funciones van solas (`current_timestamp()`). Se guarda el
 * valor pelado: el editor lo muestra tal cual y, al crear la tabla, `buildColumn`
 * lo vuelve a entrecomillar. Sin esto, el viaje ida y vuelta duplica las comillas.
 */
function defecto(value: unknown): string | null {
  const raw = nuloOTexto(value);
  if (raw === null) {
    return null;
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function entero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Tope de filas de las lecturas de metadatos: ningún esquema real lo alcanza. */
const META_ROW_LIMIT = 100000;

/** Bases de datos del servidor con su número de tablas y vistas. */
export async function listDatabases(s: DbSession): Promise<{ name: string; tables: number }[]> {
  const marks = SYSTEM_SCHEMAS.map(() => "?").join(", ");
  const sql =
    "SELECT sc.SCHEMA_NAME, COALESCE(t.N, 0) " +
    "FROM information_schema.SCHEMATA sc " +
    "LEFT JOIN (SELECT TABLE_SCHEMA, COUNT(*) AS N FROM information_schema.TABLES GROUP BY TABLE_SCHEMA) t " +
    "ON t.TABLE_SCHEMA = sc.SCHEMA_NAME " +
    `WHERE sc.SCHEMA_NAME NOT IN (${marks}) ` +
    "ORDER BY sc.SCHEMA_NAME";
  const res = await s.query(sql, [...SYSTEM_SCHEMAS], { rowLimit: META_ROW_LIMIT });
  return res.rows.map((row) => ({ name: texto(row[0]), tables: entero(row[1]) }));
}

/** Tablas y vistas de una base, con motor, filas, bytes y comentario. */
export async function listTables(s: DbSession, db: string): Promise<DbTableInfo[]> {
  const sql =
    "SELECT TABLE_NAME, ENGINE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, TABLE_COMMENT, TABLE_TYPE " +
    "FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME";
  const res = await s.query(sql, [db], { rowLimit: META_ROW_LIMIT });
  return res.rows.map((row) => ({
    name: texto(row[0]),
    engine: texto(row[1]),
    rows: entero(row[2]),
    bytes: entero(row[3]),
    comment: texto(row[4]),
    isView: texto(row[5]).toUpperCase() === "VIEW",
  }));
}

/** Columnas de una tabla, en orden físico. */
export async function listColumns(s: DbSession, db: string, table: string): Promise<DbColumn[]> {
  const sql =
    "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT " +
    "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION";
  const res = await s.query(sql, [db, table], { rowLimit: META_ROW_LIMIT });
  return res.rows.map((row) => {
    const key = texto(row[5]).toUpperCase();
    return {
      name: texto(row[0]),
      dataType: texto(row[1]).toLowerCase(),
      columnType: texto(row[2]),
      nullable: texto(row[3]).toUpperCase() === "YES",
      defaultValue: defecto(row[4]),
      key: key === "PRI" || key === "UNI" || key === "MUL" ? (key as DbColumn["key"]) : "",
      extra: texto(row[6]),
      comment: texto(row[7]),
    };
  });
}

/** Índices de una tabla, agrupados por nombre y ordenados por `SEQ_IN_INDEX`. */
export async function listIndexes(s: DbSession, db: string, table: string): Promise<DbIndex[]> {
  const sql =
    "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME " +
    "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? " +
    "ORDER BY INDEX_NAME, SEQ_IN_INDEX";
  const res = await s.query(sql, [db, table], { rowLimit: META_ROW_LIMIT });
  const nombres: string[] = [];
  const mapa = new Map<string, DbIndex>();
  for (const row of res.rows) {
    const name = texto(row[0]);
    if (!name) {
      continue;
    }
    let idx = mapa.get(name);
    if (!idx) {
      idx = { name, unique: entero(row[1]) === 0, columns: [] };
      mapa.set(name, idx);
      nombres.push(name);
    }
    const col = texto(row[2]);
    if (col) {
      idx.columns.push(col);
    }
  }
  return nombres.map((name) => mapa.get(name) as DbIndex);
}

/** Claves foráneas de una tabla, con sus reglas de borrado y actualización. */
export async function listForeignKeys(s: DbSession, db: string, table: string): Promise<DbForeignKey[]> {
  const sql =
    "SELECT kc.CONSTRAINT_NAME, kc.COLUMN_NAME, kc.REFERENCED_TABLE_NAME, kc.REFERENCED_COLUMN_NAME, " +
    "rc.DELETE_RULE, rc.UPDATE_RULE " +
    "FROM information_schema.KEY_COLUMN_USAGE kc " +
    "JOIN information_schema.REFERENTIAL_CONSTRAINTS rc " +
    "ON rc.CONSTRAINT_SCHEMA = kc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kc.CONSTRAINT_NAME " +
    "WHERE kc.TABLE_SCHEMA = ? AND kc.TABLE_NAME = ? AND kc.REFERENCED_TABLE_NAME IS NOT NULL " +
    "ORDER BY kc.CONSTRAINT_NAME, kc.ORDINAL_POSITION";
  const res = await s.query(sql, [db, table], { rowLimit: META_ROW_LIMIT });
  return res.rows.map((row) => ({
    name: texto(row[0]),
    column: texto(row[1]),
    refTable: texto(row[2]),
    refColumn: texto(row[3]),
    onDelete: texto(row[4]),
    onUpdate: texto(row[5]),
  }));
}

/** Crea una base de datos en utf8mb4. Si ya existe, lo avisa el servidor. */
export async function createDatabase(s: DbSession, name: string): Promise<void> {
  await s.query(`CREATE DATABASE ${ident(name)} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

/** Cuenta una familia de objetos del esquema en `information_schema`. */
async function contarObjetos(s: DbSession, sql: string, name: string): Promise<number> {
  const res = await s.query(sql, [name]);
  return res.rows.length > 0 ? entero(res.rows[0][0]) : 0;
}

/** Borra una base de datos solo si no tiene tablas, vistas, rutinas ni eventos. */
export async function dropDatabase(s: DbSession, name: string): Promise<void> {
  const tablas = await contarObjetos(
    s,
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    name
  );
  const rutinas = await contarObjetos(
    s,
    "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
    name
  );
  const eventos = await contarObjetos(
    s,
    "SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?",
    name
  );
  const n = tablas + rutinas + eventos;
  if (n > 0) {
    throw new Error(`La base de datos «${name}» no está vacía (${n} ${n === 1 ? "objeto" : "objetos"}).`);
  }
  await s.query(`DROP DATABASE ${ident(name)}`);
}

/** Tipo normalizado, comprobado contra la allowlist. */
function checkType(column: DbTableSpecColumn): string {
  const type = texto(column.type).toUpperCase().replace(/\s+/g, "");
  if (!COLUMN_TYPES.includes(type)) {
    throw new Error(`Tipo de columna no admitido: ${column.type}.`);
  }
  return type;
}

/** Lista de valores de ENUM y SET: entre comillas o sueltos. */
function enumValues(raw: string, column: string): string {
  const list = raw.trim();
  if (!list) {
    throw new Error(`«${column}» necesita la lista de valores de ENUM o SET.`);
  }
  const parts = list
    .split(",")
    .map((p) => p.trim().replace(/^'(.*)'$/, "$1"))
    .filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 64) {
    throw new Error(`«${column}» necesita entre 1 y 64 valores.`);
  }
  for (const part of parts) {
    if (part.length > 64 || /['"\\\u0000]/.test(part)) {
      throw new Error(`Valor no válido en «${column}»: ${part}.`);
    }
  }
  return parts.map((p) => quoteValue(p)).join(", ");
}

/** Tipo SQL con su longitud, validada. */
function buildType(type: string, column: DbTableSpecColumn): string {
  const length = (column.length ?? "").trim();
  if (type === "ENUM" || type === "SET") {
    return `${type}(${enumValues(length, column.name)})`;
  }
  if (!length) {
    return type;
  }
  if (!LENGTH_RE.test(length)) {
    throw new Error(`Longitud no válida para «${column.name}»: ${length}.`);
  }
  if (length.includes(",")) {
    if (!DECIMAL_TYPES.includes(type)) {
      throw new Error(`El tipo ${type} no admite decimales en la longitud.`);
    }
    return `${type}(${length})`;
  }
  if (!DECIMAL_TYPES.includes(type) && !INTEGER_TYPES.includes(type) && !STRING_TYPES.includes(type)) {
    throw new Error(`El tipo ${type} no admite longitud.`);
  }
  return `${type}(${length})`;
}

/**
 * Defecto que va sin comillas: es una expresion del servidor. Entre comillas MariaDB
 * la rechaza (`Invalid default value`), y CURRENT_TIMESTAMP es el defecto tipico de
 * DATETIME y TIMESTAMP.
 */
const DEFAULT_EXPRESSION = /^CURRENT_TIMESTAMP(\(\d{0,3}\))?$/i;

/** Definición SQL de una columna del spec. */
function buildColumn(column: DbTableSpecColumn): string {
  const partes = [ident(column.name), buildType(checkType(column), column)];
  if (!column.nullable) {
    partes.push("NOT NULL");
  }
  if (column.autoIncrement) {
    partes.push("AUTO_INCREMENT");
  }
  if (!column.autoIncrement && column.defaultValue !== null && column.defaultValue !== undefined) {
    const raw = String(column.defaultValue);
    const expr = DEFAULT_EXPRESSION.test(raw.trim()) ? raw.trim().toUpperCase() : "";
    partes.push(`DEFAULT ${expr || quoteValue(raw)}`);
  }
  const comment = (column.comment ?? "").trim();
  if (comment) {
    partes.push(`COMMENT ${quoteValue(comment)}`);
  }
  return partes.join(" ");
}

/** Valida el spec y ejecuta el `CREATE TABLE`. */
export async function createTable(s: DbSession, db: string, spec: DbTableSpec): Promise<void> {
  const tableName = (spec.name ?? "").trim();
  if (!tableName) {
    throw new Error("Falta el nombre de la tabla.");
  }
  const cols = spec.columns ?? [];
  if (cols.length === 0) {
    throw new Error("La tabla necesita al menos una columna.");
  }
  const vistos = new Set<string>();
  for (const c of cols) {
    const clave = texto(c.name).toLowerCase();
    if (!clave) {
      throw new Error("Falta el nombre de una columna.");
    }
    if (vistos.has(clave)) {
      throw new Error(`Columna duplicada: ${c.name}.`);
    }
    vistos.add(clave);
    const type = checkType(c);
    if (c.autoIncrement && (!INTEGER_TYPES.includes(type) || !c.primaryKey)) {
      throw new Error(`«${c.name}»: el auto_increment solo vale en enteros que son clave primaria.`);
    }
  }
  const defs = cols.map(buildColumn);
  const pk = cols.filter((c) => c.primaryKey).map((c) => ident(c.name));
  if (pk.length > 0) {
    defs.push(`PRIMARY KEY (${pk.join(", ")})`);
  }
  const sql =
    `CREATE TABLE ${qualified(db, tableName)} (${defs.join(", ")}) ` +
    "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
  await s.query(sql);
}

/** Borra una tabla o una vista. */
export async function dropTable(s: DbSession, db: string, table: string): Promise<void> {
  await s.query(`DROP TABLE ${qualified(db, table)}`);
}

/** Vacía una tabla sin borrarla. */
export async function truncateTable(s: DbSession, db: string, table: string): Promise<void> {
  await s.query(`TRUNCATE TABLE ${qualified(db, table)}`);
}

/** Renombra una tabla dentro de la misma base. */
export async function renameTable(s: DbSession, db: string, from: string, to: string): Promise<void> {
  await s.query(`RENAME TABLE ${qualified(db, from)} TO ${qualified(db, to)}`);
}

/** Número de filas de una tabla. */
export async function tableCount(s: DbSession, db: string, table: string): Promise<number> {
  const res = await s.query(`SELECT COUNT(*) FROM ${qualified(db, table)}`);
  return res.rows.length > 0 ? entero(res.rows[0][0]) : 0;
}

/**
 * Columnas que identifican una fila: la clave primaria o, si no hay, el primer índice
 * único con todas sus columnas NOT NULL. Devuelve [] si no hay identidad segura.
 */
export async function primaryKeyColumns(s: DbSession, db: string, table: string): Promise<string[]> {
  const cols = await listColumns(s, db, table);
  const pk = cols.filter((c) => c.key === "PRI").map((c) => c.name);
  if (pk.length > 0) {
    return pk;
  }
  const porNombre = new Map(cols.map((c) => [c.name.toLowerCase(), c]));
  const índices = await listIndexes(s, db, table);
  for (const idx of índices) {
    if (!idx.unique || idx.columns.length === 0) {
      continue;
    }
    const vale = idx.columns.every((name) => {
      const c = porNombre.get(name.toLowerCase());
      return !!c && !c.nullable;
    });
    if (vale) {
      return [...idx.columns];
    }
  }
  return [];
}
