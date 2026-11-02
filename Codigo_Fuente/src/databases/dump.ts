/**
 * Volcado completo de una base de datos MariaDB. Con binario disponible (`mariadb-dump`
 * o `mysqldump`) y credenciales, lanza la herramienta nativa con un fichero temporal de
 * claves; si no, recurre al volcador propio en JS, que recorre tabla a tabla en
 * streaming. Los dos escriben en un temporal que se renombra al acabar: o fichero
 * entero, o nada. Sin `vscode`.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { DbSession } from "./driver";
import { openAtomicFile, type AtomicFile } from "./export";
import { listColumns, listTables } from "./introspect";
import { ident, qualified, quoteCell } from "./quote";
import type { DbColumn, DbTableInfo } from "./types";

/** Opciones del volcado. */
export interface DumpOptions {
  db: string;
  filePath: string;
  /** Por tabla al acabar (volcador JS) o por bytes del temporal (herramienta nativa). */
  onProgress?: (info: { table: string; rows: number; bytes: number }) => void;
  /** Se consulta cada 250 ms: al devolver true se mata el proceso y se limpia todo. */
  isCancelled?: () => boolean;
  /** Ruta preferida a `mariadb-dump`/`mysqldump` (ajuste `opencodeAgents.mariadbDumpPath`). */
  toolPath?: string;
}

/** Resultado del volcado. */
export interface DumpResult {
  file: string;
  /** Tablas de la base, sin contar vistas. */
  tables: number;
  bytes: number;
  tool: "mariadb-dump" | "js";
}

/** Credenciales para la herramienta nativa, que conecta por su cuenta. */
export interface DumpConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Perfil con TLS: añade `--ssl` a la herramienta nativa. */
  ssl?: boolean;
}

/** Filas por sentencia INSERT del volcador JS. */
const INSERT_BATCH = 500;

/** Comprobación de cancelación y progreso del proceso nativo. */
const CANCEL_POLL_MS = 250;

/** Tope por recorrido: el defecto del driver (30 s) no llega para tablas grandes. */
const SCAN_TIMEOUT_MS = 3600000;

/** Binarios de la ruta estándar de XAMPP, por si no están en el PATH. */
const XAMPP_TOOLS = ["C:\\xampp\\mariaDB\\bin\\mariadb-dump.exe", "C:\\xampp\\mariaDB\\bin\\mysqldump.exe"];

/** Error único de cancelación: se compara por identidad al envolver fallos de tabla. */
const CANCELLED = new Error("El volcado se ha cancelado.");

function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * ¿Es nuestra cancelación? Dentro del recorrido de `eachRow` el driver decora lo que
 * lance el callback, así que la identidad del error se pierde y queda mirar el mensaje.
 */
function esCancelacion(e: unknown): boolean {
  return e instanceof Error && e.message.includes(CANCELLED.message);
}

/** Primera salida de `where <comando>` que apunte a un fichero real. */
function buscarEnPath(comando: string): string | undefined {
  try {
    // `where.exe` por execFileSync: nunca shell, y síncrono porque lo llama la UI al montar.
    const salida = execFileSync("where", [comando], { encoding: "utf8", windowsHide: true });
    for (const linea of salida.split(/\r?\n/)) {
      const ruta = linea.trim();
      if (ruta && existsSync(ruta)) {
        return ruta;
      }
    }
  } catch {
    // no está en el PATH
  }
  return undefined;
}

/**
 * Ruta al volcador nativo: la preferida si existe; si no, `mariadb-dump` del PATH,
 * `mysqldump` del PATH y los dos binarios de la ruta estándar de XAMPP, en este orden.
 */
export function findDumpTool(preferredPath?: string): string | undefined {
  const preferida = (preferredPath ?? "").trim();
  if (preferida && existsSync(preferida)) {
    return preferida;
  }
  const delPath = buscarEnPath("mariadb-dump") ?? buscarEnPath("mysqldump");
  if (delPath) {
    return delPath;
  }
  return XAMPP_TOOLS.find((ruta) => existsSync(ruta));
}

/** Valor de una clave del fichero de opciones: entre comillas y con `\`, `"` y saltos escapados. */
function opcionCredencial(valor: string): string {
  const esc = valor
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `"${esc}"`;
}

function ficheroCredenciales(con: DumpConnection): string {
  return `[client]\nuser=${opcionCredencial(con.user)}\npassword=${opcionCredencial(con.password)}\n`;
}

function argumentosNativos(
  opts: DumpOptions,
  con: DumpConnection,
  tmpPath: string,
  credPath: string,
  extras: boolean
): string[] {
  // `--defaults-extra-file` tiene que ir el primero o la herramienta lo ignora.
  const args = [`--defaults-extra-file=${credPath}`, "--host", con.host, "--port", String(con.port)];
  args.push("--single-transaction", "--skip-lock-tables", "--triggers", "--hex-blob", "--default-character-set=utf8mb4");
  if (con.ssl) {
    args.push("--ssl");
  }
  if (extras) {
    args.push("--routines", "--events");
  }
  args.push("--databases", opts.db, "--result-file", tmpPath);
  return args;
}

