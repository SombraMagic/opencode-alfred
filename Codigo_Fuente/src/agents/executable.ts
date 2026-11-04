import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Comando listo para `execFile`: el fichero y los argumentos que van delante. */
export interface ExecTarget {
  file: string;
  prefix: string[];
}

const EXTENSIONS = [".exe", ".com", ".cmd", ".bat", ".ps1"];

/**
 * Resuelve un comando del PATH sin pasar por el shell.
 *
 * En Windows, npm instala opencode como un shim `.cmd`. Desde Node 20.12
 * `execFile`/`spawn` rechazan `.cmd` y `.bat` sin `shell: true` (EINVAL) y
 * `execFile("opencode")` ni siquiera encuentra el shim (ENOENT). Se busca el
 * `.exe` real que hay detrás para no depender de cmd.exe ni de sus comillas.
 */
export function resolveCommand(command: string): ExecTarget {
  if (process.platform !== "win32") {
    return { file: command, prefix: [] };
  }
  const candidates = /[\\/]/.test(command) ? [command] : pathCandidates(command);
  for (const candidate of candidates) {
    const target = resolveWindows(candidate);
    if (target) {
      return target;
    }
  }
  return { file: command, prefix: [] };
}

function pathCandidates(command: string): string[] {
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of EXTENSIONS) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) {
        out.push(candidate);
      }
    }
  }
  return out;
}

function resolveWindows(candidate: string): ExecTarget | undefined {
  if (!existsSync(candidate)) {
    return undefined;
  }
  const lower = candidate.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".com")) {
    return { file: candidate, prefix: [] };
  }
  if (lower.endsWith(".ps1")) {
    return powershell(candidate);
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const direct = shimTarget(candidate);
    if (direct) {
      return { file: direct, prefix: [] };
    }
    // El shim de npm suele venir con su gemelo .ps1: se lanza sin cmd.exe.
    const ps1 = candidate.replace(/\.(?:cmd|bat)$/i, ".ps1");
    if (existsSync(ps1)) {
      return powershell(ps1);
    }
  }
  return undefined;
}

/** Ruta al ejecutable que llama un shim de npm, si se puede deducir. */
function shimTarget(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  const base = dirname(shim);
  for (const match of text.matchAll(/"([^"\r\n]+\.(?:exe|com))"/gi)) {
    let target = match[1]
      .replace(/%~dp0/gi, () => base + "\\")
      .replace(/%dp0%/gi, () => base)
      .replace(/\$(?:basedir|psscriptroot)/gi, () => base)
      .replace(/%cd%/gi, () => process.cwd())
      .replace(/\//g, "\\")
      .trim();
    if (!isAbsolute(target)) {
      target = resolve(base, target);
    }
    if (existsSync(target)) {
      return target;
    }
  }
  return undefined;
}

function powershell(script: string): ExecTarget {
  return {
    file: "powershell.exe",
    prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
  };
}
