/**
 * Modelo de las bases de datos MariaDB de Alfred: perfiles (con túnel SSH),
 * metadatos de esquema, resultados de consultas y especificacion de tablas.
 * Sin `vscode`: lo consumen el panel, `extension.ts` y el MCP.
 */

/** Túnel SSH por el que pasa la conexion. */
export interface DbProfileTunnel {
  enabled: boolean;
  host: string;
  /** Defecto 22. */
  port: number;
  user: string;
  auth: "password" | "key" | "agent";
  /** Ruta del fichero de clave privada. Solo con auth "key". */
  keyPath?: string;
}

/** Perfil de conexion. Las contrasenas NO viven aquí: van al almacen de secretos. */
export interface DbProfile {
  /** `crypto.randomUUID()` */
  id: string;
  name: string;
  /** Defecto 127.0.0.1. */
  host: string;
  /** Defecto 3306. */
  port: number;
  user: string;
  database?: string;
  /** Defecto "off". */
  ssl: "off" | "require" | "verify";
  tunnel: DbProfileTunnel;
}

/** Perfil apto para el webview: sin secretos, solo si los hay. */
export interface DbProfileView extends DbProfile {
  hasPassword: boolean;
  hasSshPassword: boolean;
  hasSshPassphrase: boolean;
}

/** Fila de `information_schema.TABLES`. */
export interface DbTableInfo {
  name: string;
  engine: string;
  /** De `information_schema`: puede ser 0 o estar estimado en InnoDB. */
  rows: number;
  bytes: number;
  comment: string;
  isView: boolean;
}

/** Columna de `information_schema.COLUMNS`. */
export interface DbColumn {
  name: string;
  /** Tipo base, p. ej. "varchar". */
  dataType: string;
  /** Tipo completo, p. ej. "varchar(120)". */
  columnType: string;
  nullable: boolean;
  defaultValue: string | null;
  key: "" | "PRI" | "UNI" | "MUL";
  /** "auto_increment", "DEFAULT_GENERATED", ... */
  extra: string;
  comment: string;
}

export interface DbIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface DbForeignKey {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
  onUpdate: string;
}

/** Valor de celda: texto, nulo o binario en base64. */
export type DbCell = string | null | { b64: string; bytes: number };

export interface DbQueryColumn {
  name: string;
  type: string;
}

export interface DbQueryResult {
  columns: DbQueryColumn[];
  rows: DbCell[][];
  affected: number;
  insertId?: string;
  warnings: number;
  ms: number;
  /** Se alcanzo el tope de filas: quedan mas en el servidor. */
  truncated: boolean;
}

/** Columna declarada al crear una tabla. */
export interface DbTableSpecColumn {
  name: string;
  /** "INT", "VARCHAR", "TEXT", "DATETIME", ... */
  type: string;
  /** "120" o "10,2" para tamano/decimales; en ENUM y SET son los valores entre comillas. */
  length?: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  primaryKey: boolean;
  comment?: string;
  /** `UNSIGNED`, solo en tipos numéricos. */
  unsigned?: boolean;
  /** `ZEROFILL`, solo en tipos numéricos. */
  zerofill?: boolean;
  /** `ON UPDATE CURRENT_TIMESTAMP`, solo en DATETIME y TIMESTAMP. */
  onUpdate?: boolean;
}

/** Columna del editor de estructura: `originalName` null cuando es nueva. */
export interface DbStructureColumn {
  originalName: string | null;
  column: DbTableSpecColumn;
}

export interface DbTableSpec {
  name: string;
  columns: DbTableSpecColumn[];
}
