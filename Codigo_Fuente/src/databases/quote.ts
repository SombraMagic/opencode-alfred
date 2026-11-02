/**
 * Utilidades SQL puras para MariaDB: entrecomillado de identificadores, escape de
 * patrones LIKE, división de un guion en sentencias y detección de sentencias de solo
 * lectura. Sin `vscode` ni dependencias externas.
 */

import type { DbCell } from "./types";

/** Longitud máxima de un identificador en MariaDB. */
const ID_MAX = 64;

/** Palabras con las que empieza una sentencia que no escribe. */
const READ_ONLY_STARTS = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"];

/** Escrituras que pueden esconderse dentro de un CTE o tras `EXPLAIN`/`DESCRIBE`. */
const WRITE_WORDS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|RENAME|LOCK|UNLOCK)\b/i;

/** `SELECT ... INTO OUTFILE|DUMPFILE` escribe en disco aunque empiece por SELECT. */
const INTO_FILE = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/** Pieza del texto SQL según el tokenizador. */
type PieceKind = "code" | "string" | "quotedId" | "comment";

/**
 * Identificador entre backticks. Duplica los backticks internos.
 * Rechaza nombres vacíos, con NUL o de más de 64 caracteres.
 */
export function ident(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("\u0000") || name.length > ID_MAX) {
    throw new Error("Identificador no válido");
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

/** `base de datos`.`tabla`, con los dos lados validados. */
export function qualified(db: string, table: string): string {
  return `${ident(db)}.${ident(table)}`;
}

/** Escapa `\`, `%` y `_` para usar el término en `LIKE ... ESCAPE '\\'`. */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Literal SQL seguro para el volcador. `null` devuelve `NULL`. */
export function quoteValue(value: string | null): string {
  if (value === null) {
    return "NULL";
  }
  let out = "'";
  for (const ch of value) {
    switch (ch) {
      case "\u0000":
        out += "\\0";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\\":
        out += "\\\\";
        break;
      case "'":
        out += "\\'";
        break;
      case '"':
        out += '\\"';
        break;
      case "\u001a":
        out += "\\Z";
        break;
      default:
        out += ch;
    }
  }
  return out + "'";
}

/**
 * Literal SQL para una celda del explorador: `NULL`, texto entre comillas o binario en
 * notación hexadecimal (`X'...'`), que MariaDB acepta en cualquier columna binaria.
 * Lo comparten el exportador SQL y el volcador JS para no duplicar el escape.
 */
export function quoteCell(cell: DbCell): string {
  if (cell === null) {
    return "NULL";
  }
  if (typeof cell === "string") {
    return quoteValue(cell);
  }
  return `X'${Buffer.from(cell.b64, "base64").toString("hex")}'`;
}

/**
 * Fin del segmento delimitado que empieza en `start` (`'`, `"` o backtick).
 * Devuelve el índice tras el delimitador de cierre, o el final si queda abierto.
 * Entiende el delimitador duplicado y la barra de escape.
 */
function endOfDelimited(sql: string, start: number): number {
  const quote = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** Fin del comentario que empieza en `start` (`--`, `#` o de bloque). */
function endOfComment(sql: string, start: number): number {
  if (sql[start] === "/" && sql[start + 1] === "*") {
    const close = sql.indexOf("*/", start + 2);
    return close < 0 ? sql.length : close + 2;
  }
  const nl = sql.indexOf("\n", start);
  return nl < 0 ? sql.length : nl;
}

/** `--` solo abre comentario si va seguido de espacio o de fin de línea (regla de MariaDB). */
function isDashComment(sql: string, i: number): boolean {
  if (sql[i] !== "-" || sql[i + 1] !== "-") {
    return false;
  }
  const next = sql[i + 2];
  return next === undefined || next === " " || next === "\t" || next === "\r" || next === "\n";
}

/** Dónde acaba el constructo especial que empieza en `i`, y de qué clase es. */
function specialAt(sql: string, i: number): { end: number; kind: PieceKind } | undefined {
  const ch = sql[i];
  if (ch === "'" || ch === '"') {
    return { end: endOfDelimited(sql, i), kind: "string" };
  }
  if (ch === "`") {
    return { end: endOfDelimited(sql, i), kind: "quotedId" };
  }
  if (isDashComment(sql, i) || ch === "#" || (ch === "/" && sql[i + 1] === "*")) {
    return { end: endOfComment(sql, i), kind: "comment" };
  }
  return undefined;
}

/**
 * Recorre `sql` entregando piezas: código, cadenas, identificadores entre backticks y
 * comentarios. El resto del fichero se apoya aquí para no duplicar el tokenizador.
 */
function scanSql(sql: string, onPiece: (text: string, kind: PieceKind) => void): void {
  let i = 0;
  while (i < sql.length) {
    const special = specialAt(sql, i);
    if (special) {
      onPiece(sql.slice(i, special.end), special.kind);
      i = special.end;
      continue;
    }
    let j = i;
    while (j < sql.length && !specialAt(sql, j)) {
      j++;
    }
    onPiece(sql.slice(i, j), "code");
    i = j;
  }
}

/**
 * Divide un guion en sentencias por `;`, respetando cadenas, identificadores entre
 * backticks y comentarios. No interpreta `DELIMITER`. Devuelve las sentencias recortadas
 * y descarta las vacías.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  const push = () => {
    const stmt = buf.trim();
    if (stmt.length > 0) {
      out.push(stmt);
    }
    buf = "";
  };
  scanSql(sql, (text, kind) => {
    if (kind !== "code") {
      buf += text;
      return;
    }
    const parts = text.split(";");
    buf += parts[0];
    for (let k = 1; k < parts.length; k++) {
      push();
      buf += parts[k];
    }
  });
  push();
  return out;
}

/** Cadena y comentarios se convierten en espacios: quedan las palabras sueltas reales. */
function maskLiteralsAndComments(sql: string): string {
  let out = "";
  scanSql(sql, (text, kind) => {
    out += kind === "string" || kind === "comment" ? " ".repeat(text.length) : text;
  });
  return out;
}

/**
 * `true` solo si la sentencia empieza (tras espacios y comentarios) por SELECT, SHOW,
 * DESCRIBE, DESC, EXPLAIN o WITH. No vale un CTE que esconda escrituras, ni un
 * `EXPLAIN`/`DESCRIBE` sobre ellas, ni un `SELECT ... INTO OUTFILE|DUMPFILE`.
 */
export function isReadOnlyStatement(stmt: string): boolean {
  const masked = maskLiteralsAndComments(stmt);
  const head = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked);
  if (!head) {
    return false;
  }
  const first = head[1].toUpperCase();
  if (!READ_ONLY_STARTS.includes(first)) {
    return false;
  }
  if (INTO_FILE.test(masked)) {
    return false;
  }
  if (first === "WITH" || first === "EXPLAIN" || first === "DESCRIBE" || first === "DESC") {
    const rest = masked.slice(head.index + head[1].length);
    if (WRITE_WORDS.test(rest)) {
      return false;
    }
  }
  return true;
}
