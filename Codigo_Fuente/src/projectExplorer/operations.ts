/**
 * Operaciones de filesystem del Explorador del proyecto: resolución segura de
 * rutas, contadores para las confirmaciones y borrar/copiar/mover sin seguir
 * symlinks ni sobrescribir nunca.
 */

import * as vscode from "vscode";
import { cp, lstat, readdir, realpath, rename, rm } from "node:fs/promises";
import * as path from "node:path";

/** Máximo de elementos que se cuentan para el aviso de borrado. */
const COUNT_CAP = 200;

/** En Windows las rutas no distinguen caja: se igualan antes de comparar. */
export function foldPath(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** ¿Las dos rutas (logicas o absolutas) señalan el mismo sitio? */
export function samePath(a: string, b: string): boolean {
  return foldPath(path.resolve(a)) === foldPath(path.resolve(b));
}

/** ¿`child` cuelga estrictamente de `parent`? Con `..` o fuera, no. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(foldPath(path.resolve(parent)), foldPath(path.resolve(child)));
  if (!rel || rel === ".." || path.isAbsolute(rel)) {
    return false;
  }
  return !rel.startsWith(`..${path.sep}`);
}

/** Error con mensaje corto listo para la UI (`op` ok:false). */
export class OpError extends Error {}

/**
 * Resuelve `rel` (con "/" o "\") dentro de `root` con garantías:
 * rechaza absolutas, `..`, el propio `.git`, la raíz (salvo `allowRoot`) y
 * cualquier escape por symlink en el padre real. Devuelve la absoluta normalizada.
 */
export async function resolveInside(
  root: string,
  rel: string,
  opts: { allowRoot?: boolean } = {}
): Promise<string> {
  const raw = (rel ?? "").trim();
  if (raw.includes("\0")) {
    throw new OpError("Ruta no válida.");
  }
  if (raw === "" || raw === ".") {
    // La raíz: `allowRoot` la acepta (destino de copiar/mover y `reveal`).
    if (!opts.allowRoot) {
      throw new OpError("No se puede operar sobre la raíz del árbol.");
    }
    const rootAbs0 = path.resolve(root);
    try {
      await realpath(rootAbs0);
    } catch {
      throw new OpError("La carpeta raíz no existe.");
    }
    return rootAbs0;
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new OpError("No se aceptan rutas absolutas.");
  }
  const segments = raw.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new OpError("No se aceptan rutas con «..».");
  }
  if (segments.length === 0) {
    throw new OpError("Ruta vacía.");
  }
  if (segments.some((s) => s.toLowerCase() === ".git")) {
    throw new OpError("No se puede operar sobre la carpeta .git.");
  }
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...segments);
  const normAbs = path.normalize(abs);
  if (samePath(rootAbs, normAbs)) {
    if (!opts.allowRoot) {
      throw new OpError("No se puede operar sobre la raíz del árbol.");
    }
    return normAbs;
  }
  // En Windows las rutas no distinguen caja: la comparación tampoco la hace.
  if (!isWithin(rootAbs, normAbs)) {
    throw new OpError("La ruta sale de la carpeta raíz.");
  }
  // El padre real no debe escapar por symlinks (el último segmento puede no existir).
  const parentRel = segments.slice(0, -1);
  const parentAbs =
    parentRel.length > 0 ? path.resolve(rootAbs, ...parentRel) : rootAbs;
  let realRoot: string;
  try {
    realRoot = await realpath(rootAbs);
  } catch {
    throw new OpError("La carpeta raíz no existe.");
  }
  let realParent: string;
  try {
    realParent = await realpath(parentAbs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new OpError("La carpeta de destino no existe.");
    }
    throw new OpError("Sin permiso para leer la ruta.");
  }
  if (!samePath(realParent, realRoot) && !isWithin(realRoot, realParent)) {
    throw new OpError("La ruta escapa de la raíz por un enlace.");
  }
  // Comprobación extra: el `.git` real del padre tampoco vale.
  if (path.basename(realParent).toLowerCase() === ".git") {
    throw new OpError("No se puede operar dentro de .git.");
  }
  return normAbs;
}