/** Mata el árbol del proceso como manda Windows; si `taskkill` falla, tiro del hijo. */
function matarProceso(pid: number, child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (e) => {
      if (e) {
        try {
          child.kill();
        } catch {
          // ya había muerto
        }
      }
      resolve();
    });
  });
}

function dormir(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Lanza la herramienta y espera a que termine, vigilando la cancelación cada 250 ms. */
async function lanzarNativo(
  tool: string,
  args: string[],
  opts: DumpOptions,
  tmpPath: string
): Promise<{ code: number | null; stderr: string }> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(tool, args, { windowsHide: true });
  } catch (e) {
    throw new Error(`No se pudo lanzar «${basename(tool)}»: ${mensaje(e)}`);
  }
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    // Se recorta: un volcado puede escupir mucho y solo interesa el final.
    if (stderr.length < 65536) {
      stderr += chunk.toString("utf8");
    }
  });
  const fin = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
    child.once("error", (e) => {
      stderr += `\n${mensaje(e)}`;
      resolve(null);
    });
  });
  for (;;) {
    const pronto = await Promise.race([
      fin.then(() => "fin" as const),
      dormir(CANCEL_POLL_MS).then(() => "tick" as const),
    ]);
    if (pronto === "fin") {
      return { code: await fin, stderr };
    }
    if (opts.isCancelled?.()) {
      if (child.pid) {
        await matarProceso(child.pid, child);
      }
      await fin;
      throw CANCELLED;
    }
    const tam = await stat(tmpPath).catch(() => undefined);
    if (tam) {
      opts.onProgress?.({ table: "", rows: 0, bytes: tam.size });
    }
  }
}

/** Volcado con la herramienta nativa. Deja el fichero en su sitio o no deja nada. */
async function volcarConHerramienta(opts: DumpOptions, con: DumpConnection, tool: string): Promise<void> {
  const tmpPath = `${opts.filePath}.tmp`;
  await mkdir(dirname(opts.filePath), { recursive: true }).catch(() => undefined);
  const credPath = join(tmpdir(), `alfred-mariadb-dump-${randomUUID()}.cnf`);
  // La contraseña no va en argv: vive segundos en un fichero 0600 del sistema.
  await writeFile(credPath, ficheroCredenciales(con));
  try {
    chmodSync(credPath, 0o600);
  } catch {
    // en Windows chmod es decorativo
  }
  try {
    try {
      let extras = true;
      let ultimo: { code: number | null; stderr: string } | undefined;
      for (let intento = 0; intento < 2; intento++) {
        const run = await lanzarNativo(tool, argumentosNativos(opts, con, tmpPath, credPath, extras), opts, tmpPath);
        if (run.code === 0) {
          await rename(tmpPath, opts.filePath);
          return;
        }
        ultimo = run;
        // Sin privilegios sobre mysql.event / mysql.proc: se reintenta una vez sin esos dos flags.
        if (extras && /access denied|comando denegado/i.test(run.stderr)) {
          extras = false;
          continue;
        }
        break;
      }
      const detalle = (ultimo?.stderr ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      const code = ultimo?.code ?? null;
      throw new Error(
        `El volcado con «${basename(tool)}» falló${code !== null ? ` (código ${code})` : ""}: ${detalle || "sin más detalles"}.`
      );
    } catch (e) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw e;
    }
  } finally {
    await rm(credPath, { force: true }).catch(() => undefined);
  }
}

/** Definición (tabla o vista) que devuelve el servidor para el `SHOW CREATE …`. */
async function definicion(s: DbSession, sql: string): Promise<string> {
  const res = await s.query(sql, [], { rowLimit: 1 });
  const celda = res.rows.length > 0 ? res.rows[0][1] : null;
  if (typeof celda !== "string" || celda.length === 0) {
    throw new Error("El servidor no devolvió la definición de la tabla.");
  }
  return celda;
}

