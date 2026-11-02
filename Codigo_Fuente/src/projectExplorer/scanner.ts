/**
 * Escaneo y renderizado del árbol de ficheros del Explorador del proyecto.
 * `scanDirectory` recorre en paralelo con `node:fs/promises`; `Tree` guarda el
 * árbol en memoria; `computeRows` produce las filas visibles (modo árbol o de
 * resultados) ya ordenadas y con el estado git pegado. Sin dependencias de `vscode`.
 */

import { lstat, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { FilterId, Row, RowGit } from "./model";
import type { GitFileState } from "./git";

/** Tope global de entradas del escaneo. */
export const MAX_ENTRIES = 150_000;
/** Tope de profundidad de carpetas. */
export const MAX_DEPTH = 64;
/** Operaciones de filesystem concurrentes durante el escaneo. */
export const SCAN_CONCURRENCY = 32;
/** Tope de filas por mensaje `view`. */
export const MAX_VIEW_ROWS = 5000;
/** Metadatos de sistemas de versiones: siempre fuera del árbol y del total. */
const EXCLUDED_VCS = new Set([".git", ".hg", ".svn"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

function parentOf(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at > 0 ? rel.slice(0, at) : "";
}

function baseName(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at >= 0 ? rel.slice(at + 1) : rel;
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Predicado de progreso: se llama al menos al inicio y al final del escaneo. */
export type ScanProgress = (counts: { files: number; dirs: number; bytes: number }) => void;

export interface ScanCounts {
  files: number;
  dirs: number;
  bytes: number;
  /** Se superó algún tope o el recorrido se cortó por cancelación. */
  truncated: boolean;
}

export interface ScanOpts {
  signal?: AbortSignal;
  onProgress?: ScanProgress;
  maxEntries?: number;
  /**
   * Prefijo del árbol cuando se rescanea un subdirectorio: `dirAbs` corresponde a
   * `relPrefix` y las rutas emitidas salen relativas a la raíz del árbol.
   */
  relPrefix?: string;
}

export interface ScanEntry {
  /** Ruta relativa con separador "/", "" para la raíz. */
  rel: string;
  /** Relativo de `rel` (donde vive la entrada). */
  parentRel: string;
  name: string;
  kind: Row["kind"];
  size: number;
  mtime: number;
  error: boolean;
}

/**
 * Rellena `sink` con las entradas de `dirAbs` (raíz del árbol) en BFS con
 * `SCAN_CONCURRENCY` lecturas simultáneas. Al cancelar o superar el tope
 * devuelve `truncated:true` sin lanzar.
 */
export async function scanDirectory(
  dirAbs: string,
  sink: (e: ScanEntry) => void,
  opts: ScanOpts = {}
): Promise<ScanCounts> {
  const signal = opts.signal;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  const sc: ScanCounts = { files: 0, dirs: 0, bytes: 0, truncated: false };
  let emitted = 0;

  const add = (e: ScanEntry): boolean => {
    if (emitted >= maxEntries) {
      sc.truncated = true;
      return false;
    }
    emitted += 1;
    sink(e);
    return true;
  };

  interface Task {
    dirAbs: string;
    rel: string;
    parentRel: string;
    depth: number;
  }

  let lastTick = 0;
  const progress = (): void => {
    const now = Date.now();
    if (now - lastTick >= 150) {
      lastTick = now;
      opts.onProgress?.({ files: sc.files, dirs: sc.dirs, bytes: sc.bytes });
    }
  };

  const queue: Task[] = [];
  {
    const rel = opts.relPrefix ?? "";
    queue.push({ dirAbs, rel, parentRel: parentOf(rel), depth: 0 });
  }
  let head = 0;
  let active = 0;

  const process = async (task: Task): Promise<void> => {
    let children;
    try {
      children = await readdir(task.dirAbs, { withFileTypes: true });
    } catch {
      // Sin permisos o borrada mientras se recorría: nodo con error, tamaño 0.
      const entry: ScanEntry = {
        rel: task.rel,
        parentRel: task.parentRel,
        name: task.rel === "" ? "" : baseName(task.rel),
        kind: "dir",
        size: 0,
        mtime: 0,
        error: true,
      };
      if (task.rel !== "") {
        add(entry);
      }
      progress();
      return;
    }
    for (const child of children) {
      if (signal?.aborted) {
        return;
      }
      if (EXCLUDED_VCS.has(child.name)) {
        continue;
      }
      const rel = task.rel === "" ? child.name : `${task.rel}/${child.name}`;
      const abs = path.join(task.dirAbs, child.name);
      const now = Date.now();
      if (child.isSymbolicLink()) {
        // Los enlaces se muestran pero no se siguen; el tamaño es el del destino si responde.
        let size = 0;
        let time = now;
        try {
          const st = await stat(abs);
          size = st.size;
          time = st.mtimeMs;
        } catch {
          size = 0;
        }
        if (add({ rel, parentRel: task.rel, name: child.name, kind: "link", size, mtime: time, error: false })) {
          sc.files += 1;
          sc.bytes += size;
        }
        progress();
        continue;
      }
      if (child.isDirectory()) {
        if (task.depth >= MAX_DEPTH) {
          sc.truncated = true;
          continue;
        }
        if (
          !add({ rel, parentRel: task.rel, name: child.name, kind: "dir", size: 0, mtime: 0, error: false })
        ) {
          return;
        }
        sc.dirs += 1;
        queue.push({ dirAbs: abs, rel, parentRel: task.rel, depth: task.depth + 1 });
        progress();
        continue;
      }
      // Fichero (o fifo/socket tratado como fichero): tamaño lógico con lstat.
      let size = 0;
      let time = now;
      let error = false;
      try {
        const st = await lstat(abs);
        size = st.size;
        time = st.mtimeMs;
      } catch (err) {
        error = (err as NodeJS.ErrnoException).code !== "ENOENT";
      }
      if (add({ rel, parentRel: task.rel, name: child.name, kind: "file", size, mtime: time, error })) {
        sc.files += 1;
        sc.bytes += size;
      }
      progress();
    }
    progress();
  };

  // Charca de trabajadores: cada uno toma la siguiente tarea pendiente.
  const worker = async (): Promise<void> => {
    while (!signal?.aborted) {
      const task = queue[head];
      if (task === undefined) {
        return;
      }
      head += 1;
      active += 1;
      try {
        await process(task);
      } finally {
        active -= 1;
      }
    }
  };

  const waitDrain = async (): Promise<void> => {
    for (;;) {
      if (head >= queue.length && active === 0) {
        return;
      }
      // Las tareas en vuelo pueden encolar más: se cede el event loop entre comprobaciones.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < SCAN_CONCURRENCY; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (!signal?.aborted) {
    await waitDrain();
    // Un worker pudo terminar mientras otro encolaba: barrido final.
    for (;;) {
      const task = queue[head];
      if (task === undefined) {
        break;
      }
      head += 1;
      active += 1;
      try {
        await process(task);
      } finally {
        active -= 1;
      }
      if (signal?.aborted) {
        break;
      }
    }
  }
  opts.onProgress?.({ files: sc.files, dirs: sc.dirs, bytes: sc.bytes });
  return sc;
}

export interface FsEntry {
  rel: string;
  name: string;
  kind: Row["kind"];
  /** Bytes lógicos; 0 en carpetas (se suma aparte). */
  size: number;
  mtime: number;
  ext: string;
  error: boolean;
}

/**
 * Árbol en memoria indexado por id numérico. La raíz tiene id 0 y `rel` "".
 */
export class Tree {
  readonly rootId = 0;
  readonly idByRel = new Map<string, number>();
  readonly entries = new Map<number, FsEntry>();
  readonly children = new Map<number, number[]>();
  /** Contador monótono: tras podar, `entries.size` reutilizaría ids vivos. */
  private nextId = 1;

  constructor(rootAbs: string) {
    this.resetRoot(rootAbs);
  }

  /** Vacía el árbol dejando solo la raíz. */
  resetRoot(rootAbs: string): void {
    this.entries.clear();
    this.idByRel.clear();
    this.children.clear();
    this.nextId = 1;
    const name = path.basename(path.resolve(rootAbs));
    this.idByRel.set("", this.rootId);
    this.entries.set(this.rootId, {
      rel: "",
      name: name || rootAbs,
      kind: "dir",
      size: 0,
      mtime: 0,
      ext: "",
      error: false,
    });
    this.children.set(this.rootId, []);
  }

  /**
   * Añade o actualiza una entrada bajo su padre. Los padres llegan siempre antes
   * que los hijos (recorrido BFS); si el padre no existe (rescan cancelado a
   * mitad) se ignora. Un `rel` repetido pisa la entrada anterior sin duplicarla.
   */
  add(e: ScanEntry): void {
    const parentId = this.idByRel.get(e.parentRel);
    if (parentId === undefined) {
      return;
    }
    let id = this.idByRel.get(e.rel);
    if (id === undefined) {
      id = this.nextId++;
      this.idByRel.set(e.rel, id);
      this.entries.set(id, {
        rel: e.rel,
        name: e.name,
        kind: e.kind,
        size: e.size,
        mtime: e.mtime,
        ext: e.kind === "dir" ? "" : extOf(e.name),
        error: e.error,
      });
      let arr = this.children.get(parentId);
      if (!arr) {
        arr = [];
        this.children.set(parentId, arr);
      }
      arr.push(id);
      if (e.kind === "dir") {
        this.children.set(id, []);
      }
      return;
    }
    const prev = this.entries.get(id);
    this.entries.set(id, {
      rel: e.rel,
      name: e.name,
      kind: e.kind,
      size: e.size,
      mtime: e.mtime,
      ext: e.kind === "dir" ? "" : extOf(e.name),
      error: e.error,
    });
    if (e.kind === "dir" && !this.children.has(id)) {
      this.children.set(id, []);
    }
    // Si cambia el tipo (dir -> fichero), el subárbol viejo queda huérfano: se poda.
    if (prev && prev.kind === "dir" && e.kind !== "dir") {
      const kids = this.children.get(id);
      if (kids && kids.length > 0) {
        this.removeSubtreeContents(id);
      }
      this.children.delete(id);
    }
  }

  /** Vacía el interior de un directorio conservando su entrada. */
  removeSubtreeContents(dirId: number): void {
    const stack = [...(this.children.get(dirId) ?? [])];
    while (stack.length) {
      const cur = stack.pop() as number;
      const kids = this.children.get(cur);
      if (kids) {
        for (const kid of kids) {
          stack.push(kid);
        }
        this.children.delete(cur);
      }
      const ce = this.entries.get(cur);
      if (ce) {
        this.idByRel.delete(ce.rel);
        this.entries.delete(cur);
      }
    }
    this.children.set(dirId, []);
  }

  /** Borra el subárbol (o la entrada) y lo desacopla de su padre. Devuelve false si no existe. */
  removeSubtree(rel: string): boolean {
    const id = this.idByRel.get(rel);
    if (id === undefined || id === this.rootId) {
      return false;
    }
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    const parentId = this.idByRel.get(parentOf(rel));
    const parentArr = parentId === undefined ? undefined : this.children.get(parentId);
    if (parentArr) {
      const at = parentArr.indexOf(id);
      if (at >= 0) {
        parentArr.splice(at, 1);
      }
    }
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as number;
      const kids = this.children.get(cur);
      if (kids) {
        for (const kid of kids) {
          stack.push(kid);
        }
        this.children.delete(cur);
      }
      const ce = this.entries.get(cur);
      if (ce) {
        this.idByRel.delete(ce.rel);
        this.entries.delete(cur);
      }
    }
    return true;
  }

  hasDir(rel: string): boolean {
    const id = this.idByRel.get(rel);
    return id !== undefined && this.entries.get(id)?.kind === "dir";
  }

  getEntry(rel: string): FsEntry | undefined {
    const id = this.idByRel.get(rel);
    return id === undefined ? undefined : this.entries.get(id);
  }

  /** ¿`maybeDesc` vive estrictamente dentro de `dirRel`? (con separador: `src` no traga a `src2`). */
  isInside(dirRel: string, maybeDesc: string): boolean {
    return dirRel === "" ? maybeDesc !== "" : maybeDesc.startsWith(dirRel + "/");
  }
}

/** Hijos visibles de un directorio, ordenados: dirs primero y luego lo pedido. */
export function sortedVisibleChildren(
  tree: Tree,
  dirId: number,
  showHidden: boolean,
  sort: "size" | "name",
  sizeOf: (id: number) => number
): number[] {
  const kids = tree.children.get(dirId);
  if (!kids || kids.length === 0) {
    return [];
  }
  const kept: number[] = [];
  for (const id of kids) {
    const e = tree.entries.get(id);
    if (!e) {
      continue;
    }
    if (!showHidden && e.name.startsWith(".")) {
      continue;
    }
    kept.push(id);
  }
  kept.sort((x, y) => {
    const ex = tree.entries.get(x) as FsEntry;
    const ey = tree.entries.get(y) as FsEntry;
    const dx = ex.kind === "dir" ? 0 : 1;
    const dy = ey.kind === "dir" ? 0 : 1;
    if (dx !== dy) {
      return dx - dy;
    }
    if (sort === "size") {
      const sx = ex.kind === "dir" ? sizeOf(x) : ex.size;
      const sy = ey.kind === "dir" ? sizeOf(y) : ey.size;
      if (sx !== sy) {
        return sy - sx;
      }
      return compareNames(ex.name, ey.name);
    }
    const byName = compareNames(ex.name, ey.name);
    if (byName !== 0) {
      return byName;
    }
    const sx = ex.kind === "dir" ? sizeOf(x) : ex.size;
    const sy = ey.kind === "dir" ? sizeOf(y) : ey.size;
    return sy - sx;
  });
  return kept;
}

/** ¿Tiene hijos visibles? (sin ordenar: solo el escaneo de la bandera). */
export function hasVisibleChildren(
  tree: Tree,
  dirId: number,
  showHidden: boolean
): boolean {
  const kids = tree.children.get(dirId);
  if (!kids) {
    return false;
  }
  for (const id of kids) {
    const e = tree.entries.get(id);
    if (!e) {
      continue;
    }
    if (!showHidden && e.name.startsWith(".")) {
      continue;
    }
    return true;
  }
  return false;
}

export interface ComputeParams {
  tree: Tree;
  /** `rel` de directorios expandidos ("" = raíz). No se modifica: en resultado se fuerza internamente. */
  expanded: ReadonlySet<string>;
  showHidden: boolean;
  sort: "size" | "name";
  /** Estado git por `rel` (vacío si no hay repo). Clave con separador "/". */
  gitMap: ReadonlyMap<string, GitFileState>;
  filter: FilterId;
  /** Coincidencias (ids) del modo resultado; sin conjunto = modo árbol. */
  resultIds?: ReadonlySet<number>;
  limit?: number;
}

export interface ComputeOut {
  rows: Row[];
  /** Se alcanzó el tope de filas. */
  truncated: boolean;
}

interface MissingRow {
  rel: string;
  name: string;
  git: RowGit;
}

/** Filas visibles del árbol o de los resultados, con git pegado y topes aplicados. */
export function computeRows(p: ComputeParams): ComputeOut {
  const tree = p.tree;
  const wantsFilter = p.filter !== "all";
  const res = p.resultIds !== undefined || wantsFilter;
  const queryIds = p.resultIds ?? new Set<number>();
  const hasGit = p.gitMap.size > 0;
  const limit = p.limit ?? MAX_VIEW_ROWS;
  // Copia: en modo resultado se marcan ancestros sin tocar el estado del llamador.
  const exp = new Set(p.expanded);
  exp.add("");

  // 1) Tamaño visible por id: dirs = suma recursiva de lo visible.
  const visSize = new Map<number, number>();
  const order: number[] = [];
  const stackBfs = [tree.rootId];
  while (stackBfs.length) {
    const id = stackBfs.pop() as number;
    order.push(id);
    for (const kid of tree.children.get(id) ?? []) {
      stackBfs.push(kid);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const e = tree.entries.get(id);
    if (!e) {
      continue;
    }
    if (!p.showHidden && id !== tree.rootId && e.name.startsWith(".")) {
      visSize.set(id, 0);
      continue;
    }
    if (e.kind === "dir") {
      let sum = 0;
      for (const kid of tree.children.get(id) ?? []) {
        sum += visSize.get(kid) ?? 0;
      }
      visSize.set(id, sum);
    } else {
      visSize.set(id, e.error ? 0 : e.size);
    }
  }
  const sizeOf = (id: number): number => visSize.get(id) ?? 0;

  // 2) folderGit: dirs con algún descendiente en estado != clean/ignored.
  const dirty = new Set<number>();
  if (hasGit) {
    for (const [rel, fs] of p.gitMap) {
      if (fs.state === "clean" || fs.state === "ignored") {
        continue;
      }
      const id = tree.idByRel.get(rel);
      if (id === undefined) {
        continue;
      }
      let cur = parentOf(rel);
      while (cur !== "") {
        const pid = tree.idByRel.get(cur);
        if (pid === undefined || dirty.has(pid)) {
          break;
        }
        dirty.add(pid);
        cur = parentOf(cur);
      }
    }
  }

  // 3) En modo resultado: coincidencias (búsqueda y/o filtro) y cadena de ancestros.
  const memberIds = new Set<number>(queryIds);
  if (wantsFilter) {
    for (const [id, e] of tree.entries) {
      if (id === tree.rootId) {
        continue;
      }
      if (!p.showHidden && e.name.startsWith(".")) {
        continue;
      }
      // Las carpetas entran solo como ancestros de una coincidencia: `folderGit`
      // no vale para filtrar (un dir puede estar sucio por cualquier otro estado).
      if (e.kind === "dir") {
        continue;
      }
      const fs = hasGit ? p.gitMap.get(e.rel) : undefined;
      if (fs && gitPasses(fs, p.filter)) {
        memberIds.add(id);
      }
    }
  }
  const keepDirs = new Set<number>();
  if (res) {
    for (const id of memberIds) {
      keepDirs.add(id);
      const e = tree.entries.get(id);
      if (!e) {
        continue;
      }
      let cur = parentOf(e.rel);
      while (cur !== "") {
        const pid = tree.idByRel.get(cur);
        if (pid === undefined || keepDirs.has(pid)) {
          break;
        }
        keepDirs.add(pid);
        cur = parentOf(cur);
      }
    }
  }

  // 4) Ficheros borrados que ya no están en disco: solo con filtro git activo, y como
  //    filas `missing` bajo su carpeta madre (en modo árbol no se inventan filas).
  const missingByParent = new Map<string, MissingRow[]>();
  if (res && wantsFilter && hasGit) {
    for (const [rel, fs] of p.gitMap) {
      if (fs.state !== "deleted" || !gitPasses(fs, p.filter)) {
        continue;
      }
      if (tree.idByRel.has(rel)) {
        continue;
      }
      if (!p.showHidden && baseName(rel).startsWith(".")) {
        continue;
      }
      const parentRel = parentOf(rel);
      const dirId = tree.idByRel.get(parentRel);
      // El padre debe existir en el árbol y estar en la rama conservada (la raíz siempre lo está).
      const parentOk =
        dirId !== undefined && (dirId === tree.rootId || keepDirs.has(dirId));
      if (!parentOk) {
        continue;
      }
      const list = missingByParent.get(parentRel) ?? [];
      list.push({ rel, name: baseName(rel), git: { ...fs } });
      missingByParent.set(parentRel, list);
    }
  }

  // 5) Recorrido emisor de filas.
  const rows: Row[] = [];
  let truncated = false;

  const entryPasses = (e: FsEntry, fs: GitFileState | undefined): boolean => {
    if (p.filter === "all") {
      return true;
    }
    if (e.kind === "dir") {
      return dirty.has(tree.idByRel.get(e.rel) ?? -1);
    }
    return fs !== undefined && gitPasses(fs, p.filter);
  };

  const buildRow = (id: number, depth: number): Row => {
    const e = tree.entries.get(id) as FsEntry;
    const parentSize = sizeOf(tree.idByRel.get(parentOf(e.rel)) ?? tree.rootId);
    const own = sizeOf(id);
    const fs = hasGit ? p.gitMap.get(e.rel) : undefined;
    const hasKids = hasVisibleChildren(tree, id, p.showHidden);
    return {
      rel: e.rel,
      name: e.name,
      kind: e.kind,
      depth,
      hasChildren: hasKids,
      // En resultado toda carpeta va expandida (así se ven las coincidencias hijas);
      // en árbol solo si el usuario la abrió y tiene hijos visibles.
      expanded: e.kind === "dir" ? (res || exp.has(e.rel)) && hasKids : false,
      size: own,
      pct: parentSize > 0 ? Math.round((own / parentSize) * 100) : 0,
      mtime: e.mtime,
      ext: e.ext,
      git: fs ? { ...fs } : null,
      folderGit: e.kind === "dir" && dirty.has(id),
      error: e.error,
    };
  };

  const walk = (dirId: number, depth: number): void => {
    if (truncated) {
      return;
    }
    const dirEntry = tree.entries.get(dirId) as FsEntry;
    const kids = sortedVisibleChildren(tree, dirId, p.showHidden, p.sort, sizeOf);
    for (const id of kids) {
      const e = tree.entries.get(id) as FsEntry;
      if (res) {
        if (e.kind === "dir" ? !keepDirs.has(id) && !memberIds.has(id) : !memberIds.has(id)) {
          continue;
        }
      } else if (!entryPasses(e, hasGit ? p.gitMap.get(e.rel) : undefined)) {
        continue;
      }
      if (rows.length >= limit) {
        truncated = true;
        return;
      }
      rows.push(buildRow(id, depth));
      if (e.kind === "dir" && (res ? true : exp.has(e.rel))) {
        walk(id, depth + 1);
        if (truncated) {
          return;
        }
      }
    }
    const missings = missingByParent.get(dirEntry.rel);
    if (missings && missings.length > 0) {
      const sorted = [...missings].sort((a, b) => compareNames(a.name, b.name));
      for (const m of sorted) {
        if (rows.length >= limit) {
          truncated = true;
          return;
        }
        rows.push({
          rel: m.rel,
          name: m.name,
          kind: "missing",
          depth,
          hasChildren: false,
          expanded: false,
          size: 0,
          pct: 0,
          mtime: 0,
          ext: extOf(m.name),
          git: m.git,
          folderGit: false,
          error: true,
        });
      }
    }
  };

  walk(tree.rootId, 0);
  return { rows, truncated };
}

function gitPasses(fs: GitFileState, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "clean":
      return fs.state === "clean";
    case "changed":
      return (
        fs.state === "modified" ||
        fs.state === "staged" ||
        fs.state === "untracked" ||
        fs.state === "deleted" ||
        fs.state === "renamed"
      );
    case "staged":
      return fs.state === "staged" || fs.staged === true;
    case "untracked":
      return fs.state === "untracked";
    case "unpushed":
      return fs.unpushed === true;
  }
  return false;
}
