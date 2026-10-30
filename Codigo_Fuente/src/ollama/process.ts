/** Detección, instalación y arranque del proceso de Ollama. Sin `vscode`. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { ollamaVersion } from "./client";

export interface OllamaInstall {
  present: boolean;
  path: string | null;
  version: string | null;
}

const WINGET_MISSING = "winget no está disponible; instala Ollama desde ollama.com/download";

/** El ejecutable instalado por el instalador oficial; si no, el que haya en el PATH. */
export function ollamaExe(): string | null {
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const installed = join(local, "Programs", "Ollama", "ollama.exe");
    if (existsSync(installed)) {
      return installed;
    }
  }
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["ollama"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const found = (probe.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return found && existsSync(found) ? found : null;
}

export function modelsDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, ".ollama", "models");
}

export async function detectInstall(): Promise<OllamaInstall> {
  const exe = ollamaExe();
  if (!exe) {
    return { present: false, path: null, version: null };
  }
  // El CLI se queja por stderr en algunas versiones: la versión se busca en la salida entera.
  const run = spawnSync(exe, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(output);
  return { present: true, path: exe, version: match ? match[1] : null };
}

/**
 * Modelos sin servidor: se leen los manifiestos del disco (`<models>/manifests`).
 * El tamaño es el que declara el manifiesto (blobs compartidos no se descuentan);
 * `family` y `parameters` solo los da `/api/tags`.
 */
export async function modelsOnDisk(): Promise<
  Array<{ name: string; sizeBytes: number; modified: string }>
> {
  const root = join(modelsDir(), "manifests");
  const out: Array<{ name: string; sizeBytes: number; modified: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // <registro>/<namespace>/<modelo>/<tag>; `library` es el namespace implícito.
      const parts = relative(root, full).split(sep);
      if (parts.length < 4) {
        continue;
      }
      const tag = parts[parts.length - 1];
      const ns = parts.slice(1, -1);
      const name = ns[0] === "library"
        ? `${ns.slice(1).join("/")}:${tag}`
        : `${ns.join("/")}:${tag}`;
      try {
        const manifest = JSON.parse(await readFile(full, "utf8")) as {
          config?: { size?: number };
          layers?: Array<{ size?: number }>;
        };
        const size = (manifest.config?.size ?? 0) +
          (manifest.layers ?? []).reduce((sum, layer) => sum + (layer.size ?? 0), 0);
        const modified = (await stat(full)).mtime.toISOString();
        out.push({ name, sizeBytes: size, modified });
      } catch {
        // Un manifiesto ilegible no tumba la lista.
      }
    }
  };
  await walk(root);
  return out;
}

/** `winget` línea a línea; sin winget en el PATH, error claro. */
function runWinget(args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child;
    try {
      child = spawn("winget", args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error(WINGET_MISSING));
      return;
    }
    const tail: string[] = [];
    const feed = (chunk: Buffer): void => {
      for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
          continue;
        }
        onLine(line);
        tail.push(line);
        if (tail.length > 20) {
          tail.shift();
        }
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", () => reject(new Error(WINGET_MISSING)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`winget falló (código ${code}). ${tail.slice(-3).join(" ")}`.trim()));
      }
    });
  });
}

export async function installOllama(onLine: (line: string) => void): Promise<void> {
  await runWinget(
    [
      "install",
      "--id",
      "Ollama.Ollama",
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    onLine
  );
}

/** Quita el programa; `%USERPROFILE%\.ollama` (los modelos) no se toca. */
export async function uninstallOllama(onLine: (line: string) => void): Promise<void> {
  await runWinget(
    [
      "uninstall",
      "--id",
      "Ollama.Ollama",
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    onLine
  );
}

async function responds(baseURL: string): Promise<boolean> {
  try {
    await ollamaVersion(baseURL);
    return true;
  } catch {
    return false;
  }
}

/** Arranca `ollama serve` suelto (sin quedar colgado de la extensión) y espera hasta 25 s. */
export async function startServer(baseURL: string): Promise<void> {
  if (await responds(baseURL)) {
    return;
  }
  const exe = ollamaExe();
  if (!exe) {
    throw new Error("Ollama no está instalado: instálalo antes de encender Mente local.");
  }
  // Sin `detached`: la consola oculta de `windowsHide` se hereda y los hijos de Ollama
  // (sondas de GPU, runner) no abren ventana. `detached` los deja sin consola y Windows
  // les abre una visible.
  const child = spawn(exe, ["serve"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const spawnState: { error: Error | null } = { error: null };
  child.on("error", (err) => {
    // El bucle lo lee: sin esto, un fallo de spawn espera 25 s.
    spawnState.error = err instanceof Error ? err : new Error(String(err));
  });
  child.unref();

  const limit = Date.now() + 25_000;
  while (Date.now() < limit) {
    if (spawnState.error) {
      throw new Error(`No se pudo arrancar Ollama: ${spawnState.error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await responds(baseURL)) {
      return;
    }
  }
  throw new Error("El servidor de Ollama no respondió en 25 s.");
}

/** Mata el servidor y su bandeja. «No encontrado» no es fallo: puede faltar uno de los dos. */
export async function stopServer(): Promise<void> {
  for (const image of ["ollama app.exe", "ollama.exe"]) {
    spawnSync("taskkill", ["/IM", image, "/F"], { windowsHide: true, stdio: "ignore" });
  }
}
