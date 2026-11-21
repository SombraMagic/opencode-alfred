/**
 * TO_DO global, compartido entre la extensión y el MCP `mcp_alfred`.
 * Sin `vscode`: vive en `todo.json` dentro de `stateDir()` (`%APPDATA%\voz`).
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { stateDir } from "../voice/core/shared.js";
import { writeAtomic } from "../pizarra/files";

export type EstadoTodo = "nuevoIA" | "nuevoUsu" | "pendiente" | "trabajando" | "revisa" | "finalizado";

export const ESTADOS_TODO: EstadoTodo[] = [
  "nuevoIA",
  "nuevoUsu",
  "pendiente",
  "trabajando",
  "revisa",
  "finalizado",
];

/** Estados que la IA ve por defecto: lo que el usuario ya activó. */
export const ESTADOS_VISIBLES_IA: EstadoTodo[] = ["pendiente", "trabajando", "revisa"];

export interface Tarea {
  id: string;
  descripcion: string;
  proyecto: string;
  /** Epoch ms de entrada. */
  fecha: number;
  estado: EstadoTodo;
  orden: number;
  /** Resultado o motivo que deja la IA (vacío por defecto). */
  nota: string;
  actualizada: number;
  /** Quién la creó: la IA (por MCP) o el usuario. */
  origen: "ia" | "usuario";
}

/** Tarea devuelta por una mutación; `aviso` sale si hubo que apartar un `todo.json` ilegible. */
export type ResultadoTarea = Tarea & { aviso?: string };

export const MAX_TAREAS = 500;
export const MAX_DESCRIPCION = 20000;
export const MAX_PROYECTO = 500;
export const MAX_NOTA = 4000;
/** Tope de lectura y de escritura de `todo.json`: 500 tareas de ~25 KB con escapes caben; más se rechaza al escribir. */
const MAX_BYTES = 48 * 1024 * 1024;
/** Límites de lo que propone la IA: descripción y tareas `nuevoIA` sin revisar. */
export const MAX_DESCRIPCION_IA = 4000;
export const MAX_NUEVAS_IA = 30;
const ID_VALIDO = /^[A-Za-z0-9-]{1,64}$/;
const FECHA_MAX = 8.64e15;

export function todoFile(): string {
  return join(stateDir(), "todo.json");
}

function esEstado(v: unknown): v is EstadoTodo {
  return typeof v === "string" && (ESTADOS_TODO as string[]).includes(v);
}

function fechaValida(v: unknown, def: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= FECHA_MAX ? v : def;
}

/** Saneado de lo leído: descarta lo que no case y renormaliza `orden` a 0..n-1. */
export function sanear(raw: unknown): Tarea[] {
  const lista: unknown[] =
    raw && typeof raw === "object" && Array.isArray((raw as { tareas?: unknown }).tareas)
      ? (raw as { tareas: unknown[] }).tareas
      : [];
  const ahora = Date.now();
  const vistos = new Set<string>();
  const out: Tarea[] = [];
  for (const item of lista) {
    if (out.length >= MAX_TAREAS) break;
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.descripcion !== "string" || !t.descripcion.trim()) continue;
    const id = typeof t.id === "string" && ID_VALIDO.test(t.id) ? t.id : randomUUID();
    if (vistos.has(id)) continue;
    vistos.add(id);
    const fecha = fechaValida(t.fecha, ahora);
    out.push({
      id,
      descripcion: t.descripcion.slice(0, MAX_DESCRIPCION),
      proyecto: (typeof t.proyecto === "string" ? t.proyecto : "").slice(0, MAX_PROYECTO),
      fecha,
      estado: esEstado(t.estado) ? t.estado : "nuevoUsu",
      orden: 0,
      nota: (typeof t.nota === "string" ? t.nota : "").slice(0, MAX_NOTA),
      actualizada: fechaValida(t.actualizada, fecha),
      origen: t.origen === "ia" ? "ia" : "usuario",
    });
  }
  // El orden de aparición manda; `orden` se renormaliza a 0..n-1.
  out.forEach((t, i) => (t.orden = i));
  return out;
}

/** Primera línea no vacía, recortada a `max` con `…`. */
export function nombreTarea(descripcion: string, max = 80): string {
  const linea = descripcion.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return linea.length > max ? `${linea.slice(0, Math.max(0, max - 1)).trimEnd()}…` : linea;
}

