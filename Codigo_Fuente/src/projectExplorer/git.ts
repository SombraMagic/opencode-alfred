/**
 * Capa git del Explorador del proyecto: estado porcelain v2, numstat, ficheros
 * sin subir y acciones por CLI. Todo con `execFile` (nunca shell) y rutas
 * mapeadas del toplevel del repo a la raíz del árbol.
 */

import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { GitInfo, GitState, RowGit } from "./model";

export type GitActionKind =
  | "fetch"
  | "pull"
  | "push"
  | "commit"
  | "stageAll"
  | "stage"
  | "unstage"
  | "discard"
  | "checkout"
  | "createBranch"
  | "resolveOurs"
  | "resolveTheirs"
  | "discardConflict"
  | "stashConflict"
  | "stashPop"
  | "stashPopForce"
  | "stashDrop"
  | "resolveAllOurs"
  | "resolveAllTheirs"
  | "refresh";

/** Nombre de rama aceptado para `createBranch`. */
export const BRANCH_RE = /^[A-Za-z0-9._/-]{1,80}$/;

/** Error de git con mensaje corto listo para la UI. */
export class GitError extends Error {}

/** Estado de un fichero dentro del repo, con claves de fila ya resueltas. */
export interface GitFileState extends RowGit {
  state: GitState;
}

/** Clave: `rel` del árbol con separador "/". */
export type GitStateMap = Map<string, GitFileState>;

export interface RepoState {
  info: GitInfo;
  /** Estado por fichero relativo a la raíz del árbol; `state:"clean"` solo si está sin subir. */
  files: GitStateMap;
}

const ENV_GIT: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
const TIMEOUT_STATUS = 15_000;
const TIMEOUT_LONG = 180_000;

/** Última línea no vacía de un texto de error. */
export function lastUsefulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/** La línea de un error que da la causa (`CONFLICT`/`error`/`fatal`) o, si no, la primera. */
function firstLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(CONFLICT|error|fatal)/i.test(l)) ?? lines[0] ?? "";
}

/** `git -C <cwd>` sin shell, con tope, buffer y entorno estable. */
export function gitExec(
  cwd: string,
  args: readonly string[],
  timeoutMs = TIMEOUT_STATUS
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: ENV_GIT,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | undefined;
        if (err?.code === "ENOENT") {
          resolve({ code: -1, out: "", err: "git no está instalado o no está en el PATH." });
          return;
        }
        if (err?.killed) {
          resolve({ code: -1, out: String(stdout ?? ""), err: "Tiempo de espera agotado." });
          return;
        }
        resolve({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          out: String(stdout ?? ""),
          err: String(stderr ?? ""),
        });
      }
    );
  });
}

async function mustOk(cwd: string, args: readonly string[], timeoutMs = TIMEOUT_STATUS): Promise<string> {
  const r = await gitExec(cwd, args, timeoutMs);
  if (r.code !== 0) {
    throw new GitError(lastUsefulLine(r.err || r.out) || `git ${args[0]} falló.`);
  }
  return r.out;
}

function normSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function pathEq(a: string, b: string): boolean {
  const na = normSlashes(a).replace(/\/+$/, "");
  const nb = normSlashes(b).replace(/\/+$/, "");
  if (process.platform === "win32") {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/** ¿`child` (con "/") cuelga de `parent`? En Windows la caja no cuenta. */
function startsWithDir(parent: string, child: string): boolean {
  const p = parent.endsWith("/") ? parent : `${parent}/`;
  if (process.platform === "win32") {
    return child.toLowerCase().startsWith(p.toLowerCase());
  }
  return child.startsWith(p);
}

/** ¿`p` (con "/") apunta dentro de `.git` o a un submodule? */
function isVcsNoise(p: string): boolean {
  return p === ".git" || p.startsWith(".git/") || p.includes("/.git/") || p.endsWith("/.git");
}

/** Toplevel del repo que contiene `root`, o null si no hay repo (o no hay git). */
export async function findToplevel(root: string): Promise<string | null> {
  const r = await gitExec(root, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) {
    return null;
  }
  const line = r.out.split(/\r?\n/)[0]?.trim() ?? "";
  if (!line) {
    return null;
  }
  return path.normalize(line);
}

/**
 * Constructor del mapeo ruta del repo -> `rel` del árbol. Devuelve `null` si la
 * raíz queda fuera del repo. Compara sin distinguir caja en Windows y deja fuera
 * lo que no cuelga del árbol y la basura de `.git`.
 */
function makeToRel(
  toplevelAbs: string,
  root: string
): ((relToplevel: string) => string | null) | null {
  const toplevel = normSlashes(toplevelAbs);
  const rootNorm = normSlashes(root);
  if (!(pathEq(toplevel, rootNorm) || startsWithDir(toplevel, rootNorm))) {
    return null;
  }
  return (relToplevel: string): string | null => {
    const p = normSlashes(relToplevel);
    if (!p || isVcsNoise(p)) {
      return null;
    }
    if (pathEq(toplevel, rootNorm)) {
      return p;
    }
    const prefix = `${toplevel}/`;
    if (!startsWithDir(toplevel, rootNorm)) {
      return null;
    }
    const sub = `${rootNorm.slice(prefix.length)}/`;
    if (pathEq(sub.slice(0, -1), p)) {
      return "";
    }
    return startsWithDir(sub, p) ? p.slice(sub.length) : null;
  };
}

/**
 * Estado completo del repo relativo a `root`: rama, upstream, ahead/behind,
 * ficheros y ramas locales. `null` si la raíz no está dentro de un repo.
 * `hasRel` dice si una ruta existe en el árbol escaneado (recortes de recuentos).
 */
export async function readRepoState(
  root: string,
  hasRel: (rel: string) => boolean
): Promise<RepoState | null> {
  const toplevelAbs = await findToplevel(root);
  if (!toplevelAbs) {
    return null;
  }
  const toRel = makeToRel(toplevelAbs, root);
  if (!toRel) {
    return null;
  }

  const status = await mustOk(toplevelAbs, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--ignored=matching",
    "-uall",
    "-z",
  ]);

  let branchOid = "";
  let branchName = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitStateMap = new Map();
  const workDirty = new Set<string>();
  const indexDirty = new Set<string>();

  const raw = status.split("\0");
  for (let k = 0; k < raw.length; k++) {
    const line = raw[k];
    if (!line) {
      continue;
    }
    if (line.startsWith("#")) {
      const up = line.match(/^# branch\.upstream (\S+)/);
      if (up) {
        upstream = up[1];
        continue;
      }
      const ab = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
      if (ab) {
        ahead = Number(ab[1]);
        behind = Number(ab[2]);
        continue;
      }
      const head = line.match(/^# branch\.head (\S+)/);
      if (head) {
        branchName = head[1];
        continue;
      }
      const oid = line.match(/^# branch\.oid (\S+)/);
      if (oid) {
        branchOid = oid[1];
      }
      continue;
    }
    if (line.startsWith("u ")) {
      // Conflicto de merge: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <camino>`.
      const fields = line.split(" ");
      if (fields.length < 11) {
        continue;
      }
      const rest = line.slice(fields.slice(0, 10).join(" ").length + 1);
      // Con `-z` no hay renombrados aquí: el camino va entero, sin campos extra.
      const rel = toRel(rest.split("\t")[0]);
      if (rel === null || rel === "") {
        continue;
      }
      if (!files.has(rel)) {
        files.set(rel, { state: "conflict" });
      }
      workDirty.add(rel);
      indexDirty.add(rel);
      continue;
    }
    if (line[1] !== " ") {
      // Entrada con un formato que porcelain v2 no separa con espacio: fuera.
      continue;
    }
    const kind = line[0];
    if (kind !== "1" && kind !== "2" && kind !== "?" && kind !== "!") {
      continue;
    }
    if (kind === "?" || kind === "!") {
      // Sin trackear o ignorado: `<clave> <camino>`. Las carpetas salen con la barra final.
      const bare = line.slice(2).replace(/\/+$/, "");
      const rel = toRel(bare);
      if (rel === null || rel === "") {
        continue;
      }
      const st0: GitState = kind === "!" ? "ignored" : "untracked";
      if (!files.has(rel)) {
        files.set(rel, { state: st0 });
      }
      if (st0 === "untracked") {
        workDirty.add(rel);
      }
      continue;
    }
    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <camino>`
    // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <camino> <TAB> <origen>`
    const fields = line.split(" ");
    const xy = fields[1] ?? "";
    const sub = fields[2] ?? "";
    if (sub.startsWith("S")) {
      // Submódulo: este explorador no lo gestiona.
      continue;
    }
    const tailIndex = kind === "2" ? 9 : 8;
    let rest = fields.slice(0, tailIndex).join(" ");
    rest = line.slice(rest.length + 1);
    const tab = rest.indexOf("\t");
    const rawPath = tab >= 0 ? rest.slice(0, tab) : rest;
    if (xy[0] === "R" || xy[1] === "R") {
      // Renombrado: `rawPath` es el destino y el origen vive en el siguiente campo NUL.
      const rel = toRel(rawPath);
      const fromField = raw[++k] ?? "";
      const from = fromField.split("\t")[0] ?? fromField;
      const relFrom = toRel(from);
      if (rel !== null) {
        files.set(rel, { state: "renamed" });
        workDirty.add(rel);
        indexDirty.add(rel);
      }
      if (relFrom !== null && relFrom !== rel) {
        // El origen ya no existe: solo se marca como índice sucio si sigue visible.
        indexDirty.add(relFrom);
      }
      continue;
    }
    const rel = toRel(rawPath);
    const key = rel ?? normSlashes(rawPath);
    if (xy[0] !== "." && xy[0] !== "?") {
      indexDirty.add(key);
    }
    if (xy[1] !== "." && xy[1] !== "?") {
      workDirty.add(key);
    }
    if (rel === null) {
      continue;
    }
    let state: GitState;
    if (xy[1] === "D") {
      state = "deleted";
    } else if (xy[0] !== "." && xy[0] !== "?") {
      state = "staged";
    } else {
      state = "modified";
    }
    if (!files.has(rel)) {
      files.set(rel, { state });
    }
  }

  // Ramas locales.
  const branches: string[] = [];
  const br = await gitExec(toplevelAbs, ["branch", "--format=%(refname:short)"]);
  if (br.code === 0) {
    for (const b of br.out.split(/\r?\n/)) {
      const name = b.trim();
      if (name) {
        branches.push(name);
      }
    }
  }

  // Diffs de líneas (árbol de trabajo e índice), sumando por fichero.
  // Con `-z` cada registro es `<más>\t<menos>\t<camino>` terminado en NUL; en los
  // renombrados el camino va vacío y llegan dos campos NUL más (origen y destino).
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  const applyNumstat = (out: string, dirtySet: Set<string>): void => {
    const fields = out.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i];
      if (!record) {
        continue;
      }
      const first = record.indexOf("\t");
      if (first < 0) {
        continue;
      }
      const second = record.indexOf("\t", first + 1);
      if (second < 0) {
        continue;
      }
      const a = record.slice(0, first);
      const r = record.slice(first + 1, second);
      let p = record.slice(second + 1);
      if (p === "") {
        const src = fields[i + 1];
        const dst = fields[i + 2];
        if (dst === undefined) {
          break;
        }
        p = dst;
        i += 2;
      }
      if (!p || a === "-" || r === "-") {
        continue;
      }
      const rel = toRel(p);
      if (rel === null) {
        continue;
      }
      dirtySet.add(rel);
      added.set(rel, (added.get(rel) ?? 0) + (Number(a) || 0));
      removed.set(rel, (removed.get(rel) ?? 0) + (Number(r) || 0));
    }
  };

  const workDiff = await mustOk(toplevelAbs, ["diff", "--numstat", "-z"]);
  applyNumstat(workDiff, workDirty);
  const indexDiff = await mustOk(toplevelAbs, ["diff", "--cached", "--numstat", "-z"]);
  applyNumstat(indexDiff, indexDirty);

  // Sin subir: ficheros de los commits por delante del upstream.
  const unpushed = new Set<string>();
  if (upstream && ahead > 0) {
    const upDiff = await gitExec(toplevelAbs, ["diff", "--name-only", "-z", "@{u}...HEAD"]);
    if (upDiff.code === 0) {
      for (const field of upDiff.out.split("\0")) {
        const rel = toRel(field);
        if (rel !== null && rel !== "") {
          unpushed.add(rel);
        }
      }
    }
  }

  // Ficheros seguidos sin cambios: estado `clean` (lo usan SIN PUSH y el orden de prioridad).
  const lsFiles = await gitExec(toplevelAbs, ["ls-files", "-z"]);
  if (lsFiles.code === 0) {
    for (const field of lsFiles.out.split("\0")) {
      if (!field) {
        continue;
      }
      const rel = toRel(field);
      if (rel === null || rel === "" || files.has(rel)) {
        continue;
      }
      if (hasRel(rel)) {
        files.set(rel, { state: "clean" });
      }
    }
  }

  // Estado final por prioridad: conflict > deleted > renamed > untracked > staged > modified > clean.
  const dropKeys: string[] = [];
  for (const [rel, fs] of files) {
    const isWork = workDirty.has(rel) || fs.state === "deleted";
    const isIndex = indexDirty.has(rel) || fs.state === "staged" || fs.state === "renamed";
    let fin: GitState;
    if (fs.state === "conflict") {
      fin = "conflict";
    } else if (fs.state === "deleted") {
      fin = "deleted";
    } else if (fs.state === "renamed") {
      fin = "renamed";
    } else if (fs.state === "untracked" || fs.state === "ignored") {
      fin = fs.state;
    } else if (isIndex) {
      fin = isWork ? "modified" : "staged";
    } else if (isWork) {
      fin = "modified";
    } else {
      fin = "clean";
    }
    if (fin === "ignored" && !hasRel(rel)) {
      dropKeys.push(rel);
      continue;
    }
    if (fin === "clean" && !unpushed.has(rel) && !hasRel(rel)) {
      // Limpio que ya no está en el árbol (ruta muerta del índice viejo): fuera.
      dropKeys.push(rel);
      continue;
    }
    fs.state = fin;
    if (isIndex) {
      fs.staged = true;
    }
    if (unpushed.has(rel)) {
      fs.unpushed = true;
    }
    const a = added.get(rel);
    const r = removed.get(rel);
    if (a !== undefined) {
      fs.added = a;
    }
    if (r !== undefined) {
      fs.removed = r;
    }
  }
  for (const rel of dropKeys) {
    files.delete(rel);
  }
  // Sin subir pero sin cambios en el árbol: limpio marcado, solo si vive en el árbol.
  for (const rel of unpushed) {
    if (!files.has(rel) && hasRel(rel)) {
      files.set(rel, { state: "clean", unpushed: true });
    }
  }

  let branch = branchName;
  if (!branch) {
    // HEAD desprendido o repo recién init.
    const head = await gitExec(toplevelAbs, ["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = head.code === 0 ? head.out.trim() : branchOid ? `${branchOid.slice(0, 8)}` : "HEAD";
    if (branch === "HEAD" && branchOid) {
      branch = branchOid.slice(0, 8);
    }
  }

  const counts = { changed: 0, staged: 0, untracked: 0, unpushed: 0, clean: 0, conflict: 0, stashed: 0 };
  for (const [rel, fs] of files) {
    if (
      fs.state === "modified" ||
      fs.state === "staged" ||
      fs.state === "untracked" ||
      fs.state === "deleted" ||
      fs.state === "renamed" ||
      fs.state === "conflict"
    ) {
      counts.changed += 1;
    }
    if (fs.staged) {
      counts.staged += 1;
    }
    if (fs.state === "untracked") {
      counts.untracked += 1;
    }
    if (fs.unpushed) {
      counts.unpushed += 1;
    }
    if (fs.state === "clean") {
      counts.clean += 1;
    }
    if (fs.state === "conflict") {
      counts.conflict += 1;
    }
  }

  const info: GitInfo = {
    branch: branch || "(desprendido)",
    upstream,
    ahead,
    behind,
    branches,
    counts,
  };
  return { info, files };
}

/**
 * Ficheros que chocarían al fusionar HEAD con la remota (`merge-tree`, sin tocar
 * el árbol de trabajo) más los ficheros con cambios locales sin commitear
 * (índice, árbol de trabajo o sin seguimiento) que la remota también cambia:
 * esos son los que hacen fallar `git pull`. No hace `fetch`: lo lanza el
 * llamador antes. Rutas relativas a la raíz del árbol; los conflictos ya
 * presentes los suma el panel desde el estado de git.
 */
export async function detectPullConflicts(
  root: string
): Promise<{ upstream: string; files: string[] }> {
  const toplevelAbs = await findToplevel(root);
  if (!toplevelAbs) {
    throw new GitError("La carpeta no está dentro de un repositorio git.");
  }
  const up = await gitExec(toplevelAbs, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const upstream = up.code === 0 ? up.out.split(/\r?\n/)[0]?.trim() ?? "" : "";
  if (!upstream) {
    throw new GitError("La rama no tiene upstream.");
  }
  const mt = await gitExec(toplevelAbs, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "HEAD",
    "@{u}",
  ]);
  // 0 = sin conflictos; 1 = con conflictos. Cualquier otro código es un fallo real.
  if (mt.code !== 0 && mt.code !== 1) {
    throw new GitError(lastUsefulLine(mt.err || mt.out) || "git merge-tree falló.");
  }
  const toRel = makeToRel(toplevelAbs, root);
  if (!toRel) {
    throw new GitError("La carpeta no está dentro de un repositorio git.");
  }
  // Salida: OID del árbol, un camino en conflicto por línea, línea vacía y mensajes.
  const lines = mt.out.split(/\r?\n/);
  const files: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      break;
    }
    if (line.startsWith("Auto-merging ") || line.startsWith("CONFLICT ")) {
      continue;
    }
    const rel = toRel(line);
    if (rel === null || rel === "" || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    files.push(rel);
  }
  const split = (out: string) => out.split("\0").filter((p) => p !== "");
  const remote = new Set(
    split(await mustOk(toplevelAbs, ["diff", "--name-only", "--no-renames", "-z", "HEAD...@{u}"], TIMEOUT_LONG))
  );
  const dirty = [
    ...split(await mustOk(toplevelAbs, ["diff", "--name-only", "--no-renames", "-z", "HEAD"], TIMEOUT_LONG)),
    ...split(
      await mustOk(toplevelAbs, ["ls-files", "--others", "--exclude-standard", "-z"], TIMEOUT_LONG)
    ),
  ];
  for (const p of dirty) {
    const rel = remote.has(p) ? toRel(p) : null;
    if (rel === null || rel === "" || seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    files.push(rel);
  }
  return { upstream, files };
}

/** Un fichero apartado por Alfred (`stash push -m "alfred: <rel>"`). */
export interface StashEntry {
  /** Hash del commit del stash: estable aunque cambien los `stash@{n}`. */
  hash: string;
  /** Posición actual en `stash list`; solo vale justo después de leerla. */
  index: number;
  /** Ruta relativa a la raíz del árbol. */
  rel: string;
  /** Ruta relativa al toplevel del repo (la que entiende `git show`). */
  repoRel: string;
}

/**
 * Stashes de Alfred (mensaje `alfred: ...`, tras el `On <rama>: ` que añade git) con
 * su fichero. Los stashes del usuario no se leen. Solo local, sin red.
 */
export async function listAlfredStashes(root: string): Promise<StashEntry[]> {
  const toplevelAbs = await findToplevel(root);
  const toRel = toplevelAbs ? makeToRel(toplevelAbs, root) : null;
  if (!toplevelAbs || !toRel) {
    return [];
  }
  const list = await gitExec(toplevelAbs, ["stash", "list", "--format=%H%x00%gs"]);
  if (list.code !== 0) {
    return [];
  }
  const out: StashEntry[] = [];
  const lines = list.out.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const [hash, subject = ""] = lines[index].split("\0");
    if (!/^[0-9a-f]{40,64}$/.test(hash) || !/^On [^:]*: alfred: /.test(subject)) {
      continue;
    }
    const show = await gitExec(toplevelAbs, ["stash", "show", "--name-only", "-z", "--include-untracked", hash]);
    if (show.code !== 0) {
      continue;
    }
    // Solo cuenta el stash de UN fichero cuyo mensaje es exactamente `alfred: <rel>`:
    // uno hecho a mano (varios ficheros u otro texto) nunca se trata como de Alfred.
    const files = show.out.split("\0").filter((p) => p !== "");
    if (files.length !== 1) {
      continue;
    }
    const rel = toRel(files[0]);
    if (rel !== null && rel !== "" && subject.replace(/^On [^:]*: /, "") === `alfred: ${rel}`) {
      out.push({ hash, index, rel, repoRel: files[0] });
    }
  }
  return out;
}

/** El stash de Alfred más reciente de `rel`, con el índice resuelto ahora mismo. */
async function findStash(root: string, rel: string): Promise<StashEntry> {
  const found = (await listAlfredStashes(root)).find((e) => e.rel === rel);
  if (!found) {
    throw new GitError(`No hay nada apartado de «${baseName(rel)}».`);
  }
  return found;
}

/** Aborta si `stash@{n}` ya no es el stash leído (otro stash lo desplazó). */
async function assertStashSame(toplevelAbs: string, e: StashEntry): Promise<void> {
  const r = await gitExec(toplevelAbs, ["rev-parse", `stash@{${e.index}}`]);
  if (r.code !== 0 || r.out.trim() !== e.hash) {
    throw new GitError("El apartado cambió mientras tanto; refresca y vuelve a intentarlo.");
  }
}

/** Escribe `bytes` en `dest` por tmp+rename, conservando el modo y sin salir de `root`. */
async function writeInside(root: string, dest: string, bytes: Buffer): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  const realRoot = normSlashes(await realpath(root));
  const realDir = normSlashes(await realpath(path.dirname(dest)));
  if (!(pathEq(realDir, realRoot) || startsWithDir(realRoot, realDir))) {
    throw new GitError("La ruta del fichero cae fuera de la carpeta del árbol.");
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, bytes);
    const mode = await stat(dest).then((s) => s.mode & 0o777, () => null);
    if (mode !== null) {
      await chmod(tmp, mode);
    }
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Bytes del fichero dentro del stash: árbol del stash (seguido) o `^3` (sin seguimiento). */
async function stashBlob(toplevelAbs: string, e: StashEntry): Promise<Buffer | null> {
  for (const spec of [`${e.hash}:${e.repoRel}`, `${e.hash}^3:${e.repoRel}`]) {
    const r = await gitExecRaw(toplevelAbs, ["show", spec]);
    if (r.code === 0) {
      return r.bytes;
    }
  }
  return null;
}

/** Versión apartada de `rel` para `vscode.diff`. */
export async function readStashedVersion(root: string, rel: string): Promise<Buffer> {
  const toplevelAbs = await findToplevel(root);
  if (!toplevelAbs) {
    throw new GitError("La carpeta no está dentro de un repositorio git.");
  }
  const bytes = await stashBlob(toplevelAbs, await findStash(root, requireRel(rel)));
  if (!bytes) {
    throw new GitError("El apartado no guarda una versión de ese fichero (¿lo borraba?).");
  }
  return bytes;
}

/** Ruta del repo (con "/") a partir de la raíz del árbol y su `rel`. */
function toRepoRel(toplevelAbs: string, root: string, rel: string): string {
  const inner = path.relative(toplevelAbs, path.resolve(root)).split(path.sep).join("/");
  const clean = rel.replace(/^\/+/, "");
  return inner ? `${inner}/${clean}` : clean;
}

/** Nombre final de una ruta con "/". */
function baseName(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at >= 0 ? rel.slice(at + 1) : rel;
}

/** `rel` de una acción por fichero: no vacío, sin `..`, sin `.git` y sin absolutas. */
function requireRel(rel: string | undefined): string {
  const value = (rel ?? "").trim();
  if (!value) {
    throw new GitError("Falta la ruta del fichero.");
  }
  const parts = value.split("/");
  if (parts.some((p) => p === ".." || p.toLowerCase() === ".git") || /^[A-Za-z]:/.test(value)) {
    throw new GitError("Ruta no válida para la operación git.");
  }
  return value;
}

/** Exige un merge en curso (`MERGE_HEAD`): sin él no hay conflicto que resolver. */
async function requireMergeInProgress(cwd: string): Promise<void> {
  const r = await gitExec(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (r.code !== 0) {
    throw new GitError("No hay un merge en curso para resolver.");
  }
}

/**
 * Versión que tiene Git de un fichero, en crudo (valen binarios): primero
 * `HEAD:<repoRel>` y, si no está (añadido staged o renombrado), `:<repoRel>` del
 * índice. Lanza `GitError` con mensaje corto si ninguna de las dos existe.
 */
export async function readGitVersion(
  root: string,
  rel: string
): Promise<{ bytes: Buffer; source: "HEAD" | "indice" }> {
  const toplevelAbs = await findToplevel(root);
  if (!toplevelAbs) {
    throw new GitError("La carpeta no está dentro de un repositorio git.");
  }
  const safeRel = requireRel(rel);
  const repoRel = toRepoRel(toplevelAbs, root, safeRel);
  const head = await gitExecRaw(toplevelAbs, ["show", `HEAD:${repoRel}`]);
  if (head.code === 0) {
    return { bytes: head.bytes, source: "HEAD" };
  }
  const index = await gitExecRaw(toplevelAbs, ["show", `:${repoRel}`]);
  if (index.code === 0) {
    return { bytes: index.bytes, source: "indice" };
  }
  throw new GitError(lastUsefulLine(head.err) || "Git no guarda versión de ese fichero.");
}

/** `git show` necesita los bytes tal cual: sin decodificar como texto. */
function gitExecRaw(
  cwd: string,
  args: readonly string[]
): Promise<{ code: number; bytes: Buffer; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { windowsHide: true, timeout: TIMEOUT_STATUS, maxBuffer: 16 * 1024 * 1024, env: ENV_GIT, encoding: "buffer" },
      (error, stdout, stderr) => {
        const err = error as NodeJS.ErrnoException | undefined;
        resolve({
          code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
          bytes: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? "")),
          err: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
        });
      }
    );
  });
}

