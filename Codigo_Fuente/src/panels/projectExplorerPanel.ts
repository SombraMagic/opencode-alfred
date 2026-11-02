import * as vscode from "vscode";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  FilterId,
  GitInfo,
  Row,
  ScanState,
  SortDir,
  SortKey,
  TreeId,
  TreeMeta,
} from "../projectExplorer/model";
import {
  computeRows,
  MAX_ENTRIES,
  scanDirectory,
  Tree,
} from "../projectExplorer/scanner";
import { searchContents, searchNames } from "../projectExplorer/search";
import {
  BRANCH_RE,
  GitError,
  gitAction,
  readGitVersion,
  readRepoState,
  type GitActionKind,
  type GitFileState,
} from "../projectExplorer/git";
import {
  copyPath,
  countElements,
  deletePath,
  isVcsWatcherName,
  isWithin,
  movePath,
  OpError,
  resolveInside,
  samePath,
} from "../projectExplorer/operations";

const KEY_LAYOUT = "opencodeAgents.projectExplorer.layout";
const KEY_ROOTS = "opencodeAgents.projectExplorer.roots";
const KEY_EXPANDED = "opencodeAgents.projectExplorer.expanded";
const KEY_HIDDEN = "opencodeAgents.projectExplorer.hidden";
const KEY_SPLIT = "opencodeAgents.projectExplorer.split";
const KEY_SORT = "opencodeAgents.projectExplorer.sort";
const KEY_SORT_DIR = "opencodeAgents.projectExplorer.sortDir";

/** Topes internos del panel. */
const MAX_EXPANDED = 500;
const MAX_WATCHERS = 200;
const QUERY_MAX = 200;
const SEARCH_DEBOUNCE_MS = 250;
const WATCH_DEBOUNCE_MS = 600;
/** Ventana en la que ignoramos eventos de watcher tras operaciones propias. */
const SUPPRESS_MS = 1000;
const ROW_LIMIT = 5000;

interface TreeRuntime {
  id: TreeId;
  root: string;
  label: string;
  /** null = todavía sin raíz válida. */
  tree: Tree | null;
  showHidden: boolean;
  sort: SortKey;
  sortDir: SortDir;
  filter: FilterId;
  query: string;
  /** `rel` expandidos + "" para la raíz. Mutado por computeRows (ancestros). */
  expanded: Set<string>;
  scan: ScanState;
  git: GitInfo | null;
  gitFiles: Map<string, GitFileState>;
  /** Ids de coincidencias de la última búsqueda; null = modo árbol. */
  resultIds: Set<number> | null;
  scanGen: number;
  searchGen: number;
  gitGen: number;
  scanAbort: AbortController | null;
  contentAbort: AbortController | null;
  contentPending: boolean;
  searchTimer: ReturnType<typeof setTimeout> | null;
  gitRefreshTimer: ReturnType<typeof setTimeout> | null;
  watchers: Map<string, FSWatcher>;
  /**
   * Carpetas con aviso pendiente. Un aviso que cae dentro de la ventana de supresión
   * de una operación propia no se tira: se reconta al terminar esa ventana.
   */
  watchDirty: Set<string>;
  watchTimer: ReturnType<typeof setTimeout> | null;
  /** Cola FIFO de rescans del árbol: nunca dos mutaciones a la vez sobre el mismo `Tree`. */
  rescanQueue: string[];
  /** Los `rel` ya encolados, para no meter duplicados. */
  rescanSet: Set<string>;
  rescanBusy: boolean;
  /** Promesas de los que esperan: se resuelven cuando la cola queda vacía. */
  rescanWaiters: Array<() => void>;
  suppressUntil: number;
  /** Cola FIFO de acciones git (con texto para el `status busy` y ruta por fichero). */
  gitQueue: { action: GitActionKind; branch?: string; message?: string; rel?: string; text: string }[];
  gitRunning: boolean;
}

/** Acciones git admitidas. */
const GIT_ACTIONS = new Set<string>([
  "fetch",
  "pull",
  "push",
  "commit",
  "stageAll",
  "stage",
  "unstage",
  "discard",
  "checkout",
  "createBranch",
  "refresh",
]);
/** Acciones git que actúan sobre una ruta concreta del árbol. */
const GIT_PATH_ACTIONS = new Set<string>(["stage", "unstage", "discard"]);
const FILTER_IDS = new Set<string>(["all", "changed", "staged", "untracked", "unpushed", "clean"]);
const GIT_LABELS: Record<string, string> = {
  fetch: "fetch",
  pull: "pull",
  push: "push",
  commit: "commit",
  stageAll: "add -A",
  stage: "preparar",
  unstage: "quitar de preparado",
  discard: "descartar cambios",
  checkout: "checkout",
  createBranch: "rama nueva",
  refresh: "git",
};

/**
 * Pestaña central «Explorador del proyecto»: uno o dos árboles de ficheros con
 * tamaño real en disco, búsqueda (nombre, ruta y contenido), estado git e
 * inspección de operaciones. La plantilla vive en `media/projectExplorer.html`.
 */
export class ProjectExplorerPanel {
  public static current: ProjectExplorerPanel | undefined;
  public static readonly viewType = "opencodeAgents.projectExplorer";

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly state: vscode.Memento;
  /** Carpeta de almacenamiento: aquí caen los temporales de `vscode.diff`. */
  private readonly storageDir: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly trees: Map<TreeId, TreeRuntime>;
  private layout: "one" | "two" = "one";
  private split = 0.5;
  private ready = false;
  private disposed = false;

