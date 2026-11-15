/**
 * Servidor MCP `mcp_alfred` por stdio (JSON-RPC 2.0, un objeto por línea): cubre la voz
 * (`speak`, `list_voices`), las herramientas de la pizarra y el generador de imágenes.
 *
 * Corre como proceso propio, lanzado por el agente: aquí NO hay `vscode`.
 * stdout es solo protocolo; cualquier diagnóstico va a stderr. Reutiliza los
 * motores y el reproductor de `src/voice/core` y deja la reproducción en
 * `%APPDATA%\voz\now.json` para que el panel de la extensión ecualice.
 */
import { createInterface } from "node:readline";
import { callPizarraTool, PIZARRA_TOOLS } from "./alfredPizarra";
import { callImageTool, IMAGE_TOOLS } from "./alfredImages";
import { callVozTool, VOZ_TOOLS } from "./alfredVoz";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mcp_alfred", version: "1.4.0" };

/** Todo lo que publica el servidor: voz, pizarra e imágenes. */
const TOOLS = [...VOZ_TOOLS, ...PIZARRA_TOOLS, ...IMAGE_TOOLS];

/** Escribe un mensaje JSON-RPC en stdout. */
function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Ejecuta una herramienta; cualquier fallo vuelve como `isError`, no como caída. */
async function callTool(params: unknown): Promise<unknown> {
  const { name, arguments: args } =
    (params ?? {}) as { name?: unknown; arguments?: unknown };
  const input = (args ?? {}) as Record<string, unknown>;

  try {
    const voz = typeof name === "string" ? await callVozTool(name, input) : undefined;
    if (voz !== undefined) {
      return { content: [{ type: "text", text: voz }] };
    }
    const pizarra = typeof name === "string" ? await callPizarraTool(name, input) : undefined;
    if (pizarra !== undefined) {
      return { content: [{ type: "text", text: pizarra }] };
    }
    const imagen = typeof name === "string" ? await callImageTool(name, input) : undefined;
    if (imagen !== undefined) {
      return { content: [{ type: "text", text: imagen }] };
    }
    throw new Error(`Herramienta desconocida: ${String(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Resuelve una línea del protocolo. */
async function handleMessage(msg: unknown): Promise<void> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    replyError(null, -32600, "Petición JSON-RPC inválida.");
    return;
  }

  const request = msg as { id?: unknown; method?: unknown; params?: unknown };
  const hasId = "id" in request;

  if (typeof request.method !== "string") {
    if (hasId) replyError(request.id, -32600, "Petición JSON-RPC inválida.");
    return;
  }
  // Notificaciones (incluida `notifications/initialized`): sin respuesta.
  if (!hasId) return;

  switch (request.method) {
    case "initialize": {
      const asked = (request.params as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
      reply(request.id, {
        protocolVersion: typeof asked === "string" ? asked : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case "ping":
      reply(request.id, {});
      return;
    case "tools/list":
      reply(request.id, { tools: TOOLS });
      return;
    case "tools/call":
      reply(request.id, await callTool(request.params));
      return;
    default:
      replyError(request.id, -32601, `Método no encontrado: ${request.method}`);
  }
}

/** Id de una línea con JSON roto, si se puede leer del texto. */
function idOfBrokenJson(line: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(line);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

async function handleLine(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;

  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    const id = idOfBrokenJson(text);
    if (id === undefined) {
      process.stderr.write(`[alfred] JSON inválido: ${text.slice(0, 120)}\n`);
      return;
    }
    replyError(id, -32700, "JSON inválido.");
    return;
  }

  await handleMessage(msg);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

// En cola: una respuesta por petición y en orden, sin dos reproducciones a la vez.
let queue = Promise.resolve();

lines.on("line", (line) => {
  // Ninguna línea puede tumbar el proceso: la sesión MCP vive hasta cerrar stdin.
  queue = queue.then(() => handleLine(line)).catch((err) => {
    process.stderr.write(`[alfred] ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

lines.on("close", () => {
  // No se corta la llamada en curso: se espera y se vacía stdout antes de salir.
  void queue.then(() => process.stdout.write("", () => process.exit(0)));
});