type Lectura =
  | { tipo: "ausente" }
  | { tipo: "ok"; tareas: Tarea[]; descartadas: number }
  | { tipo: "ilegible"; motivo: string };

function dormir(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function mensaje(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Lectura estricta. Ausente (ENOENT) y contenido ilegible son resultados; un fichero bloqueado
 * (EBUSY/EPERM/EACCES, 3 reintentos de 40 ms) u otro fallo de E/S LANZAN: no es lo mismo que «vacío».
 */
function leerFichero(): Lectura {
  const file = todoFile();
  let texto = "";
  for (let intento = 0; ; intento++) {
    try {
      if (statSync(file).size > MAX_BYTES)
        return { tipo: "ilegible", motivo: `supera ${MAX_BYTES / 1048576} MB` };
      texto = readFileSync(file, "utf8");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { tipo: "ausente" };
      if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && intento < 3) {
        dormir(40);
        continue;
      }
      throw new Error(`No se pudo leer el TO_DO (${file}): ${mensaje(err)}`);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(texto);
  } catch (err) {
    return { tipo: "ilegible", motivo: `JSON no válido (${mensaje(err)})` };
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { tareas?: unknown }).tareas))
    return { tipo: "ilegible", motivo: "la raíz no tiene una lista `tareas`" };
  const tareas = sanear(raw);
  const descartadas = (raw as { tareas: unknown[] }).tareas.length - tareas.length;
  return { tipo: "ok", tareas, descartadas: Math.max(0, descartadas) };
}

/**
 * Lectura para pintar o listar: no renombra ni escribe nada y NO disfraza los errores.
 * Ausente = lista vacía sin error; ilegible o bloqueado = `error` en español (y lista vacía).
 * Si el saneado descartó entradas, `aviso` (NO fatal) lo dice: la lista sí viene.
 */
export function leerTodoSeguro(): { tareas: Tarea[]; error?: string; aviso?: string } {
  try {
    const l = leerFichero();
    if (l.tipo === "ausente") return { tareas: [] };
    if (l.tipo === "ilegible")
      return {
        tareas: [],
        error: `El TO_DO (${todoFile()}) está ilegible: ${l.motivo}. No se ha modificado el fichero.`,
      };
    return l.descartadas
      ? {
          tareas: l.tareas,
          aviso: `El TO_DO tiene ${l.descartadas} tareas inválidas que se descartarán al modificarlo (se guardará una copia).`,
        }
      : { tareas: l.tareas };
  } catch (err) {
    return { tareas: [], error: mensaje(err) };
  }
}

/** Escribe `todo.json`; rechaza lo que luego no se podría leer (más de `MAX_BYTES`) sin tocar el fichero. */
export async function escribirTodo(tareas: Tarea[]): Promise<void> {
  const bytes = Buffer.from(JSON.stringify({ version: 1, tareas }, null, 2), "utf8");
  if (bytes.length > MAX_BYTES)
    throw new Error(
      `El TO_DO ocuparía ${Math.ceil(bytes.length / 1048576)} MB y el tope es ${MAX_BYTES / 1048576} MB: no se ha escrito nada.`,
    );
  await writeAtomic(todoFile(), bytes);
}

/** La IA solo puede: pendiente→trabajando, trabajando→revisa, trabajando→pendiente. */
export function transicionIA(de: EstadoTodo, a: EstadoTodo): boolean {
  return (
    (de === "pendiente" && a === "trabajando") ||
    (de === "trabajando" && a === "revisa") ||
    (de === "trabajando" && a === "pendiente")
  );
}

