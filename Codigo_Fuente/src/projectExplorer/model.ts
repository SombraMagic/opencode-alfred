/**
 * Tipos compartidos del Explorador del proyecto (panel + host).
 * Sin dependencias de `vscode`: el contrato de mensajes vive aquí.
 */

export type TreeId = "a" | "b";

/** Filtros de la tira de chips. `all` = árbol normal; el resto, modo resultado con git. */
export type FilterId = "all" | "changed" | "staged" | "untracked" | "unpushed" | "clean";

export type RowKind = "dir" | "file" | "link" | "missing";

/** Clave de ordenación de los hijos de un directorio. */
export type SortKey = "name" | "size" | "date";

/** Sentido de la ordenación. */
export type SortDir = "asc" | "desc";

export type GitState =
  | "clean"
  | "modified"
  | "staged"
  | "untracked"
  | "deleted"
  | "renamed"
  | "ignored";

/** Estado git de una fila. `state` sigue la prioridad deleted > renamed > untracked > staged > modified > clean. */
export interface RowGit {
  state: GitState;
  /** Aparece en los commits por delante del upstream. */
  unpushed?: boolean;
  /** Hay cambio en el índice (X distinto de `.`). */
  staged?: boolean;
  added?: number;
  removed?: number;
}

/** Fila visible enviada al webview (el árbol se aplana por profundidad). */
export interface Row {
  rel: string;
  name: string;
  kind: RowKind;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** Bytes (lógicos). 0 para `missing`. */
  size: number;
  /** Porcentaje entero 0..100 respecto al tamaño visible del padre. */
  pct: number;
  /** mtime en ms (0 si se desconoce). */
  mtime: number;
  /** Extensión sin punto, minúsculas; "" para carpetas. */
  ext: string;
  git: RowGit | null;
  /** Algún descendiente tiene estado git distinto de clean. */
  folderGit: boolean;
  /** No se pudo leer (permisos, lectura parcial). */
  error: boolean;
}

/** Estado de escaneo de un árbol. `idle` = sin raíz. */
export interface ScanState {
  state: "idle" | "scanning" | "done" | "error";
  files: number;
  dirs: number;
  bytes: number;
  truncated: boolean;
  error?: string;
}

/** Metadatos de un árbol para el webview (dentro de `init`). */
export interface TreeMeta {
  id: TreeId;
  root: string;
  label: string;
  showHidden: boolean;
  sort: SortKey;
  sortDir: SortDir;
  filter: FilterId;
  query: string;
  expanded: string[];
  scan: ScanState;
  git: GitInfo | null;
}

/** Resumen git de la raíz. `null` si la raíz no está dentro de un repo. */
export interface GitInfo {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  counts: {
    changed: number;
    staged: number;
    untracked: number;
    unpushed: number;
    clean: number;
  };
}
