/**
 * Inyección de un prompt en la consola de un proceso (Claude Code), sin `vscode`.
 *
 * Claude no tiene servidor al que mandar el texto (opencode sí: `/api/session/<id>/prompt`), así
 * que cuando su terminal vive fuera de VS Code se escribe en la consola del proceso por su PID
 * (`AttachConsole` + `WriteConsoleInputW`, en `resources/inyectar-consola.ps1`). Solo Windows.
 * Quien llama decide cuándo NO inyectar: con un diálogo abierto (`status: "waiting"`) el Enter
 * final confirmaría la opción seleccionada.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_PROMPT = 200_000;
const TIMEOUT_MS = 20_000;

/** Error con texto ya apto para el usuario; cualquier otro (fs, etc.) puede llevar rutas. */
class ErrorPropio extends Error {}

export type ResultadoInyeccion = { ok: true } | { ok: false; error: string };

/**
 * Quita todos los controles salvo `\n` y `\t`. Sobre todo ESC: con él, el propio texto podría
 * cerrar el pegado entre marcadores (`ESC[201~`) o inyectar secuencias de teclas.
 */
export function sanearPrompt(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function explicar(codigo: string): string {
  const n = Number(codigo.split(":")[1]);
  if (codigo.startsWith("PidNoVerificado")) {
    return "no se pudo confirmar que ese proceso sea la sesión de Claude (no existe, no hay permiso para leerlo o no coincide).";
  }
  if (n === 5) {
    return "sin permiso para escribir en esa consola (¿Claude se ejecuta como administrador?).";
  }
  if (n === 6 || n === 87) {
    return "ese proceso de Claude ya no existe.";
  }
  return "no se pudo escribir en la consola de Claude.";
}

function powershellExe(): string {
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(exe) ? exe : "powershell.exe";
}

/** Escribe `text` en la consola del proceso `pid` y lo envía con un Enter. Nunca registra el texto. */
export async function injectPrompt(
  scriptPath: string,
  pid: number,
  startedAt: number | undefined,
  text: string
): Promise<ResultadoInyeccion> {
  if (process.platform !== "win32") {
    return { ok: false, error: "enviar a la consola de Claude solo funciona en Windows." };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: "PID de la sesión de Claude no válido." };
  }
  // Sin el arranque de la sesión no se puede descartar un PID reciclado por otro programa.
  if (!Number.isFinite(startedAt) || (startedAt ?? 0) <= 0) {
    return { ok: false, error: "la sesión de Claude no trae su hora de arranque." };
  }
  const limpio = sanearPrompt(text);
  if (!limpio.trim()) {
    return { ok: false, error: "el prompt está vacío." };
  }
  if (limpio.length > MAX_PROMPT) {
    return { ok: false, error: `el prompt pasa de ${MAX_PROMPT} caracteres.` };
  }
  const tmp = join(tmpdir(), `alfred-prompt-${randomBytes(12).toString("hex")}.txt`);
  try {
    await fs.writeFile(tmp, limpio, { encoding: "utf8", mode: 0o600 });
    const salida = await new Promise<string>((resolve, reject) => {
      let agotado = false;
      const child = execFile(
        powershellExe(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-ConsolaPid",
          String(pid),
          "-StartedAt",
          String(Math.trunc(startedAt as number)),
          "-TextoFile",
          tmp,
          "-Enviar",
        ],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
        // Con exit 1 el script ya imprimió su JSON: se parsea igualmente. Nunca `err.message`:
        // lleva la ruta del temporal y la línea de comandos.
        (err, stdout) => {
          clearTimeout(timer);
          if (agotado) {
            reject(new ErrorPropio("tiempo agotado: puede que el prompt se haya escrito sin Enter en Claude; revísalo antes de reenviar."));
          } else if (stdout?.trim()) {
            resolve(stdout);
          } else {
            reject(new ErrorPropio(`PowerShell no respondió${err ? ` (${String((err as NodeJS.ErrnoException).code ?? "error")})` : ""}.`));
          }
        }
      );
      // `Add-Type` lanza csc.exe: se mata el árbol, no solo PowerShell.
      const timer = setTimeout(() => {
        agotado = true;
        if (child.pid) {
          execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), [
            "/PID",
            String(child.pid),
            "/T",
            "/F",
          ], { windowsHide: true }, () => undefined);
        }
        child.kill();
      }, TIMEOUT_MS);
    });
    const linea = salida.trim().split(/\r?\n/).pop() ?? "";
    let json: { ok?: boolean; error?: string };
    try {
      json = JSON.parse(linea);
    } catch {
      return { ok: false, error: "respuesta ilegible del inyector." };
    }
    return json.ok ? { ok: true } : { ok: false, error: explicar(String(json.error ?? "")) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ErrorPropio ? err.message : "no se pudo lanzar PowerShell o escribir el temporal.",
    };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
