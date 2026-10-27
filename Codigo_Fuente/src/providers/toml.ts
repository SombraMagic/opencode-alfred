/**
 * Editor quirúrgico de `config.toml` de Codex: localiza tablas por ruta, lee una
 * clave y sustituye/inserta/quita esa clave sin reescribir el resto del fichero.
 * No es un parser TOML: solo entiende cabeceras, claves de primer nivel y valores
 * de una sola línea.
 */

export type TomlValue = string | boolean | number;

/** Ruta del fichero, ya en forma de segmentos: ["mcp_servers", "node_repl"]. */
export type TomlPath = string[];

interface Line {
  text: string;
  /** "\n", "\r\n", "\r" o "" si es la última línea sin salto. */
  eol: string;
}

interface Header {
  path: TomlPath;
}

interface KeyLine {
  key: string;
  /** Todo lo que va tras el `=`: valor y comentario final incluidos. */
  rest: string;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const KEY_LINE = /^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']*)'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/;

/* ------------------------------- utilidades ------------------------------- */

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== "\n" && text[j] !== "\r") {
      j++;
    }
    const eol = text.startsWith("\r\n", j) ? "\r\n" : j < text.length ? text[j] : "";
    lines.push({ text: text.slice(i, j), eol });
    i = j + eol.length;
  }
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

function defaultEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Quita un comentario final que quede fuera de comillas. */
function stripComment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Cabecera de tabla, con `[[...]]` incluida para cerrar el bloque. */
function parseHeader(raw: string): Header | undefined {
  const text = raw.trim();
  if (!text.startsWith("[")) {
    return undefined;
  }
  const array = text.startsWith("[[");
  let i = array ? 2 : 1;
  const path: TomlPath = [];
  let segment = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        // Los escapes de las comillas dobles se guardan tal cual: no hace falta
        // deshacerlos para comparar rutas.
        if (quote === '"' && text[i] === "\\" && i + 1 < text.length) {
          segment += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        segment += text[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === "]") {
      if (array && text[i + 1] !== "]") {
        return undefined;
      }
      i += array ? 2 : 1;
      const tail = text.slice(i).trim();
      if (tail && !tail.startsWith("#")) {
        return undefined;
      }
      if (segment) {
        path.push(segment);
      }
      return path.length > 0 ? { path } : undefined;
    }
    if (ch === ".") {
      path.push(segment);
      segment = "";
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    segment += ch;
    i++;
  }
  return undefined;
}

function parseKeyLine(raw: string): KeyLine | undefined {
  const match = KEY_LINE.exec(raw);
  if (!match) {
    return undefined;
  }
  return { key: unquote(match[2]), rest: match[3] };
}

function unquote(raw: string): string {
  const quote = raw[0];
  if (raw.length < 2 || (quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return raw;
  }
  const inner = raw.slice(1, -1);
  if (quote === "'") {
    return inner;
  }
  // Solo los escapes que produce `stringLiteral`, para que leer y escribir casen.
  return inner.replace(/\\(["\\])/g, "$1");
}

function stringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function serializeValue(value: TomlValue): string {
  if (typeof value === "string") {
    return stringLiteral(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

function formatHeader(path: TomlPath): string {
  const segments = path.map((segment) => (BARE_KEY.test(segment) ? segment : stringLiteral(segment)));
  return `[${segments.join(".")}]`;
}

/** Índice de la primera cabecera: donde acaba el preamble. */
function preambleEnd(lines: Line[]): number {
  const at = lines.findIndex((line) => parseHeader(line.text) !== undefined);
  return at < 0 ? lines.length : at;
}

/** Punto de inserción en el preamble: tras su última línea con contenido. */
function preambleInsertAt(lines: Line[], end: number): number {
  let at = end;
  while (at > 0 && !lines[at - 1].text.trim()) {
    at--;
  }
  return at;
}

/* --------------------------------- lectura -------------------------------- */

/**
 * Línea de cabecera de tabla (0-based) y su rango [start, end) de líneas del bloque.
 * Con `path = []` devuelve el preamble `{ start: 0, end: primera cabecera }`, aunque
 * esté vacío (`end: 0`); `undefined` solo si el texto no tiene líneas.
 */
export function findTable(text: string, path: TomlPath): { start: number; end: number } | undefined {
  const lines = splitLines(text);
  if (path.length === 0) {
    return lines.length > 0 ? { start: 0, end: preambleEnd(lines) } : undefined;
  }
  const headers = lines.map((line) => parseHeader(line.text));
  for (let start = 0; start < lines.length; start++) {
    const header = headers[start];
    if (!header || !samePath(header.path, path)) {
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !headers[end]) {
      end++;
    }
    return { start, end };
  }
  return undefined;
}

/** Nombres de las tablas hijas directas: listTables(text, ["mcp_servers"]) → ["node_repl"]. */
export function listTables(text: string, prefix: TomlPath): string[] {
  const names: string[] = [];
  for (const line of splitLines(text)) {
    const header = parseHeader(line.text);
    if (!header) {
      continue;
    }
    // Con `prefix` vacío basta con el primer segmento, aunque la tabla solo exista
    // anidada (`[plugins."x"]`); con prefijo, solo las hijas directas.
    if (prefix.length > 0 && header.path.length !== prefix.length + 1) {
      continue;
    }
    if (header.path.length <= prefix.length || !samePath(header.path.slice(0, prefix.length), prefix)) {
      continue;
    }
    const name = header.path[prefix.length];
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** Valor tal cual (sin comillas, sin comentario) de una clave de esa tabla. */
export function getValue(text: string, path: TomlPath, key: string): string | undefined {
  const table = findTable(text, path);
  if (!table) {
    return undefined;
  }
  const lines = splitLines(text);
  const first = path.length === 0 ? 0 : table.start + 1;
  for (let i = first; i < table.end; i++) {
    const line = parseKeyLine(lines[i].text);
    if (line && line.key === key) {
      return unquote(stripComment(line.rest).trim());
    }
  }
  return undefined;
}

function samePath(left: TomlPath, right: TomlPath): boolean {
  return left.length === right.length && left.every((segment, i) => segment === right[i]);
}

/* -------------------------------- escritura ------------------------------- */

/** Devuelve el texto nuevo. `value === undefined` quita la clave. */
export function setValue(
  text: string,
  path: TomlPath,
  key: string,
  value: TomlValue | undefined
): string {
  const lines = splitLines(text);
  const eol = defaultEol(text);
  const table = findTable(text, path);
  if (!table) {
    if (value === undefined) {
      return text;
    }
    const literal = serializeValue(value);
    return path.length === 0
      ? appendPreamble(text, key, literal, eol)
      : appendTable(text, path, key, literal, eol);
  }

  const first = path.length === 0 ? 0 : table.start + 1;
  let index = -1;
  for (let i = first; i < table.end; i++) {
    const line = parseKeyLine(lines[i].text);
    if (line && line.key === key) {
      index = i;
      break;
    }
  }

  if (value === undefined) {
    if (index < 0) {
      return text;
    }
    lines.splice(index, 1);
    return joinLines(lines);
  }

  const literal = serializeValue(value);
  if (index < 0) {
    // En el preamble, tras su última línea con contenido: así el hueco en blanco
    // que ya separaba de la primera cabecera sigue separando.
    const at = path.length === 0 ? preambleInsertAt(lines, table.end) : table.start + 1;
    if (at > 0 && !lines[at - 1].eol) {
      lines[at - 1].eol = eol;
    }
    lines.splice(at, 0, { text: `${key} = ${literal}`, eol });
    return joinLines(lines);
  }

  const line = lines[index];
  const rest = parseKeyLine(line.text)!.rest;
  // Se corta en el valor: lo que quede detrás (espacios y comentario) se conserva.
  const valueEnd = stripComment(rest).trimEnd().length;
  const current = rest.slice(0, valueEnd).trim();
  if (current === literal) {
    return text;
  }
  line.text = line.text.slice(0, line.text.length - rest.length) + literal + rest.slice(valueEnd);
  return joinLines(lines);
}

/** Clave suelta al final de un fichero sin tablas. */
function appendPreamble(text: string, key: string, literal: string, eol: string): string {
  const out = text && !text.endsWith("\n") && !text.endsWith("\r") ? text + eol : text;
  return out + `${key} = ${literal}${eol}`;
}

function appendTable(
  text: string,
  path: TomlPath,
  key: string,
  literal: string,
  eol: string
): string {
  let out = text;
  if (out && !out.endsWith("\n") && !out.endsWith("\r")) {
    out += eol;
  }
  if (out && !out.endsWith(eol + eol)) {
    out += eol;
  }
  return out + `${formatHeader(path)}${eol}${key} = ${literal}${eol}`;
}
