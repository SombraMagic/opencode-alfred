/**
 * Conducción MariaDB: una única conexión principal por sesión y otra auxiliar perezosa
 * para poder cancelar (`KILL QUERY`) sin tumbar la principal. Sin `vscode`.
 */

import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import { createConnection } from "mysql2/promise";
import type {
  Connection as MariaConnection,
  ConnectionOptions,
  FieldPacket,
  ResultSetHeader,
} from "mysql2/promise";
import type { SshTunnel } from "./ssh";
import type { DbCell, DbProfile, DbQueryColumn, DbQueryResult } from "./types";

/** Opciones por consulta. */
export interface QueryOptions {
  /** Tope antes de cancelar. Defecto 30000 ms. */
  timeoutMs?: number;
  /** Tope de filas. En `query` el defecto es 5000; en `eachRow`, sin tope. */
  rowLimit?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ROW_LIMIT = 5000;
const CONNECT_TIMEOUT_MS = 10000;
const DB_PORT = 3306;

/**
 * La conexión de `mysql2/promise` es un envoltorio: el flujo por filas vive en la
 * conexión interna, que el propio driver expone como `connection`.
 */
type MariaNucleo = {
  query(sql: string, values: unknown[]): { stream(): Readable };
};

type MariaHeader = Partial<ResultSetHeader>;

/** Estado que comparten el temporizador y el bucle de lectura. */
type RunState = { aborted: boolean };

/** Resultado interno de una corrida con flujo. */
type RunOut = {
  columns: DbQueryColumn[];
  count: number;
  truncated: boolean;
  header?: MariaHeader;
};

/** Error del driver con prefijo legible. Nunca lleva la contraseña. */
function driverError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.message.startsWith("MariaDB: ") || err.message.startsWith("Tiempo de espera agotado")) {
    return err;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return new Error(`MariaDB: ${err.message}${code ? ` [${code}]` : ""}`);
}

/** Errores que dejan la conexión inservible: hay que reabrirla. */
function esFalloTerminal(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return (
    code === "PROTOCOL_CONNECTION_LOST" ||
    code === "PROTOCOL_SEQUENCE_TIMEOUT" ||
    code === "ER_SERVER_SHUTDOWN" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED"
  );
}

/** El driver entrega la cabecera como objeto suelto cuando la sentencia no tiene filas. */
function esCabecera(item: unknown): item is MariaHeader {
  return typeof item === "object" && item !== null && !Array.isArray(item) && "affectedRows" in item;
}

/**
 * Nombres de tipo según el código del protocolo MariaDB. El driver manda el número
 * (`FieldPacket.columnType`): `typeName` no existe en runtime, solo en su `inspect`.
 */
const TYPE_NAMES: Record<number, string> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  6: "NULL",
  7: "TIMESTAMP",
  8: "BIGINT",
  9: "MEDIUMINT",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  14: "DATE",
  15: "VARCHAR",
  16: "BIT",
  17: "TIMESTAMP",
  18: "DATETIME",
  19: "TIME",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "TINYBLOB",
  250: "MEDIUMBLOB",
  251: "LONGBLOB",
  252: "BLOB",
  253: "VARCHAR",
  254: "CHAR",
  255: "GEOMETRY",
};

/** Los tipos BLOB son TEXT cuando el juego de caracteres no es el binario. */
const BLOB_AS_TEXT: Record<number, string> = {
  249: "TINYTEXT",
  250: "MEDIUMTEXT",
  251: "LONGTEXT",
  252: "TEXT",
};

/** 63 es, en MariaDB, el juego de caracteres binario. */
const BINARY_CHARSET = 63;

/** Nombre legible del tipo de una columna del resultado. */
function columnTypeName(field: FieldPacket): string {
  const extended = field.extendedTypeName;
  if (typeof extended === "string" && extended.length > 0) {
    return extended.toUpperCase();
  }
  const code = typeof field.columnType === "number" ? field.columnType : field.type;
  if (typeof code !== "number") {
    return "";
  }
  if (field.characterSet !== undefined && field.characterSet !== BINARY_CHARSET) {
    const asText = BLOB_AS_TEXT[code];
    if (asText) {
      return asText;
    }
  }
  return TYPE_NAMES[code] ?? String(code);
}

/** Nombre exacto y tipo de columna desde los metadatos del driver. */
function columnsOf(fields: readonly FieldPacket[] | undefined): DbQueryColumn[] {
  if (!fields) {
    return [];
  }
  return fields.map((f) => ({ name: f.name, type: columnTypeName(f) }));
}