/** Sin `DEFINER`: al reimportar con otro usuario esa cláusula sería un error de permisos. */
function borrarDefiner(ddl: string): string {
  return ddl.replace(/DEFINER=(`[^`]*`|'[^']*'|"[^"]*"|\S+)@(`[^`]*`|'[^']*'|"[^"]*"|\S+)\s+/i, "");
}

function loteInsert(table: string, cols: DbColumn[], valores: string[]): string {
  const lista = cols.map((c) => ident(c.name)).join(", ");
  return `INSERT INTO ${ident(table)} (${lista}) VALUES ${valores.join(", ")};\n`;
}

/** Recorre la tabla y escribe su `INSERT` en lotes, con contrapresión hacia el fichero. */
async function volcarFilas(
  s: DbSession,
  opts: DumpOptions,
  file: AtomicFile,
  name: string,
  cols: DbColumn[]
): Promise<number> {
  let rows = 0;
  let lote: string[] = [];
  const select = `SELECT ${cols.map((c) => ident(c.name)).join(", ")} FROM ${qualified(opts.db, name)}`;
  await s.eachRow(
    select,
    [],
    async (row) => {
      lote.push(`(${row.map(quoteCell).join(", ")})`);
      rows++;
      if (lote.length >= INSERT_BATCH) {
        if (opts.isCancelled?.()) {
          throw CANCELLED;
        }
        await file.write(loteInsert(name, cols, lote));
        lote = [];
      }
    },
    { timeoutMs: SCAN_TIMEOUT_MS }
  );
  if (lote.length > 0) {
    await file.write(loteInsert(name, cols, lote));
  }
  return rows;
}

/**
 * Volcador propio: DDL tal cual del servidor, datos en lotes de 500 y las vistas al
 * final. Los nombres salen SIN cualificar (los cualifica el `mariadb.exe <destino>` con
 * el que se reimporta, igual que el `USE` del volcado nativo): por eso el fichero vale
 * para cualquier base de destino. Si una tabla falla por permisos, el error propaga con
 * su nombre.
 */
async function volcarEnJs(s: DbSession, opts: DumpOptions, tablas: DbTableInfo[]): Promise<void> {
  const file = await openAtomicFile(opts.filePath);
  try {
    await file.write("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n");
    for (const t of tablas.filter((x) => !x.isView)) {
      if (opts.isCancelled?.()) {
        throw CANCELLED;
      }
      let rows = 0;
      try {
        const cols = await listColumns(s, opts.db, t.name);
        await file.write(`DROP TABLE IF EXISTS ${ident(t.name)};\n`);
        const ddl = await definicion(s, `SHOW CREATE TABLE ${qualified(opts.db, t.name)}`);
        await file.write(`${ddl};\n`);
        rows = await volcarFilas(s, opts, file, t.name, cols);
      } catch (e) {
        if (esCancelacion(e)) {
          throw CANCELLED;
        }
        throw new Error(`No se pudo volcar la tabla «${t.name}»: ${mensaje(e)}`);
      }
      opts.onProgress?.({ table: t.name, rows, bytes: file.bytes });
    }
    for (const v of tablas.filter((x) => x.isView)) {
      if (opts.isCancelled?.()) {
        throw CANCELLED;
      }
      try {
        await file.write(`DROP TABLE IF EXISTS ${ident(v.name)};\n`);
        const ddl = borrarDefiner(await definicion(s, `SHOW CREATE VIEW ${qualified(opts.db, v.name)}`));
        await file.write(`${ddl};\n`);
      } catch (e) {
        if (esCancelacion(e)) {
          throw CANCELLED;
        }
        throw new Error(`No se pudo volcar la vista «${v.name}»: ${mensaje(e)}`);
      }
    }
    await file.write("SET FOREIGN_KEY_CHECKS=1;\n");
    await file.finish();
  } catch (e) {
    await file.abort();
    throw e;
  }
}

/**
 * Vuelca la base entera. Usa la herramienta nativa si hay binario y credenciales; si
 * falta cualquiera de las dos —o el volcado nativo falla sin ser cancelación—, el
 * volcador JS. Devuelve la ruta, tablas, bytes y qué se usó.
 */
export async function dumpDatabase(
  s: DbSession,
  opts: DumpOptions,
  native?: DumpConnection
): Promise<DumpResult> {
  const tablas = await listTables(s, opts.db);
  const tables = tablas.filter((t) => !t.isView).length;
  const tool = native ? findDumpTool(opts.toolPath) : undefined;
  let usado: "mariadb-dump" | "js" = "js";
  if (native && tool) {
    try {
      await volcarConHerramienta(opts, native, tool);
      usado = "mariadb-dump";
    } catch (e) {
      if (esCancelacion(e)) {
        throw e;
      }
      // El nativo dejó su temporal a medias: se limpia antes de que el JS escriba el suyo.
      await rm(`${opts.filePath}.tmp`, { force: true }).catch(() => undefined);
      try {
        await volcarEnJs(s, opts, tablas);
      } catch (jsError) {
        if (esCancelacion(jsError)) {
          throw jsError;
        }
        throw new Error(
          `El volcador JS también falló: ${mensaje(jsError)}. Fallo previo de mariadb-dump: ${mensaje(e)}`
        );
      }
    }
  } else {
    await volcarEnJs(s, opts, tablas);
  }
  const bytes = (await stat(opts.filePath)).size;
  return { file: opts.filePath, tables, bytes, tool: usado };
}