/** Cuenta entradas (con las anidadas) hasta `cap`. Sin errores: lo que no se pueda leer, fuera. */
export async function countElements(abs: string, cap = COUNT_CAP): Promise<number> {
  let count = 0;
  const stack = [abs];
  while (stack.length > 0 && count < cap) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      count += 1;
      if (count >= cap) {
        return count;
      }
      try {
        const st = await lstat(path.join(dir, name));
        if (st.isDirectory()) {
          stack.push(path.join(dir, name));
        }
      } catch {
        // Enlace roto o sin permisos: se cuenta la entrada, no su interior.
      }
    }
  }
  return count;
}

function opMessage(err: unknown, abs: string): OpError {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
    return new OpError(`Sin permiso para tocar ${path.basename(abs)}.`);
  }
  if (code === "ENOTEMPTY") {
    return new OpError(`«${path.basename(abs)}» ya existe y no está vacía.`);
  }
  if (code === "EISDIR") {
    return new OpError(`«${path.basename(abs)}» es un directorio.`);
  }
  if (code === "ENOTDIR") {
    return new OpError(`Un segmento del camino no es una carpeta.`);
  }
  if (code === "EROFS") {
    return new OpError("El destino está en un volumen de solo lectura.");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new OpError(message.split(/\r?\n/)[0] ?? "Error desconocido.");
}

/**
 * Borra con papelera de VS Code (`useTrash:true`) o directo (`useTrash:false`).
 * El fallo del modo papelera se propaga para que el panel pida la segunda confirmación.
 */
export async function deletePath(abs: string, useTrash: boolean): Promise<void> {
  const uri = vscode.Uri.file(abs);
  try {
    if (useTrash) {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
    } else {
      await rm(abs, { recursive: true, force: true, maxRetries: 2 });
    }
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    // Cancelación del diálogo de papelera: no es un fallo que merezca insistir.
    const cancelled =
      useTrash && (e.code === "UserCancelled" || /cancel/i.test(String(e.message ?? "")));
    if (cancelled) {
      throw new OpError("Borrado cancelado por el usuario.");
    }
    throw opMessage(err, abs);
  }
}

/** Copia recursiva sin sobrescribir (existe => error claro). */
export async function copyPath(srcAbs: string, destAbs: string): Promise<void> {
  try {
    const st = await lstat(srcAbs);
    if (st.isSymbolicLink()) {
      throw new OpError("No se copian enlaces.");
    }
    await cp(srcAbs, destAbs, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: false,
    });
  } catch (err) {
    if (err instanceof OpError) {
      throw err;
    }
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    // `cp` envuelve EEXIST sin dejar el code en el error: se casa también el texto.
    if (code === "EEXIST" || /EEXIST|already exists|ya existe/i.test(message)) {
      throw new OpError(`«${path.basename(destAbs)}» ya existe. Sin sobrescribir.`);
    }
    throw opMessage(err, destAbs);
  }
}

/** Mueve con rename; si cruza de volumen, copia + borra. Nunca sobrescribe. */
export async function movePath(srcAbs: string, destAbs: string): Promise<void> {
  try {
    const st = await lstat(srcAbs);
    if (st.isSymbolicLink()) {
      throw new OpError("No se mueven enlaces.");
    }
    try {
      await lstat(destAbs);
      throw new OpError(`«${path.basename(destAbs)}» ya existe. Sin sobrescribir.`);
    } catch (err) {
      if (err instanceof OpError) {
        throw err;
      }
      // ENOENT (o cualquier lectura fallida del destino): el sitio está libre.
    }
    try {
      await rename(srcAbs, destAbs);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        await cp(srcAbs, destAbs, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
        });
        await rm(srcAbs, { recursive: true, force: true, maxRetries: 2 });
        return;
      }
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        throw new OpError(`«${path.basename(destAbs)}» ya existe. Sin sobrescribir.`);
      }
      throw opMessage(err, destAbs);
    }
  } catch (err) {
    if (err instanceof OpError) {
      throw err;
    }
    throw opMessage(err, srcAbs);
  }
}