/** Celda apta para la webview: texto, nulo o binario en base64. */
function toCell(value: unknown): DbCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return { b64: value.toString("base64"), bytes: value.length };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return String(value);
  }
  // JSON y demás objetos del driver: viajan como texto.
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Config de conexión: la misma para la principal y para la auxiliar. */
function sessionConfig(
  profile: DbProfile,
  password: string | undefined,
  tunnel: SshTunnel | undefined
): ConnectionOptions {
  const cfg: ConnectionOptions = {
    host: tunnel ? "127.0.0.1" : profile.host || "127.0.0.1",
    port: tunnel ? tunnel.localPort : profile.port > 0 ? profile.port : DB_PORT,
    user: profile.user,
    connectTimeout: CONNECT_TIMEOUT_MS,
    charset: "utf8mb4",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    multipleStatements: false,
    rowsAsArray: true,
    namedPlaceholders: false,
  };
  if (password) {
    cfg.password = password;
  }
  if (profile.database) {
    cfg.database = profile.database;
  }
  // "off" no manda ssl; "require" acepta el certificado que sea; "verify" valida la cadena.
  if (profile.ssl === "require") {
    cfg.ssl = { rejectUnauthorized: false };
  } else if (profile.ssl === "verify") {
    cfg.ssl = {};
  }
  return cfg;
}

/** Sesión abierta contra un MariaDB. */
export class DbSession {
  readonly profileId: string;
  readonly database: string | undefined;

  private readonly profile: DbProfile;
  private readonly password: string | undefined;
  private readonly tunnel: SshTunnel | undefined;
  private conn: MariaConnection;
  /** Auxiliar perezosa, solo para cancelar. */
  private aux: Promise<MariaConnection> | undefined;
  /** La principal está caída: la próxima operación la reabre. */
  private broken = false;
  private closed = false;

  private constructor(
    profile: DbProfile,
    password: string | undefined,
    tunnel: SshTunnel | undefined,
    conn: MariaConnection
  ) {
    this.profileId = profile.id;
    this.database = profile.database || undefined;
    this.profile = profile;
    this.password = password;
    this.tunnel = tunnel;
    this.conn = conn;
  }

  /** Id del hilo en el servidor: el que hay que matar para cancelar. */
  get threadId(): number {
    return this.conn.threadId;
  }

  /** Abre la sesión contra el servidor. */
  static async open(
    profile: DbProfile,
    password: string | undefined,
    tunnel?: SshTunnel
  ): Promise<DbSession> {
    let conn: MariaConnection;
    try {
      conn = await createConnection(sessionConfig(profile, password, tunnel));
    } catch (e) {
      throw driverError(e);
    }
    const session = new DbSession(profile, password, tunnel, conn);
    session.watch(conn);
    return session;
  }

  /** Pone escucha de errores a una conexión: sin ella, Node lanza los del socket. */
  private watch(conn: MariaConnection): void {
    conn.on("error", () => {
      // El error de red llega además como rechazo de la consulta en vuelo.
      this.broken = true;
    });
  }

  /** Conexión viva: reabre la principal si estaba caída. */
  private async live(): Promise<MariaConnection> {
    if (this.closed) {
      throw new Error("La sesión de base de datos está cerrada.");
    }
    if (!this.broken) {
      return this.conn;
    }
    try {
      this.conn = await createConnection(sessionConfig(this.profile, this.password, this.tunnel));
      this.watch(this.conn);
      this.broken = false;
      return this.conn;
    } catch (e) {
      throw driverError(e);
    }
  }