/** Ruta normalizada (separadores, `.`/`..`, prefijo UNC `//`, caja en Windows, sin barra final). */
function normRuta(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  if (!s) return "";
  const unc = s.startsWith("//");
  s = posix.normalize(s.replace(/\/+/g, "/"));
  if (unc) s = `/${s}`;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** Raíz de unidad (`C:`, `C:\`), `/` o UNC pelada: un proyecto así cubriría todo el disco. */
function esRaiz(p: string): boolean {
  const n = normRuta(p);
  return n === "/" || n === "//" || /^[a-z]:\/?$/i.test(n);
}

function exigirProyectoValido(p: string): void {
  if (esRaiz(p)) throw new Error("El proyecto no puede ser una raíz de unidad ni `/`: elige una carpeta concreta.");
}

/** Compara rutas de proyecto normalizadas (separadores, caja en Windows, sin barra final). */
export function mismoProyecto(a: string, b: string): boolean {
  return normRuta(a) === normRuta(b);
}

/** El `cwd` es el proyecto de la tarea o está dentro de él (con separador: `/a/bc` no cae en `/a/b`). */
export function proyectoCubre(proyectoTarea: string, cwd: string): boolean {
  const a = normRuta(proyectoTarea);
  const c = normRuta(cwd);
  if (!a) return false;
  return c === a || c.startsWith(a.endsWith("/") ? a : a + "/");
}

/** Proyecto para guardar: sin espacios y sin barra final (salvo raíces como `C:\` o `/`). */
function limpiarProyecto(p: string): string {
  let s = (p ?? "").trim();
  while (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Cadena de promesas: las mutaciones de este proceso van de una en una.
let cola: Promise<unknown> = Promise.resolve();

function serializar<T>(fn: () => Promise<T>): Promise<T> {
  const p = cola.then(fn, fn);
  cola = p.catch(() => undefined);
  return p;
}

const LOCK_ESPERA_MS = 3000;
const LOCK_VIEJO_MS = 10000;
const AVISO_LOCK = "No se pudo liberar el cerrojo; caducará en 10 s.";

function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Borra un fichero sin lanzar; `false` si falló por algo distinto de que ya no exista. */
function borrarSilencioso(file: string): boolean {
  try {
    unlinkSync(file);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  return true;
}

/**
 * Cerrojo entre procesos: `todo.json.lock` creado en exclusiva con un token propio (`pid` + UUID); uno
 * de más de 10 s se da por huérfano y se aparta (rename a un nombre único) antes de borrarlo. Al soltar
 * solo se borra si el token sigue siendo nuestro. Un fallo al soltar NO se lanza (no desmiente un
 * éxito ya escrito ni tapa el error de `fn`): sale en `avisoLock`.
 */
async function conLock<T>(fn: () => Promise<T>): Promise<{ valor: T; avisoLock?: string }> {
  const lock = `${todoFile()}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const limite = Date.now() + LOCK_ESPERA_MS;
  const token = `${process.pid}-${randomUUID()}`;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
        throw new Error(`No se pudo bloquear el TO_DO (${lock}): ${mensaje(err)}`);
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_VIEJO_MS) {
          const viejo = `${lock}.viejo-${randomUUID()}`;
          renameSync(lock, viejo);
          // Si entre el `stat` y el rename otro proceso ya lo había renovado, se devuelve a su sitio.
          if (Date.now() - statSync(viejo).mtimeMs <= LOCK_VIEJO_MS) {
            try {
              renameSync(viejo, lock);
            } catch {
              borrarSilencioso(viejo);
            }
          } else borrarSilencioso(viejo);
          continue;
        }
      } catch {
        // El cerrojo desapareció entre medias: se reintenta.
      }
      if (Date.now() > limite)
        throw new Error(`No se pudo bloquear el TO_DO (${lock}): otro proceso lo está usando.`);
      await esperar(25);
    }
  }
  try {
    writeSync(fd, token);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // ya cerrado
    }
    borrarSilencioso(lock);
    throw new Error(`No se pudo bloquear el TO_DO (${lock}): ${mensaje(err)}`);
  }
  let valor: T;
  let avisoLock: string | undefined;
  try {
    valor = await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ya cerrado
    }
    let propio = false;
    try {
      propio = readFileSync(lock, "utf8") === token;
    } catch (err) {
      // Ya no está: nada que soltar. Cualquier otro fallo se trata como no liberado.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") avisoLock = AVISO_LOCK;
    }
    if (propio && !borrarSilencioso(lock)) avisoLock = AVISO_LOCK;
  }
  return { valor, avisoLock };
}

/**
 * cerrojo → leer (estricto) → mutar → escribir. Nunca escribe si la lectura lanzó. Un `todo.json`
 * ilegible se aparta a `todo.json.corrupto-<epoch>` y se sigue con una lista vacía (`aviso`).
 * No reescribe si la mutación no cambió nada.
 */
