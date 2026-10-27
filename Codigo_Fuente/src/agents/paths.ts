import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Root of the global opencode config (~/.config/opencode by default). */
export function globalOpencodeDir(): string {
  const configured = vscode.workspace
    .getConfiguration("opencodeAgents")
    .get<string>("globalConfigDir");
  if (configured && configured.trim()) {
    return path.normalize(expandHome(configured.trim()));
  }
  return path.join(os.homedir(), ".config", "opencode");
}

export function globalAgentDirs(): string[] {
  const root = globalOpencodeDir();
  return [path.join(root, "agent"), path.join(root, "agents")];
}

/** Fichero de instrucciones globales de opencode (~/.config/opencode/AGENTS.md). */
export function globalAgentsMdPath(): string {
  return path.join(globalOpencodeDir(), "AGENTS.md");
}

/** Directory where opencode keeps its data (SQLite DBs, auth.json). */
export function opencodeDataDir(): string {
  const configured = vscode.workspace
    .getConfiguration("opencodeAgents")
    .get<string>("dataDir");
  if (configured && configured.trim()) {
    return path.normalize(expandHome(configured.trim()));
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

export function opencodeAuthPath(): string {
  return path.join(opencodeDataDir(), "auth.json");
}

/** models.dev registry cache written by opencode. */
export function opencodeModelsCachePath(): string {
  const configured = vscode.workspace
    .getConfiguration("opencodeAgents")
    .get<string>("modelsCachePath");
  if (configured && configured.trim()) {
    return path.normalize(expandHome(configured.trim()));
  }
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "opencode", "models.json");
}

/** Primary project root (first workspace folder). */
export function projectRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

/** Instrucciones del proyecto (<raíz>/AGENTS.md). */
export function projectAgentsMdPath(): string | undefined {
  const root = projectRoot();
  return root ? path.join(root, "AGENTS.md") : undefined;
}

export function projectAgentDirs(): string[] {
  const root = projectRoot();
  if (!root) {
    return [];
  }
  return [path.join(root, ".opencode", "agent"), path.join(root, ".opencode", "agents")];
}

/** Candidate opencode.json / .jsonc config files, highest precedence last. */
export function configFileCandidates(): string[] {
  const out: string[] = [];
  const root = projectRoot();
  if (root) {
    out.push(path.join(root, ".opencode", "opencode.json"));
    out.push(path.join(root, ".opencode", "opencode.jsonc"));
    out.push(path.join(root, "opencode.json"));
    out.push(path.join(root, "opencode.jsonc"));
  }
  const g = globalOpencodeDir();
  out.push(path.join(g, "opencode.json"));
  out.push(path.join(g, "opencode.jsonc"));
  return out;
}

export function isSamePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === "win32"
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}