/**
 * Ejecuta una acción git. `push` sin upstream exige rama real; `checkout` valida
 * contra la lista de ramas; `createBranch` valida el nombre. Las `resolve*` exigen
 * un merge en curso. `refresh` es no-op.
 */
export async function gitAction(
  root: string,
  action: GitActionKind,
  opts: {
    branch?: string;
    message?: string;
    /** Ruta relativa a la raíz del árbol para `stage`/`unstage`/`discard`. */
    rel?: string;
    upstream: string | null;
    branchName: string;
  }
): Promise<void> {
  if (action === "refresh") {
    return;
  }
  const toplevelAbs = await findToplevel(root);
  if (!toplevelAbs) {
    throw new GitError("La carpeta no está dentro de un repositorio git.");
  }
  switch (action) {
    case "fetch":
      await mustOk(toplevelAbs, ["fetch", "--prune"], TIMEOUT_LONG);
      return;
    case "pull":
      await mustOk(toplevelAbs, ["pull", "--ff-only"], TIMEOUT_LONG);
      return;
    case "stageAll":
      await mustOk(toplevelAbs, ["add", "-A"], TIMEOUT_LONG);
      return;
    case "stage": {
      // `rel` llega relativo a la raíz del árbol, que es el cwd de git aquí.
      // `:(literal)` evita que `[`, `*` o `?` del nombre se lean como globs.
      const rel = requireRel(opts.rel);
      await mustOk(root, ["add", "--", `:(literal)${rel}`], TIMEOUT_LONG);
      return;
    }
    case "unstage": {
      const rel = requireRel(opts.rel);
      await mustOk(root, ["restore", "--staged", "--", `:(literal)${rel}`], TIMEOUT_LONG);
      return;
    }
    case "discard": {
      const rel = requireRel(opts.rel);
      // Solo ficheros: descartar una carpeta tocaría todo su contenido de golpe.
      let st;
      try {
        st = await lstat(path.join(root, ...rel.split("/")));
      } catch {
        throw new GitError(`«${baseName(rel)}» ya no existe en disco.`);
      }
      if (st.isDirectory()) {
        throw new GitError("Solo se pueden descartar cambios de ficheros.");
      }
      await mustOk(root, ["restore", "--worktree", "--", `:(literal)${rel}`], TIMEOUT_LONG);
      return;
    }
    case "resolveOurs":
    case "resolveTheirs": {
      const rel = requireRel(opts.rel);
      await requireMergeInProgress(root);
      const side = action === "resolveOurs" ? "--ours" : "--theirs";
      // `:(literal)` evita que `[`, `*` o `?` del nombre se lean como globs.
      await mustOk(root, ["checkout", side, "--", `:(literal)${rel}`], TIMEOUT_LONG);
      await mustOk(root, ["add", "--", `:(literal)${rel}`], TIMEOUT_LONG);
      return;
    }
    case "resolveAllOurs":
    case "resolveAllTheirs": {
      await requireMergeInProgress(toplevelAbs);
      const side = action === "resolveAllOurs" ? "--ours" : "--theirs";
      // Solo los conflictos reales: `-- .` revertía ficheros no conflictivos y
      // `add -A` metía en el índice los sin seguimiento ajenos. Con `-z` cada
      // camino llega entero, sin comillas, terminado en NUL.
      const list = await mustOk(toplevelAbs, [
        "diff",
        "--name-only",
        "-z",
        "--diff-filter=U",
      ]);
      const paths = list.split("\0").filter((p) => p !== "");
      if (paths.length === 0) {
        throw new GitError("No hay ficheros en conflicto.");
      }
      for (const p of paths) {
        await mustOk(toplevelAbs, ["checkout", side, "--", `:(literal)${p}`], TIMEOUT_LONG);
        await mustOk(toplevelAbs, ["add", "--", `:(literal)${p}`], TIMEOUT_LONG);
      }
      return;
    }
    case "discardConflict": {
      const rel = requireRel(opts.rel);
      await mustOk(
        root,
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", `:(literal)${rel}`],
        TIMEOUT_LONG
      );
      return;
    }
    case "stashConflict": {
      const rel = requireRel(opts.rel);
      // Sin nada sucio git sale con 0 sin crear stash: se nota porque `refs/stash` no se mueve.
      const antes = (await gitExec(toplevelAbs, ["rev-parse", "-q", "--verify", "refs/stash"])).out.trim();
      await mustOk(
        root,
        ["stash", "push", "--include-untracked", "-m", `alfred: ${rel}`, "--", `:(literal)${rel}`],
        TIMEOUT_LONG
      );
      const despues = (await gitExec(toplevelAbs, ["rev-parse", "-q", "--verify", "refs/stash"])).out.trim();
      if (despues === antes) {
        throw new GitError(`No hay cambios locales que apartar en ${rel}.`);
      }
      return;
    }
    case "stashPop": {
      const rel = requireRel(opts.rel);
      const e = await findStash(root, rel);
      await assertStashSame(toplevelAbs, e);
      const r = await gitExec(toplevelAbs, ["stash", "pop", `stash@{${e.index}}`], TIMEOUT_LONG);
      if (r.code !== 0) {
        // Con choque git deja el stash y los marcadores en el fichero.
        throw new GitError(
          `No se pudo recuperar «${baseName(rel)}» limpio: ${firstLine(r.err || r.out) || "git falló"}. ` +
            "El apartado se conserva; si git dejó marcadores de conflicto en el fichero, resuélvelos."
        );
      }
      return;
    }
    case "stashPopForce": {
      const rel = requireRel(opts.rel);
      const e = await findStash(root, rel);
      const bytes = await stashBlob(toplevelAbs, e);
      if (!bytes) {
        throw new GitError("El apartado no guarda una versión de ese fichero (¿lo borraba?).");
      }
      const dest = path.join(root, ...rel.split("/"));
      await writeInside(root, dest, bytes);
      await assertStashSame(toplevelAbs, e);
      await mustOk(toplevelAbs, ["stash", "drop", `stash@{${e.index}}`]);
      return;
    }
    case "stashDrop": {
      const e = await findStash(root, requireRel(opts.rel));
      await assertStashSame(toplevelAbs, e);
      await mustOk(toplevelAbs, ["stash", "drop", `stash@{${e.index}}`]);
      return;
    }
    case "push": {
      if (opts.upstream) {
        await mustOk(toplevelAbs, ["push"], TIMEOUT_LONG);
        return;
      }
      const branch = opts.branchName && opts.branchName !== "HEAD" ? opts.branchName : null;
      if (!branch) {
        throw new GitError("HEAD desprendido: crea una rama antes de subir.");
      }
      await mustOk(toplevelAbs, ["push", "-u", "origin", branch], TIMEOUT_LONG);
      return;
    }
    case "commit": {
      const message = (opts.message ?? "").trim().slice(0, 2000);
      if (!message) {
        throw new GitError("El mensaje del commit está vacío.");
      }
      await mustOk(toplevelAbs, ["commit", "-m", message], TIMEOUT_LONG);
      return;
    }
    case "checkout": {
      const branch = opts.branch ?? "";
      if (!branch) {
        throw new GitError("Rama vacía.");
      }
      const list = await mustOk(toplevelAbs, ["branch", "--format=%(refname:short)"]);
      const names = list.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!names.includes(branch)) {
        throw new GitError(`La rama "${branch}" no existe en este repositorio.`);
      }
      await mustOk(toplevelAbs, ["checkout", branch], TIMEOUT_LONG);
      return;
    }
    case "createBranch": {
      const branch = opts.branch ?? "";
      if (!BRANCH_RE.test(branch) || branch.startsWith("-")) {
        throw new GitError("Nombre de rama no válido.");
      }
      await mustOk(toplevelAbs, ["checkout", "-b", branch], TIMEOUT_LONG);
      return;
    }
  }
}