function mutar<T>(fn: (tareas: Tarea[]) => T): Promise<{ valor: T; aviso?: string }> {
  return serializar(async () => {
    const { valor: r, avisoLock } = await conLock(async () => {
      const l = leerFichero();
      let tareas: Tarea[] = [];
      let aviso: string | undefined;
      let descartadas = 0;
      if (l.tipo === "ok") {
        tareas = l.tareas;
        descartadas = l.descartadas;
      }
      else if (l.tipo === "ilegible") {
        const file = todoFile();
        const copia = `${file}.corrupto-${Date.now()}`;
        try {
          renameSync(file, copia);
        } catch (err) {
          throw new Error(
            `El TO_DO está ilegible (${l.motivo}) y no se pudo apartar a ${copia}: ${mensaje(err)}`,
          );
        }
        aviso = `El TO_DO estaba ilegible (${l.motivo}): se guardó una copia en ${copia} y se empezó con una lista vacía.`;
      }
      const antes = JSON.stringify(tareas);
      let valor: T;
      try {
        valor = fn(tareas);
      } catch (err) {
        throw aviso ? new Error(`${mensaje(err)} (${aviso})`) : err;
      }
      tareas.forEach((t, i) => (t.orden = i));
      if (JSON.stringify(tareas) !== antes) {
        if (descartadas > 0) {
          // El saneado tiró entradas: antes de reescribir se guarda el original (sin renombrar).
          const file = todoFile();
          const copia = `${file}.recortado-${Date.now()}`;
          try {
            copyFileSync(file, copia);
          } catch (err) {
            throw new Error(
              `El TO_DO tiene ${descartadas} tareas inválidas y no se pudo copiar el original a ${copia}: ${mensaje(err)}. No se ha escrito nada.`,
            );
          }
          const av = `Se descartaron ${descartadas} tareas inválidas; copia en ${copia}`;
          aviso = aviso ? `${aviso} ${av}` : av;
        }
        await escribirTodo(tareas);
      }
      return { valor, aviso };
    });
    const aviso = [r.aviso, avisoLock].filter(Boolean).join(" ") || undefined;
    return { valor: r.valor, aviso };
  });
}

/** Mutación que devuelve una tarea: le cuelga el `aviso` si lo hubo. */
async function mutarTarea(fn: (tareas: Tarea[]) => Tarea): Promise<ResultadoTarea> {
  const { valor, aviso } = await mutar(fn);
  return aviso ? { ...valor, aviso } : valor;
}

function buscar(tareas: Tarea[], id: string): Tarea {
  const t = tareas.find((x) => x.id === id);
  if (!t) throw new Error(`No existe ninguna tarea con id ${id}.`);
  return t;
}

export function crearTarea(p: {
  descripcion: string;
  proyecto: string;
  estado: EstadoTodo;
  origen?: "ia" | "usuario";
}): Promise<ResultadoTarea> {
  const descripcion = (p.descripcion ?? "").trim();
  const proyecto = limpiarProyecto(p.proyecto);
  if (!descripcion) return Promise.reject(new Error("La descripción de la tarea está vacía."));
  if (descripcion.length > MAX_DESCRIPCION)
    return Promise.reject(new Error(`La descripción supera los ${MAX_DESCRIPCION} caracteres.`));
  if (proyecto.length > MAX_PROYECTO)
    return Promise.reject(new Error(`El proyecto supera los ${MAX_PROYECTO} caracteres.`));
  if (!esEstado(p.estado)) return Promise.reject(new Error("Estado no válido."));
  const origen = p.origen === "ia" ? "ia" : "usuario";
  if (!proyecto) return Promise.reject(new Error("El proyecto de la tarea está vacío."));
  try {
    exigirProyectoValido(proyecto);
  } catch (err) {
    return Promise.reject(err);
  }
  if (origen === "ia" && descripcion.length > MAX_DESCRIPCION_IA)
    return Promise.reject(new Error(`La descripción de una tarea de la IA no puede pasar de ${MAX_DESCRIPCION_IA} caracteres.`));
  return mutarTarea((tareas) => {
    if (tareas.length >= MAX_TAREAS) throw new Error(`El TO_DO está lleno (máximo ${MAX_TAREAS} tareas).`);
    if (origen === "ia" && tareas.filter((x) => x.estado === "nuevoIA").length >= MAX_NUEVAS_IA)
      throw new Error("Hay demasiadas tareas de la IA sin revisar; el usuario debe activarlas o borrarlas.");
    const ahora = Date.now();
    const t: Tarea = {
      id: randomUUID(),
      descripcion,
      proyecto,
      fecha: ahora,
      estado: p.estado,
      orden: tareas.length,
      nota: "",
      actualizada: ahora,
      origen,
    };
    tareas.push(t);
    return t;
  });
}