  /** Ejecuta la sentencia y acumula como máximo `rowLimit` filas. */
  async query(sql: string, params: unknown[] = [], opts?: QueryOptions): Promise<DbQueryResult> {
    const rows: DbCell[][] = [];
    const started = performance.now();
    const run = await this.guarded(
      sql,
      params,
      (row) => {
        rows.push(row);
      },
      opts?.rowLimit ?? DEFAULT_ROW_LIMIT,
      opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const header = run.header;
    const insertId =
      header && header.insertId !== undefined && Number(header.insertId) > 0 ? String(header.insertId) : undefined;
    return {
      columns: run.columns,
      rows,
      affected: header ? Number(header.affectedRows ?? 0) : 0,
      insertId,
      warnings: header ? Number(header.warningStatus ?? 0) : 0,
      ms: Math.max(0, Math.round(performance.now() - started)),
      truncated: run.truncated,
    };
  }

  /** Recorre las filas sin materializarlas todas. */
  async eachRow(
    sql: string,
    params: unknown[],
    onRow: (row: DbCell[]) => void | Promise<void>,
    opts?: QueryOptions
  ): Promise<{ columns: DbQueryColumn[]; count: number; truncated: boolean }> {
    const run = await this.guarded(sql, params, onRow, opts?.rowLimit ?? 0, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { columns: run.columns, count: run.count, truncated: run.truncated };
  }

  /** Bucle común de `query` y `eachRow`, con tope de tiempo y cancelación. */
  private async guarded(
    sql: string,
    params: unknown[],
    onRow: (row: DbCell[]) => void | Promise<void>,
    rowLimit: number,
    timeoutMs: number
  ): Promise<RunOut> {
    const conn = await this.live();
    const state: RunState = { aborted: false };
    const work = this.streamInto(conn, sql, params, onRow, rowLimit, state);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<RunOut>((resolve, reject) => {
        let done = false;
        timer = setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          state.aborted = true;
          reject(new Error(`Tiempo de espera agotado (${timeoutMs} ms)`));
          void this.cancel();
        }, timeoutMs);
        work.then(
          (res) => {
            if (!done) {
              done = true;
              resolve(res);
            }
          },
          (e: unknown) => {
            if (done) {
              return;
            }
            done = true;
            if (esFalloTerminal(e)) {
              this.broken = true;
            }
            reject(driverError(e));
          }
        );
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      // Si venció el plazo, lo que llegue después se descarta en silencio.
      work.catch(() => undefined);
    }
  }

  /** Lee el flujo de resultados del driver fila a fila. */
  private async streamInto(
    conn: MariaConnection,
    sql: string,
    params: unknown[],
    onRow: (row: DbCell[]) => void | Promise<void>,
    rowLimit: number,
    state: RunState
  ): Promise<RunOut> {
    const core = (conn as unknown as { connection?: MariaNucleo }).connection;
    if (!core || typeof core.query !== "function") {
      throw new Error("MariaDB: el driver no expone el flujo por filas.");
    }
    const out: RunOut = { columns: [], count: 0, truncated: false };
    const stream = core.query(sql, params).stream();
    stream.on("fields", (fields: readonly FieldPacket[] | undefined) => {
      out.columns = columnsOf(fields);
    });
    try {
      for await (const item of stream) {
        if (state.aborted) {
          break;
        }
        if (esCabecera(item)) {
          out.header = item;
          continue;
        }
        if (rowLimit > 0 && out.count >= rowLimit) {
          // Se siguen descartando filas: dejar de leer dejaría la conexión descentrada.
          out.truncated = true;
          continue;
        }
        out.count++;
        await onRow(Array.isArray(item) ? (item as unknown[]).map(toCell) : [toCell(item)]);
      }
    } catch (e) {
      if (state.aborted) {
        return out;
      }
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
    return out;
  }

  /** Cancela lo que esté en vuelo por la auxiliar. Si no puede, tumba la principal. */
  async cancel(): Promise<void> {
    const id = this.conn ? this.conn.threadId : 0;
    if (!id) {
      this.destroyMain();
      return;
    }
    try {
      if (!this.aux) {
        const pending = createConnection(sessionConfig(this.profile, this.password, this.tunnel));
        this.aux = pending;
        // Sin escucha de error, un corte del socket en la auxiliar lanzaría sin dueño.
        pending.then(
          (conn) => {
            conn.on("error", () => {
              this.aux = undefined;
              try {
                conn.destroy();
              } catch {
                // ya estaba caída
              }
            });
          },
          () => undefined
        );
      }
      const conn = await this.aux;
      await conn.query(`KILL QUERY ${Number(id)}`);
    } catch {
      // Sin auxiliar posible, la única salida es tirar de la principal.
      this.aux = undefined;
      this.destroyMain();
    }
  }

  /** Comprueba la conexión, reabriéndola si estaba caída. */
  async ping(): Promise<void> {
    try {
      const conn = await this.live();
      await conn.ping();
    } catch (e) {
      this.broken = true;
      throw driverError(e);
    }
  }

  /** Tumba la principal sin lanzar: la próxima operación la reabre. */
  private destroyMain(): void {
    this.broken = true;
    try {
      this.conn.destroy();
    } catch {
      // ya estaba caída
    }
  }

  /** Cierra principal y auxiliar. Nunca lanza. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const principal = this.conn;
    // Despedida limpia: sin COM_QUIT el servidor apunta la conexión como abortada.
    // Con una consulta en vuelo `end()` espera, así que se le da una gracia corta.
    await this.gracefulEnd(principal);
    const aux = this.aux;
    this.aux = undefined;
    if (aux) {
      try {
        const conn = await aux;
        await conn.end();
      } catch {
        // nada que cerrar
      }
    }
  }

  /** `end()` con plazo: si no termina en 2 s, se rompe el socket. */
  private async gracefulEnd(conn: MariaConnection): Promise<void> {
    if (this.broken) {
      this.destroyMain();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        conn.end(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("fin lento")), 2000);
        }),
      ]);
    } catch {
      // sin conexión que terminar, o seguía ocupada: se rompe
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    try {
      conn.destroy();
    } catch {
      // ya estaba caída
    }
  }
}
