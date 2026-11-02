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
  DbStructureColumn,
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
  "BINARY",
  "VARBINARY",
  "BIT",
  "ENUM",
  "SET",
  "UUID",
  "INET4",
  "INET6",
  "GEOMETRY",
  "POINT",
  "LINESTRING",
  "POLYGON",
  "MULTIPOINT",
  "MULTILINESTRING",
  "MULTIPOLYGON",
  "GEOMETRYCOLLECTION",
];

/** Únicos tipos que admiten `auto_increment`. */
const INTEGER_TYPES = ["INT", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT"];

/** Tipos cuya longitud lleva decimales (`10,2`). */
const DECIMAL_TYPES = ["DECIMAL", "FLOAT", "DOUBLE"];

/** Tipos de cadena: longitud de un solo número. */
const STRING_TYPES = ["VARCHAR", "CHAR", "BINARY", "VARBINARY"];

/** Tipos numéricos: únicos que admiten `UNSIGNED` y `ZEROFILL`. */
const NUMERIC_TYPES = [...INTEGER_TYPES, ...DECIMAL_TYPES];

/** Únicos tipos que admiten `ON UPDATE CURRENT_TIMESTAMP`. */
const ON_UPDATE_TYPES = ["DATETIME", "TIMESTAMP"];

/** Tipos que admiten precisión de fracciones de segundo (0..6). */
const FRACTIONAL_SECONDS_TYPES = ["TIME", "DATETIME", "TIMESTAMP"];

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
 * valor pelado: el editor lo muestra tal cual y, al crear la tabla, `buildColumnDefinition`
 * lo vuelve a entrecomillar. Sin esto, el viaje ida y vuelta duplica las comillas.
 */
function defecto(value: unknown): string | null {
  const raw = nuloOTexto(value);
  if (raw === null) {
    return null;
  }
  // MariaDB devuelve la cadena `NULL` (sin comillas) para las columnas TIMESTAMP y
  // YEAR sin defecto explícito; un defecto de cadena llega entrecomillado (`'NULL'`).
  if (/^null$/i.test(raw)) {
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

/**
 * Trozos de la lista de ENUM/SET separados por comas fuera de comillas simples. Dentro
 * de un valor entrecomillado la coma no separa y `''` es una comilla. Los valores
 * sueltos se recortan y los vacíos se descartan; los entrecomillados conservan sus
 * espacios y se quedan aunque estén vacíos (`enum('','a')` mantiene el `''`).
 */
function enumParts(raw: string, column: string): string[] {
  const parts: string[] = [];
  const citados: boolean[] = [];
  let actual = "";
  let citado = false;
  let entreComillas = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (entreComillas) {
      if (ch === "'") {
        if (raw[i + 1] === "'") {
          actual += "'";
          i++;
        } else {
          entreComillas = false;
        }
      } else {
        actual += ch;
      }
      continue;
    }
    if (ch === "'") {
      entreComillas = true;
      citado = true;
    } else if (ch === ",") {
      parts.push(citado ? actual : actual.trim());
      citados.push(citado);
      actual = "";
      citado = false;
    } else {
      actual += ch;
    }
  }
  if (entreComillas) {
    throw new Error(`Valor no válido en «${column}»: ${raw.trim()}.`);
  }
  parts.push(citado ? actual : actual.trim());
  citados.push(citado);
  return parts.filter((p, i) => citados[i] || p.length > 0);
}

/** Lista de valores de ENUM y SET: entre comillas o sueltos. */
function enumValues(raw: string, column: string): string {
  const list = raw.trim();
  if (!list) {
    throw new Error(`«${column}» necesita la lista de valores de ENUM o SET.`);
  }
  const parts = enumParts(list, column);
  if (parts.length === 0 || parts.length > 64) {
    throw new Error(`«${column}» necesita entre 1 y 64 valores.`);
  }
  for (const part of parts) {
    if (part.length > 64 || part.includes("\u0000")) {
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
  if (type === "YEAR") {
    // MariaDB informa siempre `year(4)`; solo 2 y 4 son válidos.
    if (length !== "2" && length !== "4") {
      throw new Error(`Longitud no válida para «${column.name}»: ${length}.`);
    }
    return `YEAR(${length})`;
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
  if (FRACTIONAL_SECONDS_TYPES.includes(type)) {
    if (!/^[0-6]$/.test(length)) {
      throw new Error(`Longitud no válida para «${column.name}»: ${length}.`);
    }
    return `${type}(${length})`;
  }
  if (!DECIMAL_TYPES.includes(type) && !INTEGER_TYPES.includes(type) && !STRING_TYPES.includes(type) && type !== "BIT") {
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
export function buildColumnDefinition(column: DbTableSpecColumn): string {
  const type = checkType(column);
  if ((column.unsigned || column.zerofill) && !NUMERIC_TYPES.includes(type)) {
    throw new Error(`El tipo ${type} no admite UNSIGNED ni ZEROFILL.`);
  }
  if (column.onUpdate && !ON_UPDATE_TYPES.includes(type)) {
    throw new Error(`El tipo ${type} no admite ON UPDATE.`);
  }
  if (column.onUpdate && column.autoIncrement) {
    throw new Error(`«${column.name}» no puede ser auto_increment y llevar ON UPDATE.`);
  }
  const partes = [ident(column.name), buildType(type, column)];
  if (column.unsigned) {
    partes.push("UNSIGNED");
  }
  if (column.zerofill) {
    partes.push("ZEROFILL");
  }
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
  if (column.onUpdate) {
    partes.push("ON UPDATE CURRENT_TIMESTAMP");
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
  const defs = cols.map(buildColumnDefinition);
  const pk = cols.filter((c) => c.primaryKey).map((c) => ident(c.name));
  if (pk.length > 0) {
    defs.push(`PRIMARY KEY (${pk.join(", ")})`);
  }
  const sql =
    `CREATE TABLE ${qualified(db, tableName)} (${defs.join(", ")}) ` +
    "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
  await s.query(sql);
}

function mensajeDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Contenido del primer paréntesis del tipo, respetando las comillas simples: en
 * `enum('a,b','c')` la coma no cierra nada y un `)` dentro de un valor tampoco.
 */
function parenContent(columnType: string): string | undefined {
  const inicio = columnType.indexOf("(");
  if (inicio < 0) {
    return undefined;
  }
  let entreComillas = false;
  for (let i = inicio + 1; i < columnType.length; i++) {
    const ch = columnType[i];
    if (ch === "'") {
      if (entreComillas && columnType[i + 1] === "'") {
        i++;
      } else {
        entreComillas = !entreComillas;
      }
    } else if (ch === ")" && !entreComillas) {
      return columnType.slice(inicio + 1, i).trim();
    }
  }
  return undefined;
}

/**
 * Especificación deducida de una columna existente. `information_schema` da el tipo
 * completo en `columnType` (`int(11) unsigned`), así que de ahí salen la longitud y
 * los modificadores. No es un viaje perfecto (algún tipo del servidor no está en la
 * allowlist), pero basta para decidir si una columna cambió.
 */
function specFromColumn(c: DbColumn): DbTableSpecColumn {
  return {
    name: c.name,
    type: c.dataType.toUpperCase().replace(/\s+/g, ""),
    length: parenContent(c.columnType),
    nullable: c.nullable,
    defaultValue: c.defaultValue,
    autoIncrement: /auto_increment/i.test(c.extra),
    primaryKey: c.key === "PRI",
    comment: c.comment || undefined,
    unsigned: /unsigned/i.test(c.columnType),
    zerofill: /zerofill/i.test(c.columnType),
    onUpdate: /on update current_timestamp/i.test(c.extra),
  };
}

/**
 * Huella de una columna para saber si cambió. La anchura de los enteros no cuenta:
 * en MariaDB es solo ancho de presentación (`int(11)` es `int`). El nombre va dentro,
 * así que renombrar también es un cambio.
 */
function columnSignature(c: DbTableSpecColumn): string {
  const type = texto(c.type).toUpperCase().replace(/\s+/g, "");
  const length = INTEGER_TYPES.includes(type) ? "" : texto(c.length).trim();
  return JSON.stringify([
    texto(c.name).toLowerCase(),
    type,
    length,
    Boolean(c.nullable),
    c.defaultValue ?? null,
    Boolean(c.autoIncrement),
    texto(c.comment).trim(),
    Boolean(c.unsigned),
    Boolean(c.zerofill),
    Boolean(c.onUpdate),
  ]);
}

/** Misma colección de nombres, sin importar el orden ni la caja. */
function mismoConjunto(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sa = a.map((n) => n.toLowerCase()).sort();
  const sb = b.map((n) => n.toLowerCase()).sort();
  return sa.every((n, i) => n === sb[i]);
}

/**
 * Rehace la estructura de una tabla en un solo `ALTER TABLE`: borra las columnas que
 * faltan, cambia las que vienen con otro nombre o definición, añade las nuevas y
 * rehace la clave primaria si cambia. No mueve columnas existentes de sitio y no
 * toca las generadas salvo que se intenten modificar, que es un error.
 */
export async function alterTable(
  s: DbSession,
  db: string,
  table: string,
  columns: DbStructureColumn[]
): Promise<void> {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("La tabla necesita al menos una columna.");
  }
  const actuales = await listColumns(s, db, table);
  const indices = await listIndexes(s, db, table);
  const tienePk = indices.some((i) => i.name.toUpperCase() === "PRIMARY");
  const pkActual = tienePk ? (indices.find((i) => i.name.toUpperCase() === "PRIMARY")?.columns ?? []) : [];
  const porNombre = new Map(actuales.map((c) => [c.name.toLowerCase(), c]));

  const deseadas: { actual: DbColumn | null; column: DbTableSpecColumn; cambia: boolean }[] = [];
  const nombres = new Set<string>();
  const origenes = new Set<string>();
  for (const entrada of columns) {
    const column = entrada?.column;
    if (!column || typeof column !== "object") {
      throw new Error("Falta la definición de una columna.");
    }
    const nombre = texto(column.name).trim();
    if (!nombre) {
      throw new Error("Falta el nombre de una columna.");
    }
    const clave = nombre.toLowerCase();
    if (nombres.has(clave)) {
      throw new Error(`Columna duplicada: ${nombre}.`);
    }
    nombres.add(clave);

    const original =
      entrada.originalName === null || entrada.originalName === undefined ? null : texto(entrada.originalName).trim();
    if (!original) {
      deseadas.push({ actual: null, column, cambia: true });
      continue;
    }
    const actual = porNombre.get(original.toLowerCase());
    if (!actual) {
      throw new Error(`La columna «${original}» no existe.`);
    }
    if (origenes.has(original.toLowerCase())) {
      throw new Error(`Columna repetida: ${original}.`);
    }
    origenes.add(original.toLowerCase());
    deseadas.push({
      actual,
      column,
      cambia: columnSignature(specFromColumn(actual)) !== columnSignature(column),
    });
  }

  if (deseadas.filter((d) => d.column.autoIncrement).length > 1) {
    throw new Error("Solo una columna puede ser auto_increment.");
  }
  for (const d of deseadas) {
    if (!d.cambia) {
      continue;
    }
    const nombre = texto(d.column.name).trim();
    const type = checkType(d.column);
    if (d.column.autoIncrement && (!INTEGER_TYPES.includes(type) || !d.column.primaryKey)) {
      throw new Error(`«${nombre}»: el auto_increment solo vale en enteros que son clave primaria.`);
    }
  }

  const pkDeseada = deseadas.filter((d) => d.column.primaryKey).map((d) => texto(d.column.name).trim());
  const mismaPk = mismoConjunto(pkActual, pkDeseada);
  const actualesPk = new Set(pkActual.map((n) => n.toLowerCase()));
  const deseadasPk = new Set(pkDeseada.map((n) => n.toLowerCase()));
  const pkOrden = [
    ...pkActual.filter((n) => deseadasPk.has(n.toLowerCase())),
    ...pkDeseada.filter((n) => !actualesPk.has(n.toLowerCase())),
  ];

  const clausulas: string[] = [];
  if (!mismaPk && pkActual.length > 0) {
    clausulas.push("DROP PRIMARY KEY");
  }
  for (const actual of actuales) {
    if (!origenes.has(actual.name.toLowerCase())) {
      clausulas.push(`DROP COLUMN ${ident(actual.name)}`);
    }
  }
  for (const d of deseadas) {
    if (!d.actual) {
      continue;
    }
    if (/GENERATED/i.test(d.actual.extra)) {
      if (d.cambia) {
        throw new Error(`No se puede modificar la columna generada «${d.actual.name}».`);
      }
      continue;
    }
    if (d.cambia) {
      clausulas.push(`CHANGE COLUMN ${ident(d.actual.name)} ${buildColumnDefinition(d.column)}`);
    }
  }
  for (const d of deseadas) {
    if (!d.actual) {
      clausulas.push(`ADD COLUMN ${buildColumnDefinition(d.column)}`);
    }
  }
  if (!mismaPk && pkDeseada.length > 0) {
    clausulas.push(`ADD PRIMARY KEY (${pkOrden.map(ident).join(", ")})`);
  }
  if (clausulas.length === 0) {
    return;
  }
  try {
    await s.query(`ALTER TABLE ${qualified(db, table)} ${clausulas.join(", ")}`);
  } catch (e) {
    throw new Error(`No se pudo cambiar la estructura: ${mensajeDe(e)}`);
  }
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
