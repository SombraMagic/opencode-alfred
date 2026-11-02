/**
 * Capa git del Explorador del proyecto: estado porcelain v2, numstat, ficheros
 * sin subir y acciones por CLI. Todo con `execFile` (nunca shell) y rutas
 * mapeadas del toplevel del repo a la raíz del árbol.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import type { GitInfo, GitState, RowGit } from "./model";

export type GitActionKind =
  | "fetch"
  | "pull"
  | "push"
  | "commit"
  | "stageAll"
  | "checkout"
  | "createBranch"
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
  const toplevel = normSlashes(toplevelAbs);
  const rootNorm = normSlashes(root);
  if (!(pathEq(toplevel, rootNorm) || startsWithDir(toplevel, rootNorm))) {
    return null;
  }

    // `rel` dentro del árbol o null (fuera, o basura .git). Compara sin distinguir caja en Windows.
    const toRel = (relToplevel: string): string | null => {
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
    if (line[1] !== " ") {
      // Conflicto de merge (`u`) u otra entrada que porcelain v2 no separa con espacio: fuera.
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

  // Ficheros seguidos sin cambios: estado `clean` (el filtro LIMPIOS los necesita).
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

  // Estado final por prioridad: deleted > renamed > untracked > staged > modified > clean.
  const dropKeys: string[] = [];
  for (const [rel, fs] of files) {
    const isWork = workDirty.has(rel) || fs.state === "deleted";
    const isIndex = indexDirty.has(rel) || fs.state === "staged" || fs.state === "renamed";
    let fin: GitState;
    if (fs.state === "deleted") {
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

  const counts = { changed: 0, staged: 0, untracked: 0, unpushed: 0, clean: 0 };
  for (const [rel, fs] of files) {
    if (
      fs.state === "modified" ||
      fs.state === "staged" ||
      fs.state === "untracked" ||
      fs.state === "deleted" ||
      fs.state === "renamed"
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
 * Ejecuta una acción git. `push` sin upstream exige rama real; `checkout` valida
 * contra la lista de ramas; `createBranch` valida el nombre. `refresh` es no-op.
 */
export async function gitAction(
  root: string,
  action: GitActionKind,
  opts: { branch?: string; message?: string; upstream: string | null; branchName: string }
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
