/**
 * Instalador del servidor MCP en agentes de IA.
 *
 * Detecta qué agentes hay en el equipo, da de alta el servidor donde falte y
 * lo enciende o apaga. En opencode y Claude Code usa su CLI (en el JSON de
 * Claude Code viven credenciales: nunca se escribe a mano); en Claude Desktop
 * y Cursor, su JSON de configuración MCP.
 */
import type * as vscode from "vscode";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import {
  loadMcpServers,
  migrateMcpEntry,
  setMcpEnabled as setOpencodeMcpEnabled,
  type McpServer,
} from "../agents/catalog";

/** Nombre con el que se registra el servidor MCP de la extensión (voz y pizarra). */
export const MCP_NAME = "mcp_alfred";

/** Clave en `globalState`: la persona apagó el MCP a mano. */
export const MCP_OFF_KEY = "opencodeAgents.mcpOff";

export type McpAgentId = "opencode" | "claude-code" | "claude-desktop" | "cursor";

export interface McpAgentState {
  id: McpAgentId;
  label: string;
  /** Tiene entrada `mcp_alfred`. */
  installed: boolean;
  /** ... y no está desactivada. */
  enabled: boolean;
}

export interface McpState {
  /** Solo los agentes presentes en el equipo. */
  agents: McpAgentState[];
  /** Hay al menos uno instalado y encendido. */
  enabled: boolean;
}

const LABELS: Record<McpAgentId, string> = {
  opencode: "opencode",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
};

/**
 * Ruta al ejecutable de node.
 *
 * process.execPath NO sirve: dentro del extension host es Code.exe, así que
 * el agente acabaría lanzando VS Code en lugar del servidor.
 *
 * Exportada para la auto-reparación de `extension.ts`, que reescribe el comando
 * del MCP cuando la extensión cambia de versión.
 */
export function nodeBinary(): string {
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name; // se confía en el PATH del sistema
}

/** Bundle del servidor MCP: viaja dentro de la extensión instalada. */
export function serverScriptPath(extensionPath: string): string {
  return join(extensionPath, "dist", "alfred-mcp.js");
}

/**
 * Comando que arranca el servidor MCP.
 *
 * Se usa `node` con la ruta al bundle en lugar del lanzador de npm: en Windows
 * sus shims .cmd no propagan stdin, y el servidor MCP lo necesita. La ruta
 * lleva la versión instalada, así que al actualizar la extensión cambia:
 * `ensureMcpCommand` (al activar) vuelve a escribirla en la config.
 *
 * Exportado para las comprobaciones automatizadas: aquí se colaba Code.exe
 * (process.execPath) en lugar de node y el agente no podía arrancarlo.
 */
export function serverCommand(extensionPath: string): { command: string; args: string[] } {
  return { command: nodeBinary(), args: [serverScriptPath(extensionPath)] };
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

/** JSON de Claude Desktop. */
function claudeDesktopPath(): string {
  return join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Claude",
    "claude_desktop_config.json",
  );
}

/** JSON de Cursor. */
function cursorPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

/** JSON global de Claude Code: solo se lee (guarda credenciales). */
function claudeCodePath(): string {
  return join(homedir(), ".claude.json");
}

/** Agentes presentes de verdad en el equipo. */
async function presentAgents(): Promise<McpAgentId[]> {
  const [opencode, claude] = await Promise.all([hasCommand("opencode"), hasCommand("claude")]);
  const present: McpAgentId[] = [];
  if (opencode) present.push("opencode");
  if (claude) present.push("claude-code");
  if (existsSync(claudeDesktopPath())) present.push("claude-desktop");
  if (existsSync(join(homedir(), ".cursor"))) present.push("cursor");
  return present;
}

