/**
 * Instalador del servidor MCP en agentes de IA.
 *
 * Detecta el agente, escribe su configuración y deja el servidor listo.
 * En opencode usa `opencode mcp add`; en el resto, escribe el JSON de
 * configuración MCP estándar.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Ruta al ejecutable de node.
 *
 * process.execPath NO sirve: dentro del extension host es Code.exe, así que
 * el agente acabaría lanzando VS Code en lugar del servidor.
 */
function nodeBinary(): string {
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name; // se confía en el PATH del sistema
}

/**
 * Comando que arranca el servidor MCP.
 *
 * Se usa `node` con la ruta al script en lugar de `npx`: en Windows los
 * shims .cmd de npm no propagan stdin, y el servidor MCP lo necesita.
 * Si el paquete está publicado, `npx -y @sombra/voz-mcp` también vale.
 *
 * Exportado para las comprobaciones automatizadas: aquí se colaba Code.exe
 * (process.execPath) en lugar de node y el agente no podía arrancarlo.
 */
export function serverCommand(): { command: string; args: string[] } {
  const local = join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@sombra",
    "voz-mcp",
    "dist",
    "index.js",
  );
  if (existsSync(local)) return { command: nodeBinary(), args: [local] };
  return { command: "npx", args: ["-y", "@sombra/voz-mcp"] };
}

/** Ejecuta un comando y devuelve su salida. */
function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Comprueba si un comando existe en el PATH. */
async function hasCommand(cmd: string): Promise<boolean> {
  const res = await run(process.platform === "win32" ? "where" : "which", [cmd]);
  return res.ok;
}

/** Claves de registro de Windows para localizar a Claude Desktop. */
function claudeConfigPath(): string {
  return join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Claude",
    "claude_desktop_config.json",
  );
}

/** Instala el servidor MCP donde se le pida. */
export async function installMcp(): Promise<string> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "opencode", description: "Instalar en opencode (recomendado)" },
      { label: "Claude Code", description: "Instalar en Claude Code (usuario)" },
      { label: "Claude Desktop", description: "Instalar en Claude Desktop" },
      { label: "Cursor", description: "Instalar en ~/.cursor/mcp.json" },
      { label: "Otro agente", description: "Copiar la configuración a mano" },
    ],
    { title: "VOZ: ¿dónde instalar el servidor MCP de voz?" },
  );
  if (!choice) return "Instalación cancelada.";

  const { command, args } = serverCommand();

  switch (choice.label) {
    case "opencode":
      return installOpencode(command, args);
    case "Claude Code":
      return installClaudeCode(command, args);
    case "Claude Desktop":
      return writeJsonConfig(claudeConfigPath(), "mcpServers", command, args);
    case "Cursor":
      return writeJsonConfig(join(homedir(), ".cursor", "mcp.json"), "mcpServers", command, args);
    default:
      return showManualConfig(command, args);
  }
}

/** Instala en opencode con su propio comando. */
async function installOpencode(command: string, args: string[]): Promise<string> {
  if (!(await hasCommand("opencode"))) {
    return "No se encontró opencode en el PATH. Instálalo o usa 'Otro agente'.";
  }
  // --global es imprescindible: sin él, opencode escribe en el config del
  // proyecto abierto y el agente no lo ve en ningún otro sitio.
  // 'add' sobrescribe la entrada si ya existía (no hay 'mcp remove' en v2).
  const res = await run("opencode", ["mcp", "add", "--global", "voz", "--", command, ...args]);
  if (!res.ok) {
    return `No se pudo instalar en opencode: ${res.out.slice(0, 200)}`;
  }

  const check = await run("opencode", ["mcp", "list"]);
  const line = check.out.split(/\r?\n/).find((l) => /\bvoz\b/.test(l)) ?? "";
  const ok = line.length > 0 && !line.includes("disabled");
  vscode.window.showInformationMessage(
    ok
      ? "VOZ: servidor MCP instalado en opencode. Reinicia opencode para que lo cargue."
      : `VOZ: servidor MCP añadido a opencode, pero aparece como "${line.trim()}".`,
  );
  return ok ? "Instalado en opencode ✓" : `Añadido a opencode (${line.trim() || "sin confirmar"})`;
}

/** Instala en Claude Code con su CLI. */
async function installClaudeCode(command: string, args: string[]): Promise<string> {
  if (!(await hasCommand("claude"))) {
    return "No se encontró Claude Code en el PATH. Instálalo o usa 'Otro agente'.";
  }
  // --scope user para que valga en todos los proyectos. Se usa el CLI y no se
  // escribe ~/.claude.json a mano: ahí viven las credenciales.
  // Borrar antes de añadir evita que re-instalar falle con "already exists";
  // si no existía, remove falla y da igual. `add` deja la entrada nueva.
  await run("claude", ["mcp", "remove", "--scope", "user", "voz"]);
  const res = await run("claude", ["mcp", "add", "--scope", "user", "voz", "--", command, ...args]);
  if (!res.ok) {
    return `No se pudo instalar en Claude Code: ${res.out.slice(0, 200)}`;
  }

  // `mcp get` devuelve exit 0 solo si el servidor existe.
  const check = await run("claude", ["mcp", "get", "voz"]);
  if (check.ok) {
    vscode.window.showInformationMessage(
      "VOZ: servidor MCP instalado en Claude Code. Abre una sesión nueva para que lo cargue.",
    );
    return "Instalado en Claude Code ✓";
  }
  vscode.window.showWarningMessage(
    `VOZ: servidor MCP añadido a Claude Code, pero no se pudo confirmar: ${check.out.slice(0, 120)}`,
  );
  return "Añadido a Claude Code (sin confirmar)";
}

/** Escribe la configuración MCP en un archivo JSON. */
function writeJsonConfig(
  path: string,
  key: string,
  command: string,
  args: string[],
): string {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      config = {};
    }
  }
  const servers = (config[key] ?? {}) as Record<string, unknown>;
  servers.voz = { command, args };
  config[key] = servers;

  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
  vscode.window.showInformationMessage(`VOZ: servidor MCP guardado en ${path}`);
  return `Guardado en ${path}`;
}

/** Muestra la configuración para copiarla a mano. */
async function showManualConfig(command: string, args: string[]): Promise<string> {
  const config = JSON.stringify({ mcpServers: { voz: { command, args } } }, null, 2);
  await vscode.env.clipboard.writeText(config);
  vscode.window.showInformationMessage("VOZ: configuración copiada al portapapeles.");
  return "Configuración copiada al portapapeles";
}