/**
 * Cambia el estado. `desde`: estados de partida admitidos, comprobados DENTRO de la mutación (atómico).
 * `transicion`: es la IA; se valida con `transicionIA` y la nota se FIJA siempre (`nota ?? ""`). Sin
 * `transicion` (usuario) la nota no se toca salvo que se pase.
 */
export function cambiarEstado(
  id: string,
  estado: EstadoTodo,
  nota?: string,
  desde?: EstadoTodo[],
  transicion = false,
): Promise<ResultadoTarea> {
  if (!esEstado(estado)) return Promise.reject(new Error("Estado no válido."));
  return mutarTarea((tareas) => {
    const t = buscar(tareas, id);
    if (desde && !desde.includes(t.estado))
      throw new Error(
        `La tarea ${id} está en \`${t.estado}\`: se esperaba ${desde.map((d) => `\`${d}\``).join(" o ")}.`,
      );
    if (transicion && !transicionIA(t.estado, estado))
      throw new Error(`La tarea ${id} está en \`${t.estado}\`: la IA no puede pasarla a \`${estado}\`.`);
    t.estado = estado;
    t.actualizada = Date.now();
    if (transicion) t.nota = (nota ?? "").slice(0, MAX_NOTA);
    else if (nota !== undefined) t.nota = nota.slice(0, MAX_NOTA);
    return t;
  });
}

export function cambiarProyecto(id: string, proyecto: string): Promise<ResultadoTarea> {
  const limpio = limpiarProyecto(proyecto);
  if (limpio.length > MAX_PROYECTO)
    return Promise.reject(new Error(`El proyecto supera los ${MAX_PROYECTO} caracteres.`));
  try {
    exigirProyectoValido(limpio);
  } catch (err) {
    return Promise.reject(err);
  }
  return mutarTarea((tareas) => {
    const t = buscar(tareas, id);
    t.proyecto = limpio;
    t.actualizada = Date.now();
    return t;
  });
}

/** Reescribe la descripción (el nombre se deriva de ella con `nombreTarea`). Solo el usuario desde el panel. */
export function cambiarDescripcion(id: string, descripcion: string): Promise<ResultadoTarea> {
  const limpia = (descripcion ?? "").trim();
  if (!limpia) return Promise.reject(new Error("La descripción de la tarea está vacía."));
  if (limpia.length > MAX_DESCRIPCION)
    return Promise.reject(new Error(`La descripción supera los ${MAX_DESCRIPCION} caracteres.`));
  return mutarTarea((tareas) => {
    const t = buscar(tareas, id);
    t.descripcion = limpia;
    t.actualizada = Date.now();
    return t;
  });
}

/** Mueve la tarea a `destinoIndex` de la lista completa (se acota a los extremos). */
export function moverTarea(id: string, destinoIndex: number): Promise<ResultadoTarea> {
  return mutarTarea((tareas) => {
    const i = tareas.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`No existe ninguna tarea con id ${id}.`);
    const [t] = tareas.splice(i, 1);
    const d = Math.max(0, Math.min(tareas.length, Math.trunc(Number(destinoIndex)) || 0));
    tareas.splice(d, 0, t);
    return t;
  });
}

/** Intercambia con el vecino anterior/siguiente (del mismo proyecto si se indica); sin vecino no escribe. */
export function moverRelativa(id: string, delta: -1 | 1, proyecto?: string): Promise<ResultadoTarea> {
  return mutarTarea((tareas) => {
    const t = buscar(tareas, id);
    const visibles = tareas
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => proyecto === undefined || mismoProyecto(x.proyecto, proyecto));
    const pos = visibles.findIndex(({ x }) => x.id === id);
    const vecino = visibles[pos + delta];
    if (pos < 0 || !vecino) return t;
    const a = visibles[pos].i;
    const b = vecino.i;
    [tareas[a], tareas[b]] = [tareas[b], tareas[a]];
    return t;
  });
}

export function borrarTarea(id: string): Promise<ResultadoTarea> {
  return mutarTarea((tareas) => {
    const i = tareas.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`No existe ninguna tarea con id ${id}.`);
    return tareas.splice(i, 1)[0];
  });
}