  static open(context: vscode.ExtensionContext): ProjectExplorerPanel {
    if (ProjectExplorerPanel.current) {
      ProjectExplorerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ProjectExplorerPanel.current.postInit();
      return ProjectExplorerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      ProjectExplorerPanel.viewType,
      "Explorador del proyecto",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "projectExplorer.svg");
    ProjectExplorerPanel.current = new ProjectExplorerPanel(panel, context);
    return ProjectExplorerPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.extensionUri = context.extensionUri;
    this.state = context.workspaceState;
    this.storageDir = context.globalStorageUri.fsPath;
    this.trees = new Map<TreeId, TreeRuntime>([
      ["a", this.newTree("a")],
      ["b", this.newTree("b")],
    ]);

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        this.handleMessage(raw);
      },
      null,
      this.disposables
    );

    // El foco de la ventana vuelve a leer git (nada de sondeos cada 2 s).
    vscode.window.onDidChangeWindowState(
      (e) => {
        if (!e.focused || this.disposed) {
          return;
        }
        for (const st of this.trees.values()) {
          if (st.root) {
            this.queueGitRefresh(st);
          }
        }
      },
      null,
      this.disposables
    );

    // Guardar un documento dentro de una raíz refresca su git (por si el watcher no llegó).
    vscode.workspace.onDidSaveTextDocument(
      (doc) => {
        if (this.disposed) {
          return;
        }
        for (const st of this.trees.values()) {
          if (st.root && this.insideRoot(st, doc.uri.fsPath)) {
            this.queueGitRefresh(st);
          }
        }
      },
      null,
      this.disposables
    );

    void this.init();
  }

  private newTree(id: TreeId): TreeRuntime {
    return {
      id,
      root: "",
      label: "",
      tree: null,
      showHidden: false,
      sort: "size",
      sortDir: "desc",
      filter: "all",
      query: "",
      expanded: new Set<string>([""]),
      scan: { state: "idle", files: 0, dirs: 0, bytes: 0, truncated: false },
      git: null,
      gitFiles: new Map(),
      resultIds: null,
      scanGen: 0,
      searchGen: 0,
      gitGen: 0,
      scanAbort: null,
      contentAbort: null,
      contentPending: false,
      searchTimer: null,
      gitRefreshTimer: null,
      watchers: new Map(),
      watchDirty: new Set(),
      watchTimer: null,
      rescanQueue: [],
      rescanSet: new Set(),
      rescanBusy: false,
      rescanWaiters: [],
      suppressUntil: 0,
      gitQueue: [],
      gitRunning: false,
    };
  }

  // ---------------------------------------------------------------- inicio

  private async init(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const persisted = await this.readRoots();
    const a = await this.pickExisting(persisted.a) ?? folders[0]?.uri.fsPath ?? "";
    const b =
      (await this.pickExisting(persisted.b)) ??
      (folders.length > 1 ? folders[1].uri.fsPath : "");

    const savedLayout = this.state.get<string>(KEY_LAYOUT);
    const savedSplit = this.state.get<number>(KEY_SPLIT);
    this.split = clampRatio(savedSplit);
    const savedHidden = this.state.get<unknown>(KEY_HIDDEN);
    const hidden = isRecord(savedHidden) ? savedHidden : {};
    const savedSort = this.state.get<unknown>(KEY_SORT);
    const sortRec = isRecord(savedSort) ? savedSort : {};
    const savedSortDir = this.state.get<unknown>(KEY_SORT_DIR);
    const sortDirRec = isRecord(savedSortDir) ? savedSortDir : {};

    for (const id of ["a", "b"] as TreeId[]) {
      const st = this.trees.get(id) as TreeRuntime;
      st.showHidden = readBool(hidden[id], false);
      const key: unknown = sortRec[id];
      const dir: unknown = sortDirRec[id];
      st.sort = isSortKey(key) ? key : "size";
      st.sortDir = isSortDir(dir) ? dir : "desc";
      st.expanded = this.readExpanded(id);
      const root = id === "a" ? a : b;
      if (root) {
        this.setRootRuntime(st, root);
      }
    }

    this.layout = savedLayout === "two" ? "two" : "one";
    if (!a) {
      // Sin primera carpeta ni raíz guardada: pedimos una, es el caso raro.
      const picked = await this.pickFolder();
      if (picked) {
        const st = this.trees.get("a") as TreeRuntime;
        this.setRootRuntime(st, picked);
        await this.saveRoots();
      }
    }
    if (this.disposed) {
      return;
    }
    const bSt = this.trees.get("b") as TreeRuntime;
    if (this.layout === "two" && !bSt.root) {
      // Layout de dos columnas guardado sin segunda raíz: se pide la carpeta.
      const picked = await this.pickFolder();
      if (picked) {
        this.setRootRuntime(bSt, picked);
        await this.saveRoots();
      } else {
        this.layout = "one";
        void this.state.update(KEY_LAYOUT, "one");
      }
    }
    if (this.disposed) {
      return;
    }
    for (const id of ["a", "b"] as TreeId[]) {
      const st = this.trees.get(id) as TreeRuntime;
      if (!st.root) {
        this.postView(st, []);
        continue;
      }
      // La segunda columna no se escanea mientras está fuera del layout:
      // `setLayout("two")` la pone al día cuando toca entrar.
      if (id === "b" && this.layout !== "two") {
        this.postView(st, []);
        continue;
      }
      void this.scanTree(st);
    }
  }

  /** Raíces persistidas validadas: solo carpetas que siguen existiendo. */
  private async readRoots(): Promise<{ a: string; b?: string }> {
    const raw = this.state.get<unknown>(KEY_ROOTS);
    const rec = isRecord(raw) ? raw : {};
    const a = await this.pickExisting(rec.a);
    const b = await this.pickExisting(rec.b);
    return { a: a ?? "", b: b ?? undefined };
  }

  private async pickExisting(value: unknown): Promise<string | undefined> {
    if (typeof value !== "string" || !value.trim()) {
      return undefined;
    }
    const abs = path.resolve(value);
    try {
      const stt = await stat(abs);
      return stt.isDirectory() ? abs : undefined;
    } catch {
      return undefined;
    }
  }

  private readExpanded(id: TreeId): Set<string> {
    const raw = this.state.get<unknown>(KEY_EXPANDED);
    const rec = isRecord(raw) ? raw : {};
    const list = Array.isArray(rec[id]) ? (rec[id] as unknown[]) : [];
    const out = new Set<string>([""]);
    for (const item of list) {
      if (typeof item !== "string") {
        continue;
      }
      const rel = normalizeRel(item);
      if (rel !== undefined && rel !== "") {
        out.add(rel);
      }
      if (out.size >= MAX_EXPANDED) {
        break;
      }
    }
    return out;
  }

  private persistExpanded(st: TreeRuntime): void {
    const raw = this.state.get<unknown>(KEY_EXPANDED);
    const base = isRecord(raw) ? { ...raw } : {};
    const list: string[] = [];
    for (const rel of st.expanded) {
      if (rel === "") {
        continue;
      }
      if (st.tree?.hasDir(rel)) {
        list.push(rel);
      }
      if (list.length >= MAX_EXPANDED) {
        break;
      }
    }
    base[st.id] = list;
    void this.state.update(KEY_EXPANDED, base);
  }

  /** Orden por árbol persistido con la misma forma que `KEY_HIDDEN` (`{a:"size",b:"name"}`). */
  private persistSort(st: TreeRuntime): void {
    const raw = this.state.get<unknown>(KEY_SORT);
    const base = isRecord(raw) ? { ...raw } : {};
    base[st.id] = st.sort;
    void this.state.update(KEY_SORT, base);
  }

  private persistSortDir(st: TreeRuntime): void {
    const raw = this.state.get<unknown>(KEY_SORT_DIR);
    const base = isRecord(raw) ? { ...raw } : {};
    base[st.id] = st.sortDir;
    void this.state.update(KEY_SORT_DIR, base);
  }

  private async saveRoots(): Promise<void> {
    const a = (this.trees.get("a") as TreeRuntime).root;
    const b = (this.trees.get("b") as TreeRuntime).root;
    await this.state.update(KEY_ROOTS, b ? { a, b } : { a });
  }

  private setRootRuntime(st: TreeRuntime, rootAbs: string): void {
    st.root = path.resolve(rootAbs);
    st.label = path.basename(st.root) || st.root;
  }

  // ---------------------------------------------------------------- escaneo

  /** Escaneo completo del árbol, cancelable por generación. */
  private async scanTree(st: TreeRuntime): Promise<void> {
    if (!st.root || this.disposed) {
      return;
    }
    st.scanAbort?.abort();
    st.contentAbort?.abort();
    st.contentAbort = null;
    st.contentPending = false;
    // El escaneo completo manda: los rescans en cola ya no hacen nada.
    this.cancelRescans(st);
    // Los ids del árbol viejo dejan de valer: la búsqueda se rehace desde cero.
    st.searchGen += 1;
    st.resultIds = null;
    const gen = ++st.scanGen;
    const controller = new AbortController();
    st.scanAbort = controller;
    st.tree = null;
    st.gitFiles = new Map();
    st.scan = { state: "scanning", files: 0, dirs: 0, bytes: 0, truncated: false };
    this.postScan(st, "start");
    const tree = new Tree(st.root);
    try {
      const sc = await scanDirectory(st.root, (e) => tree.add(e), {
        signal: controller.signal,
        maxEntries: MAX_ENTRIES,
        onProgress: (c) => {
          if (gen !== st.scanGen || this.disposed) {
            return;
          }
          st.scan = { ...st.scan, files: c.files, dirs: c.dirs, bytes: c.bytes };
          this.postScan(st, "progress");
        },
      });
      if (gen !== st.scanGen || this.disposed) {
        return;
      }
      tree.entries.get(tree.rootId)!.name = st.label;
      st.tree = tree;
      st.scan = {
        state: "done",
        files: sc.files,
        dirs: sc.dirs,
        bytes: sc.bytes,
        truncated: sc.truncated,
      };
      if (sc.truncated) {
        this.status(st, `Escaneo cortado: tope de ${MAX_ENTRIES} entradas.`, "info");
      }
      this.postScan(st, "done");
      this.pruneExpanded(st);
      this.persistExpanded(st);
      this.syncWatchers(st);
      this.recomputeView(st);
      this.resumeSearch(st);
      void this.loadGit(st);
    } catch (err) {
      if (gen !== st.scanGen || this.disposed) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      st.scan = {
        state: "error",
        files: 0,
        dirs: 0,
        bytes: 0,
        truncated: false,
        error: message,
      };
      this.postScan(st, "error", message);
      this.status(st, "No se pudo escanear la carpeta.", "error");
    }
  }

  /**
   * Rescan incremental de un subdirectorio (padre de una operación o aviso del watcher).
   * Encola `rel` y espera a que la cola del árbol quede vacía: así nunca hay dos
   * mutaciones a la vez sobre el mismo `Tree` y los avisos seguidos se agrupan.
   */
  private enqueueRescan(st: TreeRuntime, rel: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!st.rescanSet.has(rel)) {
      st.rescanSet.add(rel);
      st.rescanQueue.push(rel);
    }
    this.drainRescan(st);
    return new Promise<void>((resolve) => {
      st.rescanWaiters.push(resolve);
    });
  }

  /** Un solo drenaje por árbol. Al vaciar la cola resuelve todas las esperas. */
  private drainRescan(st: TreeRuntime): void {
    if (st.rescanBusy) {
      return;
    }
    st.rescanBusy = true;
    void (async () => {
      try {
        while (st.rescanQueue.length > 0 && !this.disposed) {
          const rel = st.rescanQueue.shift() as string;
          st.rescanSet.delete(rel);
          try {
            await this.rescanSubtreeNow(st, rel);
          } catch {
            // Un rescan que falla no debe parar la cola: se pasa al siguiente aviso.
          }
          // Los vigilantes van con el árbol: se reponen los que se cerraron para mutar
          // (Windows no deja borrar, mover ni renombrar una carpeta con su handle abierto).
          this.syncWatchers(st);
          // El subárbol nuevo trae ids distintos: la búsqueda activa se rehace entera.
          this.resumeSearch(st);
        }
      } finally {
        st.rescanBusy = false;
        this.releaseRescanWaiters(st);
        // Algo pudo entrar justo al cerrar el bucle: no se pierde el aviso.
        if (st.rescanQueue.length > 0 && !this.disposed) {
          this.drainRescan(st);
        }
      }
    })();
  }

  private releaseRescanWaiters(st: TreeRuntime): void {
    const waiters = st.rescanWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /** El escaneo completo manda: tira la cola de rescans y suelta a quien esperara. */
  private cancelRescans(st: TreeRuntime): void {
    st.rescanQueue.length = 0;
    st.rescanSet.clear();
    this.releaseRescanWaiters(st);
  }

  /** Cuerpo del rescan incremental. Solo lo llama `drainRescan`. */
  private async rescanSubtreeNow(st: TreeRuntime, rel: string): Promise<void> {
    const tree = st.tree;
    if (!tree || this.disposed || !st.root) {
      return;
    }
    if (st.scan.state === "scanning") {
      // Hay un escaneo completo en vuelo: él traerá el cambio.
      return;
    }
    // Este `rel` queda al día: quita el aviso pendiente (igual si lo trajo otra vía).
    st.watchDirty.delete(rel);
    if (rel === "") {
      tree.removeSubtreeContents(tree.rootId);
      await scanDirectory(st.root, (e) => tree.add(e), { relPrefix: "", maxEntries: MAX_ENTRIES });
      if (this.disposed || st.tree !== tree) {
        return;
      }
      this.pruneExpanded(st);
      this.syncWatchers(st);
      this.recomputeView(st);
      return;
    }
    const dirId = tree.idByRel.get(rel);
    const entry = dirId === undefined ? undefined : tree.entries.get(dirId);
    const abs = this.relAbs(st, rel);
    if (!abs) {
      return;
    }
    let isDir = false;
    let exists = false;
    try {
      const stt = await stat(abs);
      exists = true;
      isDir = stt.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      // Desaparecido del disco: se poda y ya está (el refresco git lo marcará si procede).
      if (entry) {
        tree.removeSubtree(rel);
      }
      this.recomputeView(st);
      return;
    }
    if (!isDir) {
      // Fichero o enlace: se reemplaza lo que hubiera en esa ruta.
      if (entry) {
        tree.removeSubtree(rel);
      }
      try {
        const lst = await lstat(abs);
        tree.add({
          rel,
          parentRel: parentOfRel(rel),
          name: baseName(rel),
          kind: lst.isSymbolicLink() ? "link" : "file",
          size: lst.isSymbolicLink() ? 0 : lst.size,
          mtime: lst.mtimeMs,
          error: false,
        });
      } catch {
        // Ilegible: queda como error con tamaño 0.
        tree.add({
          rel,
          parentRel: parentOfRel(rel),
          name: baseName(rel),
          kind: "file",
          size: 0,
          mtime: Date.now(),
          error: true,
        });
      }
      this.recomputeView(st);
      return;
    }
    // Directorio: se poda el interior y se vuelve a llenar.
    tree.removeSubtree(rel);
    tree.add({
      rel,
      parentRel: parentOfRel(rel),
      name: baseName(rel),
      kind: "dir",
      size: 0,
      mtime: 0,
      error: false,
    });
    await scanDirectory(abs, (e) => tree.add(e), {
      relPrefix: rel,
      maxEntries: MAX_ENTRIES,
    });
    if (this.disposed || st.tree !== tree) {
      return;
    }
    this.pruneExpanded(st);
    this.syncWatchers(st);
    this.recomputeView(st);
  }

  /** Deja solo los `expanded` que siguen existiendo como carpetas (tope 500). */
  private pruneExpanded(st: TreeRuntime): void {
    const tree = st.tree;
    if (!tree) {
      return;
    }
    for (const rel of [...st.expanded]) {
      if (rel !== "" && !tree.hasDir(rel)) {
        st.expanded.delete(rel);
      }
    }
  }

  // ---------------------------------------------------------------- git

  private async loadGit(st: TreeRuntime): Promise<void> {
    const gen = ++st.gitGen;
    if (!st.root || this.disposed) {
      st.git = null;
      st.gitFiles = new Map();
      this.postGit(st);
      return;
    }
    try {
      const tree = st.tree;
      const state = await readRepoState(st.root, (rel) => tree?.idByRel.has(rel) ?? false);
      if (gen !== st.gitGen || this.disposed) {
        return;
      }
      st.git = state ? state.info : null;
      st.gitFiles = state ? state.files : new Map();
    } catch (err) {
      if (gen !== st.gitGen || this.disposed) {
        return;
      }
      st.git = null;
      st.gitFiles = new Map();
      const message = err instanceof Error ? err.message : String(err);
      if (!/no está instalado/i.test(message)) {
        this.status(st, `Git: ${message}`, "error");
      }
    }
    this.postGit(st);
    this.recomputeView(st);
  }

  /** Refresco git con mini-debounce (guarda de guardado y de foco). */
  private queueGitRefresh(st: TreeRuntime): void {
    if (st.gitRefreshTimer) {
      clearTimeout(st.gitRefreshTimer);
    }
    st.gitRefreshTimer = setTimeout(() => {
      st.gitRefreshTimer = null;
      if (!this.disposed) {
        void this.loadGit(st);
      }
    }, 400);
  }

  /** Encola una acción git por árbol: FIFO, con estado `busy` y refresco al terminar. */
  private enqueueGit(
    st: TreeRuntime,
    action: GitActionKind,
    branch?: string,
    message?: string,
    rel?: string
  ): void {
    if (!st.root) {
      this.op(st, false, "Este árbol no tiene carpeta raíz.");
      return;
    }
    const text = `git · ${GIT_LABELS[action] ?? action}`;
    st.gitQueue.push({ action, branch, message, rel, text });
    this.flushGitQueue(st);
  }

  private flushGitQueue(st: TreeRuntime): void {
    if (st.gitRunning) {
      return;
    }
    const job = st.gitQueue.shift();
    if (!job) {
      this.postStatus(st);
      return;
    }
    st.gitRunning = true;
    // El texto del trabajo en vuelo es el que ve el usuario mientras dura la cola.
    this.postStatus(st, job.text, "info");
    void this.runGitJob(st, job)
      .catch(() => undefined)
      .finally(() => {
        st.gitRunning = false;
        this.flushGitQueue(st);
      });
  }

  private async runGitJob(
    st: TreeRuntime,
    job: { action: GitActionKind; branch?: string; message?: string; rel?: string; text: string }
  ): Promise<void> {
    if (this.disposed || !st.root) {
      return;
    }
    let ok = true;
    let text = "";
    try {
      if (job.action === "refresh") {
        await this.loadGit(st);
        return;
      }
      if (job.action === "push" && st.git === null) {
        // Sin estado git leído todavía: se lee antes de decidir el alta de upstream.
        await this.loadGit(st);
      }
      const needsConfirm = job.action === "push" && !st.git?.upstream;
      if (needsConfirm && st.git) {
        const branch = st.git.branch;
        if (!branch || branch === "HEAD") {
          throw new GitError("HEAD desprendido: crea una rama antes de subir.");
        }
        const answer = await vscode.window.showWarningMessage(
          `La rama «${branch}» no tiene upstream. ¿Subir con «git push -u origin ${branch}»?`,
          { modal: true },
          "SUBIR"
        );
        if (answer !== "SUBIR") {
          this.op(st, false, "Push cancelado.");
          return;
        }
      }
      if (job.action === "discard") {
        // El estado puede haber cambiado mientras el trabajo estaba en cola: se comprueba aquí.
        const rel = job.rel ?? "";
        if (!rel) {
          throw new GitError("Falta la ruta del fichero.");
        }
        let state = st.gitFiles.get(rel)?.state;
        if (state === undefined) {
          // Sin estado leído (o caducado): se refresca antes de decidir.
          await this.loadGit(st);
          state = st.gitFiles.get(rel)?.state;
        }
        if (state !== "modified") {
          throw new GitError("Solo se descartan cambios de ficheros modificados.");
        }
        const answer = await vscode.window.showWarningMessage(
          `¿Descartar los cambios locales de «${path.basename(rel)}»?`,
          { modal: true },
          "DESCARTAR"
        );
        if (answer !== "DESCARTAR") {
          this.op(st, false, "Descartar cancelado.");
          return;
        }
      }
      await gitAction(st.root, job.action, {
        branch: job.branch,
        message: job.message,
        rel: job.rel,
        upstream: st.git?.upstream ?? null,
        branchName: st.git?.branch ?? "",
      });
      text = `git ${GIT_LABELS[job.action] ?? job.action} terminado.`;
    } catch (err) {
      ok = false;
      text = err instanceof GitError || err instanceof OpError ? err.message : String(err);
    }
    if (this.disposed) {
      return;
    }
    this.suppress(st);
    if (job.action === "checkout" || job.action === "pull") {
      // Son las dos acciones que cambian el árbol de trabajo.
      void this.scanTree(st);
    } else if (job.action === "discard" && job.rel) {
      // `git restore` cambia el contenido: hay que recontar el tamaño del padre.
      await this.afterMutation(st, parentOfRel(job.rel));
    } else {
      await this.loadGit(st);
      this.recomputeView(st);
    }
    this.op(st, ok, text || (ok ? "Hecho." : "Error."));
  }

  // ---------------------------------------------------------------- vistas

  /**
   * Recalcula las filas visibles (árbol o resultados) y manda `view`.
   * Los contados del pie viajan con `scan`: aquí solo se lee el truncado.
   */
  private recomputeView(st: TreeRuntime): void {
    const tree = st.tree;
    if (!tree) {
      this.postView(st, []);
      return;
    }
    const wantsFilter = st.filter !== "all";
    const wantsResults = st.query.trim() !== "" || wantsFilter;
    if (wantsFilter && st.scan.state !== "done" && st.scan.state !== "error") {
      // Sin estado git todavía: el filtro no puede resolver nada aún.
      this.status(st, "Esperando el estado git…", "info");
    }
    const out = computeRows({
      tree,
      expanded: st.expanded,
      showHidden: st.showHidden,
      sort: st.sort,
      sortDir: st.sortDir,
      gitMap: st.gitFiles,
      filter: st.filter,
      resultIds: wantsResults ? st.resultIds ?? new Set<number>() : undefined,
      limit: ROW_LIMIT,
    });
    // El corte de filas se suma al truncado del propio escaneo: la webview lo pinta desde `view`.
    this.postView(st, out.rows, out.truncated || st.scan.truncated);
  }

  // ---------------------------------------------------------------- mensajes

  private handleMessage(raw: unknown): void {
    const message = parseIncoming(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.postInit();
        for (const st of this.trees.values()) {
          this.recomputeView(st);
        }
        return;
      case "setLayout":
        void this.setLayout(message.layout);
        return;
      case "setSplit":
        this.split = clampRatio(message.ratio);
        void this.state.update(KEY_SPLIT, this.split);
        this.postInit();
        return;
      case "transfer": {
        const from = this.trees.get(message.fromTree);
        const to = this.trees.get(message.toTree);
        if (!from || !to) {
          return;
        }
        void this.doTransfer(from, message.fromRel, to, message.toDir, message.mode);
        return;
      }
      default: {
        const st = this.trees.get(message.treeId);
        if (!st) {
          return;
        }
        void this.dispatchTree(st, message);
        return;
      }
    }
  }

  private async dispatchTree(
    st: TreeRuntime,
    message: Exclude<
      IncomingMessage,
      { type: "ready" } | { type: "setLayout" } | { type: "setSplit" } | { type: "transfer" }
    >
  ): Promise<void> {
    switch (message.type) {
      case "chooseRoot": {
        const picked = await this.pickFolder();
        if (!picked || this.disposed) {
          return;
        }
        this.teardownScan(st);
        this.setRootRuntime(st, picked);
        await this.saveRoots();
        this.postInit();
        void this.scanTree(st);
        return;
      }
      case "toggleHidden": {
        st.showHidden = !st.showHidden;
        const raw = this.state.get<unknown>(KEY_HIDDEN);
        const base = isRecord(raw) ? { ...raw } : {};
        base[st.id] = !st.showHidden;
        void this.state.update(KEY_HIDDEN, base);
        // Con búsqueda activa, los recién visibles (o los que dejan de estarlo)
        // cambian el conjunto de coincidencias: se rehace en vez de recalcular solo.
        this.resumeSearch(st);
        this.recomputeView(st);
        return;
      }
      case "setSort": {
        if (st.sort !== message.sort) {
          // Cambio de clave: sentido por defecto (nombre A→Z; tamaño y fecha, lo primero más).
          st.sort = message.sort;
          st.sortDir = message.sort === "name" ? "asc" : "desc";
        }
        // Misma clave: conserva el sentido actual (la conmutación va por `setSortDir`).
        this.persistSort(st);
        this.persistSortDir(st);
        // `postInit` reenvía el meta: sin él la webview se queda con el orden viejo (botón atascado).
        this.postInit();
        this.recomputeView(st);
        return;
      }
      case "setSortDir": {
        st.sortDir = message.dir;
        this.persistSortDir(st);
        this.postInit();
        this.recomputeView(st);
        return;
      }
      case "expand": {
        if (this.canExpand(st, message.rel)) {
          st.expanded.add(message.rel);
          this.persistExpanded(st);
          this.syncWatchers(st);
          this.recomputeView(st);
        }
        return;
      }
      case "collapse": {
        st.expanded.delete(message.rel);
        this.persistExpanded(st);
        this.syncWatchers(st);
        this.recomputeView(st);
        return;
      }
      case "refresh": {
        void this.scanTree(st);
        return;
      }
      case "search": {
        this.scheduleSearch(st, message.query);
        return;
      }
      case "setFilter": {
        st.filter = message.filter;
        if (st.filter !== "all" && !st.git && st.scan.state === "done") {
          void this.loadGit(st);
        }
        this.recomputeView(st);
        return;
      }
      case "open": {
        await this.openRel(st, message.rel);
        return;
      }
      case "reveal": {
        const entry = st.tree?.getEntry(message.rel);
        if (!entry || entry.kind === "missing") {
          this.op(st, false, "El fichero ya no existe en disco.");
          return;
        }
        const abs = this.relAbs(st, message.rel);
        if (!abs) {
          this.op(st, false, "Ruta fuera de la raíz.");
          return;
        }
        try {
          await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(abs));
        } catch {
          this.op(st, false, "No se pudo revelar en el explorador del sistema.");
        }
        return;
      }
      case "delete": {
        await this.deleteRel(st, message.rel);
        return;
      }
      case "git": {
        this.handleGit(st, message.action, message.branch, message.message, message.rel);
        return;
      }
      case "rename": {
        await this.renameRel(st, message.rel);
        return;
      }
      case "diff": {
        await this.diffRel(st, message.rel);
        return;
      }
      case "newFile": {
        await this.newFileAt(st, message.parentRel);
        return;
      }
    }
  }

  private handleGit(
    st: TreeRuntime,
    action: GitActionKind,
    branch?: string,
    message?: string,
    relArg?: string
  ): void {
    if (!st.root) {
      this.op(st, false, "Este árbol no tiene carpeta raíz.");
      return;
    }
    if (action === "checkout") {
      if (!branch) {
        this.op(st, false, "Ninguna rama seleccionada.");
        return;
      }
      const known = st.git?.branches ?? [];
      if (!known.includes(branch)) {
        this.op(st, false, `La rama «${branch}» no está en la lista.`);
        return;
      }
      this.enqueueGit(st, action, branch);
      return;
    }
    if (action === "createBranch") {
      const b = (branch ?? "").trim();
      if (!b || b.startsWith("-") || !BRANCH_RE.test(b)) {
        this.op(st, false, "Nombre de rama no válido.");
        return;
      }
      this.enqueueGit(st, action, b);
      return;
    }
    if (action === "commit") {
      const m = (message ?? "").trim().slice(0, 2000);
      if (!m) {
        this.op(st, false, "El mensaje del commit está vacío.");
        return;
      }
      this.enqueueGit(st, action, undefined, m);
      return;
    }
    if (GIT_PATH_ACTIONS.has(action)) {
      const rel = (relArg ?? "").trim();
      if (!rel) {
        this.op(st, false, "Falta la ruta del fichero.");
        return;
      }
      const entry = st.tree?.getEntry(rel);
      if (!entry) {
        this.op(st, false, "La ruta ya no existe en el árbol.");
        return;
      }
      if (entry.kind === "link") {
        this.op(st, false, "No se preparan ni descartan enlaces.");
        return;
      }
      if (entry.kind !== "file") {
        // Carpetas y ficheros borrados: `git add -A` de la raíz sigue disponible.
        this.op(st, false, "Solo se preparan o descartan ficheros.");
        return;
      }
      this.enqueueGit(st, action, undefined, undefined, rel);
      return;
    }
    this.enqueueGit(st, action);
  }

  // ---------------------------------------------------------------- operaciones

  private async openRel(st: TreeRuntime, rel: string): Promise<void> {
    const entry = st.tree?.getEntry(rel);
    if (!entry) {
      this.op(st, false, `«${baseName(rel)}» ya no existe en disco.`);
      return;
    }
    if (entry.kind === "missing") {
      this.op(st, false, "El fichero fue borrado por git.");
      return;
    }
    if (entry.kind === "dir") {
      // Abrir una carpeta = expandirla (vscode.open sobre un directorio no es útil aquí).
      st.expanded.add(rel);
      this.persistExpanded(st);
      this.syncWatchers(st);
      this.recomputeView(st);
      return;
    }
    const abs = this.relAbs(st, rel);
    if (!abs) {
      this.op(st, false, "Ruta fuera de la raíz.");
      return;
    }
    try {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs));
    } catch {
      this.op(st, false, `No se pudo abrir «${entry.name}».`);
    }
  }

  private async deleteRel(st: TreeRuntime, rel: string): Promise<void> {
    const tree = st.tree;
    const entry = tree?.getEntry(rel);
    if (!tree || !entry) {
      this.op(st, false, "La ruta ya no existe en el árbol.");
      return;
    }
    if (entry.kind === "missing") {
      this.op(st, false, "Ese fichero ya no está en disco.");
      return;
    }
    const abs = await this.resolve(st, rel);
    if (!abs || this.disposed) {
      return;
    }
    const isDir = entry.kind === "dir";
    const count = isDir ? await countElements(abs) : 1;
    const many = isDir ? ` (${count}${count >= 200 ? "+" : ""} elementos)` : "";
    const what = isDir ? `la carpeta «${entry.name}»` : `«${entry.name}»`;
    const answer = await vscode.window.showWarningMessage(
      `¿Mover a la papelera ${what}${many}?`,
      { modal: true },
      "Mover a la papelera"
    );
    if (answer !== "Mover a la papelera" || this.disposed) {
      return;
    }
    this.suppress(st);
    // El vigilante de la carpeta (si está expandida) bloquearía el borrado en Windows.
    this.closeWatchersUnder(st, rel);
    try {
      let usedTrash = true;
      let trashProblem = "";
      try {
        await deletePath(abs, true);
      } catch (err) {
        if (err instanceof OpError && /cancelado por el usuario/i.test(err.message)) {
          // Cancelación del diálogo de papelera: no se insiste con borrado permanente.
          this.op(st, false, "Borrado cancelado.");
          return;
        }
        usedTrash = false;
        trashProblem = err instanceof Error ? err.message : String(err);
        const again = await vscode.window.showWarningMessage(
          `La papelera falló (${trashProblem}). Borrar permanentemente ${entry.name}${many}?`,
          { modal: true },
          "Borrar permanentemente"
        );
        if (again !== "Borrar permanentemente" || this.disposed) {
          this.op(st, false, "Borrado cancelado.");
          return;
        }
        try {
          await deletePath(abs, false);
        } catch (err2) {
          this.op(st, false, err2 instanceof Error ? err2.message : String(err2));
          return;
        }
      }
      this.op(
        st,
        true,
        usedTrash
          ? `«${entry.name}» movido a la papelera.`
          : `«${entry.name}» borrado permanentemente.`
      );
      await this.afterMutation(st, parentOfRel(rel));
    } finally {
      // Tras cerrar los vigilantes hay que reabrirlos siempre: cancelación, papelera
      // que falla o error de borrado dejaban la carpeta expandida sin avisos.
      this.syncWatchers(st);
    }
  }

  private async doTransfer(
    from: TreeRuntime,
    fromRel: string,
    to: TreeRuntime,
    toDirRel: string,
    mode: "copy" | "move"
  ): Promise<void> {
    const srcEntry = from.tree?.getEntry(fromRel);
    if (!srcEntry || srcEntry.kind === "missing") {
      this.op(from, false, "El origen ya no existe en disco.");
      return;
    }
    if (srcEntry.kind === "link") {
      this.op(from, false, "No se copian ni mueven enlaces.");
      return;
    }
    if (!from.root || !to.root) {
      this.op(from, false, "Falta la carpeta raíz en alguno de los árboles.");
      return;
    }
    if (gitBusy(from) || gitBusy(to)) {
      this.op(from, false, "Hay una operación git en curso.");
      return;
    }
    const srcAbs = await this.resolve(from, fromRel);
    if (!srcAbs) {
      return;
    }
    // Destino: `toDirRel` "" = raíz del árbol destino (resuelta con las mismas garantías).
    let destDirAbs: string | undefined;
    if (toDirRel === "") {
      destDirAbs = await this.resolve(to, "", true);
      if (!destDirAbs) {
        return;
      }
    } else {
      const destEntry = to.tree?.getEntry(toDirRel);
      if (!destEntry || destEntry.kind !== "dir") {
        this.op(to, false, "La carpeta de destino no existe.");
        return;
      }
      destDirAbs = await this.resolve(to, toDirRel, true);
      if (!destDirAbs) {
        return;
      }
    }
    const destAbs = path.join(destDirAbs, path.basename(srcAbs));
    const blocked = await this.transferBlocker(srcAbs, destDirAbs);
    if (blocked) {
      this.op(to, false, blocked);
      return;
    }
    if (samePath(srcAbs, destAbs)) {
      // Dos árboles con la misma raíz (o pegar un elemento sobre sí mismo).
      this.op(to, false, "El destino es el propio origen.");
      return;
    }
    this.suppress(from);
    this.suppress(to);
    // En Windows el handle del vigilante de la carpeta origen bloquearía el movimiento.
    this.closeWatchersUnder(from, fromRel);
    let ok = true;
    let text = "";
    try {
      if (mode === "copy") {
        await copyPath(srcAbs, destAbs);
        text = `Copiado «${srcEntry.name}» a «${to.label}».`;
      } else {
        await movePath(srcAbs, destAbs);
        text = `Movido «${srcEntry.name}» a «${to.label}».`;
      }
    } catch (err) {
      ok = false;
      text = err instanceof Error ? err.message : String(err);
    }
    if (this.disposed) {
      return;
    }
    this.op(from, ok, text);
    if (to !== from) {
      this.op(to, ok, text);
    }
    // Se reescanean los dos padres afectados (origen y destino).
    const fromParent = parentOfRel(fromRel);
    await this.afterMutation(from, fromParent);
    if (to !== from) {
      await this.afterMutation(to, toDirRel);
    } else if (toDirRel !== fromParent) {
      await this.afterMutation(from, toDirRel);
    }
  }

  /**
   * Mensaje de error si el destino es la propia carpeta o un descendiente suyo.
   * Compara la ruta lógica y, cuando existe, la real: así caen también las raíces
   * solapadas o enlazadas de los dos árboles. Subir a un ancestro sí se deja
   * (la colisión de nombre la resuelve `movePath`).
   */
  private async transferBlocker(srcAbs: string, destDirAbs: string): Promise<string | null> {
    const pairs: Array<[string, string]> = [[srcAbs, destDirAbs]];
    try {
      pairs.push([await realpath(srcAbs), await realpath(destDirAbs)]);
    } catch {
      // Alguna de las dos ya no existe: con la comparación lógica basta.
    }
    for (const [src, destDir] of pairs) {
      if (samePath(src, destDir)) {
        return "El destino es la propia carpeta de origen.";
      }
      if (isWithin(src, destDir)) {
        return "No se puede mover una carpeta dentro de sí misma.";
      }
    }
    return null;
  }

  /**
   * Cierra los vigilantes de `rel` y de lo que haya debajo. En Windows un handle
   * abierto sobre una carpeta (el `fs.watch` de una carpeta expandida) impide
   * borrarla, moverla o renombrarla: `EPERM`. Se vuelven a abrir con `syncWatchers`
   * al terminar el reescaneo.
   */
  private closeWatchersUnder(st: TreeRuntime, rel: string): void {
    const prefijo = `${rel}/`;
    for (const [key, watcher] of [...st.watchers]) {
      if (key === rel || (rel !== "" && key.startsWith(prefijo))) {
        try {
          watcher.close();
        } catch {
          // Ya estaba cerrado.
        }
        st.watchers.delete(key);
      }
    }
    for (const dirty of [...st.watchDirty]) {
      if (dirty === rel || (rel !== "" && dirty.startsWith(prefijo))) {
        st.watchDirty.delete(dirty);
      }
    }
  }

  /** Rescan del padre afectado + refresco git + vista. */
  private async afterMutation(st: TreeRuntime, parentRel: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.enqueueRescan(st, parentRel);
    await this.loadGit(st);
    this.recomputeView(st);
  }

  /**
   * Renombra dentro del propio padre. Pide el nombre en un `showInputBox`, no
   * sobrescribe y, si es una carpeta, reescribe el prefijo de las expandidas.
   */
  private async renameRel(st: TreeRuntime, rel: string): Promise<void> {
    const tree = st.tree;
    const entry = tree?.getEntry(rel);
    if (!tree || !entry) {
      this.op(st, false, "La ruta ya no existe en el árbol.");
      return;
    }
    if (entry.kind === "missing") {
      this.op(st, false, "Ese fichero ya no está en disco.");
      return;
    }
    const abs = await this.resolve(st, rel);
    if (!abs || this.disposed) {
      return;
    }
    const propuesta = await vscode.window.showInputBox({
      prompt: `Nuevo nombre para «${entry.name}»`,
      value: entry.name,
      ignoreFocusOut: true,
      validateInput: (value: string) => validateEntryName(value),
    });
    if (propuesta === undefined) {
      // Cancelado: no se toca nada.
      return;
    }
    const problem = validateEntryName(propuesta);
    const name = (propuesta ?? "").trim();
    if (problem || !name) {
      this.op(st, false, problem ?? "Nombre no válido.");
      return;
    }
    const parentRel = parentOfRel(rel);
    const destAbs = path.join(path.dirname(abs), name);
    if (samePath(abs, destAbs)) {
      this.op(st, false, "Ya se llama así.");
      return;
    }
    if (await existsReal(destAbs)) {
      this.op(st, false, `«${name}» ya existe. Sin sobrescribir.`);
      return;
    }
    this.suppress(st);
    // En Windows el handle del vigilante de la propia carpeta bloquea el renombrado.
    this.closeWatchersUnder(st, rel);
    try {
      try {
        await vscode.workspace.fs.rename(vscode.Uri.file(abs), vscode.Uri.file(destAbs), {
          overwrite: false,
        });
      } catch (err) {
        this.op(st, false, err instanceof Error ? err.message : String(err));
        return;
      }
      const eraCarpeta = entry.kind === "dir";
      if (eraCarpeta) {
        // Las carpetas abiertas debajo cambian de prefijo; si no, se pierde su estado.
        const newRel = parentRel ? `${parentRel}/${name}` : name;
        const rebuilt = new Set<string>();
        for (const open of st.expanded) {
          if (open === rel) {
            rebuilt.add(newRel);
          } else if (open.startsWith(`${rel}/`)) {
            rebuilt.add(newRel + open.slice(rel.length));
          } else {
            rebuilt.add(open);
          }
        }
        st.expanded = rebuilt;
      }
      this.op(st, true, `Renombrado a «${name}».`);
      await this.afterMutation(st, parentRel);
      if (eraCarpeta) {
        // Se guarda DESPUÉS del reescaneo: `persistExpanded` descarta las rutas que
        // el árbol todavía no conoce, y con el árbol viejo se quedaban fuera las nuevas.
        this.persistExpanded(st);
      }
    } finally {
      // Pase lo que pase (error, cancelación, retorno): los vigilantes de lo expandido
      // vuelven a su sitio. `syncWatchers` solo abre y cierra handles, no reescanea.
      this.syncWatchers(st);
    }
  }

  /** Crea un fichero vacío dentro de `parentRel` ("" = la raíz) sin sobrescribir. */
  private async newFileAt(st: TreeRuntime, parentRel: string): Promise<void> {
    const tree = st.tree;
    if (!tree) {
      this.op(st, false, "Este árbol todavía no está escaneado.");
      return;
    }
    if (parentRel !== "" && !tree.hasDir(parentRel)) {
      this.op(st, false, "La carpeta de destino no existe.");
      return;
    }
    const dirAbs = await this.resolve(st, parentRel, true);
    if (!dirAbs || this.disposed) {
      return;
    }
    const propuesta = await vscode.window.showInputBox({
      prompt: `Fichero nuevo en «${parentRel || st.label}»`,
      value: "texto.txt",
      ignoreFocusOut: true,
      validateInput: (value: string) => validateEntryName(value),
    });
    if (propuesta === undefined) {
      return;
    }
    const problem = validateEntryName(propuesta);
    const name = (propuesta ?? "").trim();
    if (problem || !name) {
      this.op(st, false, problem ?? "Nombre no válido.");
      return;
    }
    const target = path.join(dirAbs, name);
    if (await existsReal(target)) {
      this.op(st, false, `«${name}» ya existe. Sin sobrescribir.`);
      return;
    }
    this.suppress(st);
    try {
      // `wx`: falla si alguien creó el fichero mientras tanto.
      await writeFile(target, "", { flag: "wx" });
    } catch (err) {
      this.op(st, false, err instanceof Error ? err.message : String(err));
      return;
    }
    this.op(st, true, `Creado «${name}».`);
    await this.afterMutation(st, parentRel);
    try {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(target));
    } catch {
      // Sin editor disponible: el fichero ya está creado y en el árbol.
    }
  }

  /**
   * Abre `vscode.diff` entre la versión de Git y la del disco. La versión de Git se
   * vuelca en un temporal estable (raíz + `rel` -> hash), así que no acumula basura.
   */
  private async diffRel(st: TreeRuntime, rel: string): Promise<void> {
    const entry = st.tree?.getEntry(rel);
    if (!entry || entry.kind !== "file") {
      this.op(st, false, "Solo se comparan ficheros que existen en disco.");
      return;
    }
    const gitState = st.gitFiles.get(rel);
    // Sin cambios de contenido nada que comparar: `clean` aunque esté sin subir se descarta.
    const comparable =
      gitState !== undefined &&
      (gitState.state === "modified" ||
        gitState.state === "staged" ||
        gitState.state === "renamed" ||
        (gitState.unpushed === true && gitState.state !== "clean"));
    if (!comparable || !gitState) {
      this.op(st, false, "Ese fichero no tiene cambios que comparar con Git.");
      return;
    }
    if (!st.root) {
      this.op(st, false, "Este árbol no tiene carpeta raíz.");
      return;
    }
    const abs = await this.resolve(st, rel);
    if (!abs || this.disposed) {
      return;
    }
    try {
      const version = await readGitVersion(st.root, rel);
      const dir = path.join(this.storageDir, "projectExplorer-diff");
      await mkdir(dir, { recursive: true });
      const hash = createHash("sha1")
        .update(`${st.root}\n${rel}`)
        .digest("hex")
        .slice(0, 20);
      const target = path.join(dir, `${hash}${entry.ext ? `.${entry.ext}` : ""}`);
      await writeFile(target, version.bytes);
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(target),
        vscode.Uri.file(abs),
        `${rel} (Git ↔ disco)`
      );
      this.op(st, true, `Comparando con ${version.source === "HEAD" ? "HEAD" : "el índice"}.`);
    } catch (err) {
      this.op(
        st,
        false,
        err instanceof GitError || err instanceof OpError ? err.message : String(err)
      );
    }
  }

  // ---------------------------------------------------------------- búsqueda

  private scheduleSearch(st: TreeRuntime, query: string): void {
    st.query = query;
    if (st.searchTimer) {
      clearTimeout(st.searchTimer);
      st.searchTimer = null;
    }
    if (query.trim() === "") {
      st.searchGen += 1;
      st.contentAbort?.abort();
      st.contentAbort = null;
      st.contentPending = false;
      st.resultIds = null;
      this.recomputeView(st);
      return;
    }
    st.searchTimer = setTimeout(() => {
      st.searchTimer = null;
      if (!this.disposed) {
        void this.runSearch(st, query);
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  private async runSearch(st: TreeRuntime, query: string): Promise<void> {
    const tree = st.tree;
    const gen = ++st.searchGen;
    if (!tree || !st.root || query.trim() === "" || st.query !== query) {
      if (tree && st.query.trim() === "") {
        this.recomputeView(st);
      }
      return;
    }
    const names = searchNames(tree, query, st.showHidden);
    const ids = new Set<number>(names.map((m) => m.id));
    if (gen !== st.searchGen || this.disposed) {
      return;
    }
    // Solo se publican ids del árbol vigente: si ha cambiado, arriba se baila.
    st.resultIds = ids;
    this.recomputeView(st);
    // Contenido: solo si hay texto que buscar; se cancela con la generación.
    st.contentAbort?.abort();
    const controller = new AbortController();
    st.contentAbort = controller;
    st.contentPending = true;
    try {
      const hits = await searchContents(tree, st.root, query, st.showHidden, {
        signal: controller.signal,
        skipped: ids,
      });
      if (gen !== st.searchGen || this.disposed || st.query !== query) {
        return;
      }
      for (const hit of hits) {
        const id = tree.idByRel.get(hit.rel);
        if (id !== undefined) {
          ids.add(id);
        }
      }
      this.recomputeView(st);
    } catch {
      // Búsqueda de contenido tolerante a fallos: se ignora.
    } finally {
      if (gen === st.searchGen) {
        st.contentPending = false;
      }
    }
  }

  /**
   * Rehace la búsqueda activa tras cambiar el árbol: los ids guardados ya no
   * valen. Se relanza sin debounce porque el cambio de disco no debe esperar.
   */
  private resumeSearch(st: TreeRuntime): void {
    if (this.disposed || st.query.trim() === "") {
      return;
    }
    if (st.searchTimer) {
      clearTimeout(st.searchTimer);
      st.searchTimer = null;
    }
    st.resultIds = null;
    // Sin árbol, o con un escaneo completo en vuelo: es el escaneo quien relanzará al terminar.
    if (!st.tree || st.scan.state === "scanning") {
      return;
    }
    void this.runSearch(st, st.query);
  }

  // ---------------------------------------------------------------- watchers

  /** Vigilantes no recursivos: raíz + carpetas expandidas, tope 200. */
  private syncWatchers(st: TreeRuntime): void {
    if (this.disposed) {
      return;
    }
    const keep = new Set<string>([""]);
    for (const rel of st.expanded) {
      // Se guarda lo que el usuario tiene abierto, no lo que el árbol tiene en este instante:
      // durante un reescaneo la carpeta puede faltar un momento y cerrar/abrir el vigilante
      // de ahí saldría un aviso falso.
      if (rel !== "") {
        keep.add(rel);
      }
    }
    for (const [rel] of st.watchers) {
      if (!keep.has(rel)) {
        st.watchers.get(rel)?.close();
        st.watchers.delete(rel);
      }
    }
    for (const rel of keep) {
      if (st.watchers.has(rel)) {
        continue;
      }
      if (st.watchers.size >= MAX_WATCHERS) {
        break;
      }
      // Solo se abre lo que el árbol ya conoce: así no se intenta en cada refresco.
      if (rel !== "" && !st.tree?.hasDir(rel)) {
        continue;
      }
      const abs = this.relAbs(st, rel);
      if (!abs) {
        continue;
      }
      try {
        const watcher = watch(abs, { recursive: false }, (_event, filename) => {
          if (this.disposed) {
            return;
          }
          // `git` toca `.git` (o `.hg`/`.svn`) desde la propia raíz: no es un cambio
          // del proyecto. Sin este filtro el vigilante dispara `rescanSubtree("")`,
          // `loadGit` vuelve a ejecutar git y el bucle no para nunca.
          if (isVcsWatcherName(filename)) {
            return;
          }
          // El aviso nunca se tira: si cae dentro de la ventana de una operación
          // propia, se reconta al terminar la ventana en vez de ignorarlo.
          st.watchDirty.add(rel);
          const dentro = st.suppressUntil - Date.now();
          const espera = dentro > 0 ? dentro + WATCH_DEBOUNCE_MS : WATCH_DEBOUNCE_MS;
          if (st.watchTimer) {
            clearTimeout(st.watchTimer);
          }
          st.watchTimer = setTimeout(() => {
            st.watchTimer = null;
            void this.flushWatch(st);
          }, espera);
        });
        watcher.on("error", () => {
          watcher.close();
          st.watchers.delete(rel);
        });
        st.watchers.set(rel, watcher);
      } catch {
        // La carpeta pudo desaparecer justo ahora: no hay vigilante hasta el próximo refresco.
      }
    }
  }

  private async flushWatch(st: TreeRuntime): Promise<void> {
    if (this.disposed) {
      return;
    }
    const rels = [...st.watchDirty];
    st.watchDirty.clear();
    if (rels.length === 0) {
      return;
    }
    // Todos los avisos entran por la cola del árbol: se agrupan y no se solapan.
    await Promise.all(rels.map((rel) => this.enqueueRescan(st, rel)));
    if (this.disposed) {
      return;
    }
    await this.loadGit(st);
    this.syncWatchers(st);
  }

  private suppress(st: TreeRuntime): void {
    st.suppressUntil = Date.now() + SUPPRESS_MS;
  }

  // ---------------------------------------------------------------- utilidades

  private async pickFolder(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: "Carpeta raíz del árbol",
    });
    return picked?.[0]?.fsPath;
  }

  private async setLayout(layout: "one" | "two"): Promise<void> {
    this.layout = layout;
    void this.state.update(KEY_LAYOUT, layout);
    this.postInit();
    if (layout !== "two") {
      return;
    }
    const b = this.trees.get("b") as TreeRuntime;
    if (b.root) {
      // Ya tiene raíz: se pone al día si estaba sin escanear (layout "one" al abrir).
      if (!b.tree) {
        void this.scanTree(b);
      } else {
        this.recomputeView(b);
      }
      return;
    }
    const picked = await this.pickFolder();
    if (picked && !this.disposed) {
      this.setRootRuntime(b, picked);
      await this.saveRoots();
      this.postInit();
      void this.scanTree(b);
    } else if (!this.disposed) {
      // Cancelado: se queda una columna hasta que elija raíz.
      this.layout = "one";
      void this.state.update(KEY_LAYOUT, "one");
      this.postInit();
    }
  }

  private canExpand(st: TreeRuntime, rel: string): boolean {
    if (rel === "") {
      return true;
    }
    return st.tree?.hasDir(rel) ?? false;
  }

  private async resolve(st: TreeRuntime, rel: string, allowRoot = false): Promise<string | undefined> {
    try {
      if (!st.root) {
        throw new OpError("Sin carpeta raíz.");
      }
      return await resolveInside(st.root, rel, { allowRoot });
    } catch (err) {
      this.op(st, false, err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /** Absoluta del `rel` sin tocar disco (para watchers y aperturas). */
  private relAbs(st: TreeRuntime, rel: string): string | undefined {
    if (!st.root) {
      return undefined;
    }
    const parts = rel.split("/").filter((p) => p.length > 0);
    if (parts.some((p) => p === ".." || p.toLowerCase() === ".git")) {
      return undefined;
    }
    return path.join(st.root, ...parts);
  }

  private insideRoot(st: TreeRuntime, fsPath: string): boolean {
    if (!st.root) {
      return false;
    }
    const rel = path.relative(st.root, fsPath);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  private teardownScan(st: TreeRuntime): void {
    st.scanGen += 1;
    st.scanAbort?.abort();
    st.scanAbort = null;
    st.contentAbort?.abort();
    st.contentAbort = null;
    st.searchGen += 1;
    if (st.searchTimer) {
      clearTimeout(st.searchTimer);
      st.searchTimer = null;
    }
    for (const [, w] of st.watchers) {
      w.close();
    }
    st.watchers.clear();
    st.watchDirty.clear();
    if (st.watchTimer) {
      clearTimeout(st.watchTimer);
      st.watchTimer = null;
    }
    // La cola de rescans es del árbol viejo: se tira y se suelta a quien esperara.
    this.cancelRescans(st);
    st.tree = null;
    st.gitFiles = new Map();
    st.git = null;
    st.resultIds = null;
    st.expanded = new Set<string>([""]);
    st.scan = { state: "idle", files: 0, dirs: 0, bytes: 0, truncated: false };
  }

  // ---------------------------------------------------------------- salida

  private metaOf(st: TreeRuntime): TreeMeta {
    return {
      id: st.id,
      root: st.root,
      label: st.label,
      showHidden: st.showHidden,
      sort: st.sort,
      sortDir: st.sortDir,
      filter: st.filter,
      query: st.query,
      expanded: [...st.expanded].filter((r) => r !== "").slice(0, MAX_EXPANDED),
      scan: { ...st.scan },
      git: st.git,
    };
  }

  private postInit(): void {
    const trees = TreeIds.map((id) => this.metaOf(this.trees.get(id) as TreeRuntime));
    this.post({ type: "init", payload: { layout: this.layout, split: this.split, trees } });
  }

  private postView(st: TreeRuntime, rows: Row[], truncated = false): void {
    this.post({
      type: "view",
      payload: {
        treeId: st.id,
        mode: st.query.trim() !== "" || st.filter !== "all" ? "result" : "tree",
        rows,
        truncated,
        query: st.query,
        filter: st.filter,
      },
    });
  }

  private postScan(st: TreeRuntime, state: "start" | "progress" | "done" | "error", error?: string): void {
    this.post({
      type: "scan",
      payload: {
        treeId: st.id,
        state,
        files: st.scan.files,
        dirs: st.scan.dirs,
        bytes: st.scan.bytes,
        ...(error ? { error } : {}),
      },
    });
  }

  private postGit(st: TreeRuntime): void {
    this.post({ type: "git", payload: { treeId: st.id, info: st.git } });
  }

  /** Estado ocupado = cola git en vuelo; el texto lo pone el último `status`. */
  private postStatus(st: TreeRuntime, text?: string, kind: "ok" | "error" | "info" = "info"): void {
    const busy = st.gitRunning || st.gitQueue.length > 0;
    this.post({
      type: "status",
      payload: { treeId: st.id, text: text ?? (busy ? "git…" : ""), kind, busy },
    });
  }

  private status(st: TreeRuntime, text: string, kind: "ok" | "error" | "info"): void {
    this.postStatus(st, text, kind);
  }

  private op(st: TreeRuntime, ok: boolean, message: string): void {
    this.post({ type: "op", payload: { treeId: st.id, ok, message } });
  }

  private post(message: unknown): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    try {
      const nonce = getNonce();
      const uriIn = (file: string): string =>
        webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file)).toString();
      const template = readFileSync(
        path.join(this.extensionUri.fsPath, "media", "projectExplorer.html"),
        "utf8"
      );
      return template
        .replaceAll("%%CSP%%", webview.cspSource)
        .replaceAll("%%NONCE%%", nonce)
        .replaceAll("%%TOKENS%%", uriIn("tokens.css"))
        .replaceAll("%%STYLE%%", uriIn("projectExplorer.css"))
        .replaceAll("%%SCRIPT%%", uriIn("projectExplorer.js"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        `Explorador del proyecto: no se pudo cargar la interfaz (${message}).`
      );
      return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" /><title>Explorador del proyecto</title></head><body><p>No se pudo cargar <code>media/projectExplorer.html</code>. Reinstala la extensión.</p></body></html>`;
    }
  }

  private dispose(): void {
    this.disposed = true;
    ProjectExplorerPanel.current = undefined;
    for (const st of this.trees.values()) {
      st.scanAbort?.abort();
      st.contentAbort?.abort();
      if (st.searchTimer) {
        clearTimeout(st.searchTimer);
      }
      if (st.gitRefreshTimer) {
        clearTimeout(st.gitRefreshTimer);
      }
      if (st.watchTimer) {
        clearTimeout(st.watchTimer);
      }
      for (const [, w] of st.watchers) {
        w.close();
      }
      st.watchers.clear();
      // Nadie debe quedarse esperando a una cola que ya no se va a drenar.
      this.cancelRescans(st);
      st.tree = null;
      st.gitFiles = new Map();
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

const TreeIds: TreeId[] = ["a", "b"];

function gitBusy(st: TreeRuntime): boolean {
  return st.gitRunning || st.gitQueue.length > 0;
}

// ---------------------------------------------------------------- mensajes del webview

type IncomingMessage =
  | { type: "ready" }
  | { type: "chooseRoot"; treeId: TreeId }
  | { type: "setLayout"; layout: "one" | "two" }
  | { type: "setSplit"; ratio: number }
  | { type: "toggleHidden"; treeId: TreeId }
  | { type: "setSort"; treeId: TreeId; sort: SortKey }
  | { type: "setSortDir"; treeId: TreeId; dir: SortDir }
  | { type: "expand"; treeId: TreeId; rel: string }
  | { type: "collapse"; treeId: TreeId; rel: string }
  | { type: "refresh"; treeId: TreeId }
  | { type: "search"; treeId: TreeId; query: string }
  | { type: "setFilter"; treeId: TreeId; filter: FilterId }
  | { type: "open"; treeId: TreeId; rel: string }
  | { type: "reveal"; treeId: TreeId; rel: string }
  | { type: "delete"; treeId: TreeId; rel: string }
  | {
      type: "transfer";
      fromTree: TreeId;
      fromRel: string;
      toTree: TreeId;
      toDir: string;
      mode: "copy" | "move";
    }
  | {
      type: "git";
      treeId: TreeId;
      action: GitActionKind;
      branch?: string;
      message?: string;
      rel?: string;
    }
  | { type: "rename"; treeId: TreeId; rel: string }
  | { type: "diff"; treeId: TreeId; rel: string }
  | { type: "newFile"; treeId: TreeId; parentRel: string };

/** El webview no es de fiar: solo pasan las formas exactas del contrato. */
function parseIncoming(raw: unknown): IncomingMessage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  const id = treeId(m.treeId ?? m.fromTree);
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "chooseRoot":
      return id ? { type: "chooseRoot", treeId: id } : undefined;
    case "setLayout":
      return m.layout === "one" || m.layout === "two"
        ? { type: "setLayout", layout: m.layout }
        : undefined;
    case "setSplit": {
      if (typeof m.ratio !== "number" || !isFinite(m.ratio)) {
        return undefined;
      }
      return { type: "setSplit", ratio: m.ratio };
    }
    case "toggleHidden":
      return id ? { type: "toggleHidden", treeId: id } : undefined;
    case "setSort":
      return id && isSortKey(m.sort)
        ? { type: "setSort", treeId: id, sort: m.sort }
        : undefined;
    case "setSortDir":
      return id && isSortDir(m.dir)
        ? { type: "setSortDir", treeId: id, dir: m.dir }
        : undefined;
    case "expand":
    case "collapse":
    case "open":
    case "reveal":
    case "delete": {
      const rel = normalizeRel(m.rel);
      if (!id || rel === undefined) {
        return undefined;
      }
      return { type: m.type, treeId: id, rel } as IncomingMessage;
    }
    case "refresh":
      return id ? { type: "refresh", treeId: id } : undefined;
    case "search": {
      if (!id || typeof m.query !== "string") {
        return undefined;
      }
      return { type: "search", treeId: id, query: m.query.slice(0, QUERY_MAX) };
    }
    case "setFilter":
      if (!id || typeof m.filter !== "string" || !FILTER_IDS.has(m.filter)) {
        return undefined;
      }
      return { type: "setFilter", treeId: id, filter: m.filter as FilterId };
    case "transfer": {
      const to = treeId(m.toTree);
      const fromRel = normalizeRel(m.fromRel);
      const toDir = normalizeRel(m.toDir);
      if (!id || !to || fromRel === undefined || toDir === undefined) {
        return undefined;
      }
      if (m.mode !== "copy" && m.mode !== "move") {
        return undefined;
      }
      return { type: "transfer", fromTree: id, fromRel, toTree: to, toDir, mode: m.mode };
    }
    case "git": {
      if (!id || typeof m.action !== "string" || !GIT_ACTIONS.has(m.action)) {
        return undefined;
      }
      const action = m.action as GitActionKind;
      const branch = typeof m.branch === "string" ? m.branch.slice(0, 120) : undefined;
      const message = typeof m.message === "string" ? m.message.slice(0, 2000) : undefined;
      // stage/unstage/discard llegan con la ruta del fichero: sin ella, el mensaje no vale.
      const rawRel = normalizeRel(m.rel);
      const rel = rawRel === undefined || rawRel === "" ? undefined : rawRel;
      if (GIT_PATH_ACTIONS.has(action) && rel === undefined) {
        return undefined;
      }
      return {
        type: "git",
        treeId: id,
        action,
        ...(branch !== undefined ? { branch } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(rel !== undefined ? { rel } : {}),
      };
    }
    case "rename":
    case "diff": {
      const rel = normalizeRel(m.rel);
      if (!id || rel === undefined || rel === "") {
        return undefined;
      }
      return { type: m.type, treeId: id, rel };
    }
    case "newFile": {
      const parentRel = normalizeRel(m.parentRel);
      // "" = la raíz del árbol, que sí es un destino válido para crear.
      if (!id || parentRel === undefined) {
        return undefined;
      }
      return { type: "newFile", treeId: id, parentRel };
    }
  }
  return undefined;
}

function treeId(value: unknown): TreeId | undefined {
  return value === "a" || value === "b" ? value : undefined;
}

function isSortKey(value: unknown): value is SortKey {
  return value === "name" || value === "size" || value === "date";
}

function isSortDir(value: unknown): value is SortDir {
  return value === "asc" || value === "desc";
}

/** `rel` aceptado: cadena corta, sin absolutas, `..` ni `\0`; normalizado a "/". "" = raíz. */
function normalizeRel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const raw = value.trim();
  if (raw.includes("\0") || value.length > 1024) {
    return undefined;
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return undefined;
  }
  const parts = raw.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === ".." || p.toLowerCase() === ".git")) {
    return undefined;
  }
  // "" o "." significan la raíz del árbol (destino válido para pegar).
  return parts.join("/");
}

/**
 * Nombres reservados de Windows, valen con o sin extensión (`con`, `CON.txt`,
 * `nul.dat`, `com1.md`). Se compara la parte anterior al primer punto.
 */
const WIN_RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Nombre de fichero/carpeta aceptado para crear y renombrar. Devuelve el mensaje
 * de error o `null` si vale. Un solo segmento, 1..120, sin caracteres reservados
 * de Windows, sin `.`/`..`, sin el `.git` exacto, sin nombres reservados de
 * Windows y sin punto final. Los puntos iniciales sí valen (`.env`, `.gitignore`,
 * `.github`).
 */
function validateEntryName(value: string | undefined): string | null {
  const name = (value ?? "").trim();
  if (!name) {
    return "Escribe un nombre.";
  }
  if (name.length > 120) {
    return "Demasiado largo (máximo 120).";
  }
  if (/[/\\:*?"<>|]/.test(name)) {
    return "El nombre lleva caracteres reservados.";
  }
  if (name === "." || name === "..") {
    return "Nombre no válido.";
  }
  if (name.toLowerCase() === ".git") {
    return "No se puede crear ni renombrar a .git.";
  }
  if (WIN_RESERVED_NAMES.has(name.split(".")[0].toLowerCase())) {
    return "Nombre reservado de Windows.";
  }
  if (name.endsWith(".")) {
    return "Sin punto al final.";
  }
  return null;
}

/** ¿Existe algo en esa absoluta? (un enlace roto también cuenta: está el nombre). */
async function existsReal(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

function parentOfRel(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at > 0 ? rel.slice(0, at) : "";
}

function baseName(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at >= 0 ? rel.slice(at + 1) : rel;
}

function clampRatio(value: unknown): number {
  if (typeof value !== "number" || !isFinite(value)) {
    return 0.5;
  }
  return Math.min(0.9, Math.max(0.1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readBool(value: unknown, dflt: boolean): boolean {
  return typeof value === "boolean" ? value : dflt;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