/** Entrada `mcpServers.<nombre>` de un JSON de agente. */
function readJsonEntry(path: string): { installed: boolean; disabled: boolean } {
  try {
    if (!existsSync(path)) return { installed: false, disabled: false };
    const errors: ParseError[] = [];
    const config = parseJsonc(readFileSync(path, "utf8").replace(/^\uFEFF/, ""), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as Record<string, unknown> | undefined;
    if (errors.length > 0) return { installed: false, disabled: false };
    const servers = config?.mcpServers as Record<string, unknown> | undefined;
    const entry = servers?.[MCP_NAME] as Record<string, unknown> | undefined;
    if (!entry) return { installed: false, disabled: false };
    return { installed: true, disabled: entry.disabled === true };
  } catch {
    // Ilegible o con JSON roto: cuenta como no instalado.
    return { installed: false, disabled: false };
  }
}

/** Servidor `mcp_alfred` en la config global de opencode. */
async function opencodeServer(): Promise<McpServer | undefined> {
  try {
    const servers = await loadMcpServers();
    return servers.find((s) => s.name === MCP_NAME && s.scope === "global");
  } catch {
    // Config ilegible: se trata como si no estuviera.
    return undefined;
  }
}

/** Estado de un agente concreto. */
async function stateOf(id: McpAgentId): Promise<{ installed: boolean; enabled: boolean }> {
  if (id === "opencode") {
    const server = await opencodeServer();
    return { installed: Boolean(server), enabled: Boolean(server?.enabled) };
  }
  const entry = readJsonEntry(
    id === "claude-code" ? claudeCodePath() : id === "claude-desktop" ? claudeDesktopPath() : cursorPath(),
  );
  return { installed: entry.installed, enabled: entry.installed && !entry.disabled };
}

/** Estado actual, sin instalar nada. */
export async function mcpState(_context: vscode.ExtensionContext): Promise<McpState> {
  const agents: McpAgentState[] = [];
  for (const id of await presentAgents()) {
    agents.push({ id, label: LABELS[id], ...(await stateOf(id)) });
  }
  return { agents, enabled: agents.some((a) => a.installed && a.enabled) };
}

/** Resultado de un alta o un apagado, en etiquetas de agente. */
interface Outcome {
  changed: string[];
  already: string[];
  failed: string[];
}

/** Frase para el toast: "a, b y c". */
function lista(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}` : items[0] ?? "";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Da de alta en opencode con su propio comando. */
async function enableOpencode(command: string, args: string[]): Promise<void> {
  // --global es imprescindible: sin él, opencode escribe en el config del
  // proyecto abierto y el agente no lo ve en ningún otro sitio.
  // Antes de dar de alta el nombre nuevo se retira el `voz` propio de versiones
  // anteriores, o quedarían dos servidores iguales.
  await migrateMcpEntry("voz", MCP_NAME, [command, ...args]);
  // La migración puede haber creado ya la entrada: entonces solo queda encenderla.
  const server = await opencodeServer();
  if (server) {
    if (!server.enabled) await setOpencodeMcpEnabled(server, true);
    return;
  }
  // 'add' sobrescribe la entrada si ya existía (no hay 'mcp remove' en v2).
  const res = await run("opencode", ["mcp", "add", "--global", MCP_NAME, "--", command, ...args]);
  if (!res.ok) throw new Error(res.out.slice(0, 200) || "opencode mcp add falló");
  const check = await run("opencode", ["mcp", "list"]);
  const line = check.out.split(/\r?\n/).find((l) => new RegExp(`\\b${MCP_NAME}\\b`).test(l)) ?? "";
  if (!line) throw new Error("opencode no confirma la entrada");
}

/** Da de alta en Claude Code con su CLI. */
async function enableClaudeCode(command: string, args: string[]): Promise<void> {
  // --scope user para que valga en todos los proyectos. Se usa el CLI y no se
  // escribe ~/.claude.json a mano: ahí viven las credenciales.
  // Borrar antes de añadir evita que re-instalar falle con "already exists";
  // si no existía, remove falla y da igual. Se retiran el nombre nuevo y el
  // viejo (`voz`) para no dejar dos entradas del mismo servidor.
  await run("claude", ["mcp", "remove", "--scope", "user", "voz"]);
  await run("claude", ["mcp", "remove", "--scope", "user", MCP_NAME]);
  const res = await run("claude", [
    "mcp",
    "add",
    "--scope",
    "user",
    MCP_NAME,
    "--",
    command,
    ...args,
  ]);
  if (!res.ok) throw new Error(res.out.slice(0, 200) || "claude mcp add falló");
  // `mcp get` devuelve exit 0 solo si el servidor existe.
  const check = await run("claude", ["mcp", "get", MCP_NAME]);
  if (!check.ok) throw new Error("Claude Code no confirma la entrada");
}

/** Formato que usa `jsonc-parser` al insertar: el del resto de la extensión. */
const FMT = { insertSpaces: true, tabSize: 2, eol: "\n" };

/** Escritura atómica (tmp + rename): un fichero de agente a medias lo deja ilegible. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Texto JSONC del fichero (sin BOM), o error si no se puede leer: no se pisa la config ajena. */
function readJsonText(path: string): string {
  if (!existsSync(path)) return "{}\n";
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const errors: ParseError[] = [];
  parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true });
  if (errors.length > 0) throw new Error(`JSON ilegible en ${path}`);
  return raw;
}

/** Escribe la configuración MCP en un archivo JSON, conservando el resto y su formato. */
function writeJsonConfig(path: string, command: string, args: string[]): void {
  const text = readJsonText(path);
  let next = text;
  // La entrada `voz` de versiones anteriores apunta al bundle del que ya no
  // hablamos: se retira, salvo que sea de otro servidor con ese mismo nombre.
  const parsed = parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false }) as
    | Record<string, { voz?: { command?: unknown; args?: unknown } }>
    | undefined;
  const legacy = parsed?.mcpServers?.voz;
  const legacyBits = legacy
    ? [legacy.command, ...(Array.isArray(legacy.args) ? legacy.args : [])]
    : [];
  if (legacyBits.some((v) => typeof v === "string" && v.endsWith("voz-mcp.js"))) {
    next = applyEdits(next, modify(next, ["mcpServers", "voz"], undefined, { formattingOptions: FMT }));
  }
  next = applyEdits(
    next,
    modify(next, ["mcpServers", MCP_NAME], { command, args }, { formattingOptions: FMT })
  );
  if (next !== text) writeAtomic(path, next);
}

/** Quita `mcpServers.mcp_alfred` de un JSON y deja el fichero válido. */
function removeJsonEntry(path: string): void {
  if (!existsSync(path)) return;
  const text = readJsonText(path);
  const parsed = parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false }) as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!parsed?.mcpServers?.[MCP_NAME]) return;
  const next = applyEdits(text, modify(text, ["mcpServers", MCP_NAME], undefined, { formattingOptions: FMT }));
  if (next !== text) writeAtomic(path, next);
}

/** Ruta del JSON de un agente sin CLI. */
function jsonPathOf(id: McpAgentId): string {
  return id === "claude-desktop" ? claudeDesktopPath() : cursorPath();
}

/** Alta (y encendido) en todos los agentes presentes. */
async function enableAll(context: vscode.ExtensionContext): Promise<Outcome> {
  const { command, args } = serverCommand(context.extensionPath);
  const outcome: Outcome = { changed: [], already: [], failed: [] };
  for (const id of await presentAgents()) {
    const label = LABELS[id];
    try {
      const state = await stateOf(id);
      if (state.installed && state.enabled) {
        outcome.already.push(label);
        continue;
      }
      if (id === "opencode") await enableOpencode(command, args);
      else if (id === "claude-code") await enableClaudeCode(command, args);
      else writeJsonConfig(jsonPathOf(id), command, args);
      outcome.changed.push(label);
    } catch (err) {
      outcome.failed.push(`${label} (${errText(err)})`);
    }
  }
  await context.globalState.update(MCP_OFF_KEY, false);
  return outcome;
}

/** Apagado: no borra el fichero de nadie, solo la entrada. */
async function disableAll(context: vscode.ExtensionContext): Promise<Outcome> {
  const outcome: Outcome = { changed: [], already: [], failed: [] };
  for (const id of await presentAgents()) {
    const label = LABELS[id];
    try {
      const state = await stateOf(id);
      if (!state.installed) continue;
      if (id === "opencode") {
        // Queda la entrada con `disabled`: apagarla no es perderla.
        const server = await opencodeServer();
        if (!server?.enabled) {
          outcome.already.push(label);
          continue;
        }
        await setOpencodeMcpEnabled(server, false);
      } else if (id === "claude-code") {
        const res = await run("claude", ["mcp", "remove", "--scope", "user", MCP_NAME]);
        if (!res.ok) throw new Error(res.out.slice(0, 200) || "claude mcp remove falló");
      } else {
        removeJsonEntry(jsonPathOf(id));
      }
      outcome.changed.push(label);
    } catch (err) {
      outcome.failed.push(`${label} (${errText(err)})`);
    }
  }
  await context.globalState.update(MCP_OFF_KEY, true);
  return outcome;
}

/** "ALFRED MCP: instalado en X.", con los fallos al final. */
function describe(verb: "instalado" | "activado", outcome: Outcome): string {
  let text: string;
  if (outcome.changed.length > 0) text = `ALFRED MCP: ${verb} en ${lista(outcome.changed)}.`;
  else if (outcome.already.length > 0) text = `ALFRED MCP: ya estaba activo en ${lista(outcome.already)}.`;
  else if (outcome.failed.length > 0) text = "ALFRED MCP: no se pudo activar.";
  else text = "ALFRED MCP: no hay ningún agente instalado en el equipo.";
  if (outcome.failed.length > 0) text += ` No se pudo en ${lista(outcome.failed)}.`;
  return text;
}

/** Da de alta el MCP solo en los agentes presentes donde falte, y lo enciende donde esté apagado. */
export async function installMcp(context: vscode.ExtensionContext): Promise<string> {
  if (!existsSync(serverScriptPath(context.extensionPath))) {
    return "Falta dist/alfred-mcp.js: recompila la extensión (npm run compile) antes de instalar el MCP.";
  }
  return describe("instalado", await enableAll(context));
}

/** Enciende (instala lo que falte) o apaga (sin borrar el fichero de nadie) y recuerda la elección. */
export async function setMcpEnabled(
  context: vscode.ExtensionContext,
  enabled: boolean,
): Promise<string> {
  if (!enabled) {
    const outcome = await disableAll(context);
    let text = "ALFRED MCP apagado.";
    if (outcome.failed.length > 0) text += ` No se pudo en ${lista(outcome.failed)}.`;
    return text;
  }
  if (!existsSync(serverScriptPath(context.extensionPath))) {
    return "Falta dist/alfred-mcp.js: recompila la extensión (npm run compile) antes de activar el MCP.";
  }
  return describe("activado", await enableAll(context));
}
