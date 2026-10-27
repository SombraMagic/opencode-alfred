import * as fs from "fs";
import * as path from "path";
import { isSamePath, opencodeStateDir } from "../agents/paths";

/**
 * `tabs.json` más reciente de los canales de la TUI (`latest`, `dev`, ...): solo el canal
 * vivo escribe pestañas. undefined si no hay ninguno.
 *
 * shortcut: formato interno de la TUI, revisar si opencode lo mueve.
 */
function newestTabsFile(): string | undefined {
  const root = opencodeStateDir();
  let channels: string[];
  try {
    channels = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  let newest: { file: string; mtime: number } | undefined;
  for (const channel of channels) {
    const file = path.join(root, channel, "tui", "tabs.json");
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { file, mtime };
      }
    } catch {
      // Canal sin `tabs.json`: no es la TUI viva o aún no abrió pestañas.
    }
  }
  return newest?.file;
}

/** Añade los `sessionID` de una entrada `{ tabs: [...] }`; tolera basura. */
function tabIds(entry: unknown, out: Set<string>): void {
  const tabs = (entry as { tabs?: unknown } | undefined)?.tabs;
  if (!Array.isArray(tabs)) {
    return;
  }
  for (const tab of tabs) {
    const id = (tab as { sessionID?: unknown } | undefined)?.sessionID;
    if (typeof id === "string" && id) {
      out.add(id);
    }
  }
}

/**
 * Pestañas de la TUI abiertas para `directory`: las globales y las de esa carpeta.
 * `found` distingue «sin fichero» de «sin pestañas»; con JSON roto o formato cambiado, `[]`.
 */
export function readTuiTabs(directory: string): { found: boolean; ids: string[] } {
  const file = newestTabsFile();
  if (!file) {
    return { found: false, ids: [] };
  }
  let parsed: { global?: unknown; cwd?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as typeof parsed;
  } catch {
    return { found: true, ids: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { found: true, ids: [] };
  }
  const ids = new Set<string>();
  tabIds(parsed.global, ids);
  if (parsed.cwd && typeof parsed.cwd === "object") {
    for (const [dir, entry] of Object.entries(parsed.cwd)) {
      if (isSamePath(dir, directory)) {
        tabIds(entry, ids);
      }
    }
  }
  return { found: true, ids: [...ids] };
}
