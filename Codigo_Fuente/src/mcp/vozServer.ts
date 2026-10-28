/**
 * Servidor MCP `voz` por stdio (JSON-RPC 2.0, un objeto por línea).
 *
 * Corre como proceso propio, lanzado por el agente: aquí NO hay `vscode`.
 * stdout es solo protocolo; cualquier diagnóstico va a stderr. Reutiliza los
 * motores y el reproductor de `src/voice/core` y deja la reproducción en
 * `%APPDATA%\voz\now.json` para que el panel de la extensión ecualice.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createMotors,
  envelope,
  keysFromEnv,
  pickMotor,
  playPcm,
  publishPlayback,
  readConfig,
  resolveVoice,
  toPcm,
} from "../voice/core/index.js";
import type { TtsMotor } from "../voice/core/index.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "voz", version: "1.0.0" };

const ENGINES = ["sapi", "edge", "openai", "elevenlabs"];

const TOOLS = [
  {
    name: "speak",
    description: "Lee un texto en voz alta con el motor de voz configurado.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        engine: { type: "string", enum: ENGINES },
        rate: { type: "number", minimum: -50, maximum: 100 },
        pitch: { type: "number", minimum: -50, maximum: 50 },
        volume: { type: "number", minimum: 0, maximum: 100 },
        device: { type: "integer" },
      },
      required: ["text"],
    },
  },
  {
    name: "list_voices",
    description: "Lista las voces instaladas de un motor de texto a voz.",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ENGINES },
      },
    },
  },
];

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

/** Número del argumento, o el valor por defecto de la configuración compartida. */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Motor pedido (o el de la configuración compartida), ya comprobado. */
async function selectMotor(engine: string): Promise<TtsMotor> {
  // createMotors solo crea los motores de pago si hay clave en el entorno:
  // si el pedido no está en la lista, pickMotor devolvería otro en silencio.
  const motor = pickMotor(createMotors(keysFromEnv()), engine);
  if (motor.id !== engine) {
    throw new Error(
      `El motor "${engine}" no está disponible: falta su clave de API en el entorno.`,
    );
  }
  if (!(await motor.isAvailable())) {
    throw new Error(`El motor "${motor.label}" no está disponible en este equipo.`);
  }
  return motor;
}

/** `speak`: sintetiza, publica el evento de reproducción y espera a que suene. */
async function speak(args: Record<string, unknown>): Promise<string> {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) throw new Error("El texto está vacío: no hay nada que decir.");

  const config = readConfig();
  const motor = await selectMotor(
    typeof args.engine === "string" ? args.engine : config.engine ?? "sapi",
  );

  // La voz guardada puede no existir en este motor: resolveVoice cae a la primera.
  const voice = await resolveVoice(motor, config.voice);
  const result = await motor.synthesize(text, voice, {
    rate: num(args.rate, config.rate ?? 0),
    pitch: num(args.pitch, config.pitch ?? 0),
    volume: num(args.volume, config.volume ?? 100),
  });

  const pcm = await toPcm(result.data, result.format);
  const envelope32 = envelope(pcm, 32);
  // Serie temporal de energía: hace que las barras latan con la voz.
  const energy = envelope(pcm, 64);
  const device = num(args.device, config.device ?? -1);

  // Antes de bloquear la reproducción: el panel ya puede mover el ecualizador.
  publishPlayback({
    id: randomUUID(),
    startedAt: Date.now(),
    durationMs: pcm.durationMs,
    envelope: envelope32,
    energy,
    text,
  });

  await playPcm(pcm, device < 0 ? undefined : device);

  return `Dicho con ${motor.label}, voz «${voice}»: ${(pcm.durationMs / 1000).toFixed(1)} s.`;
}

/** `list_voices`: voces del motor pedido en JSON compacto. */
async function listVoices(args: Record<string, unknown>): Promise<string> {
  const config = readConfig();
  const motor = await selectMotor(
    typeof args.engine === "string" ? args.engine : config.engine ?? "sapi",
  );
  return JSON.stringify(await motor.listVoices());
}

/** Ejecuta una herramienta; cualquier fallo vuelve como `isError`, no como caída. */
async function callTool(params: unknown): Promise<unknown> {
  const { name, arguments: args } =
    (params ?? {}) as { name?: unknown; arguments?: unknown };
  const input = (args ?? {}) as Record<string, unknown>;

  try {
    if (name === "speak") {
      return { content: [{ type: "text", text: await speak(input) }] };
    }
    if (name === "list_voices") {
      return { content: [{ type: "text", text: await listVoices(input) }] };
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
      process.stderr.write(`[voz] JSON inválido: ${text.slice(0, 120)}\n`);
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
    process.stderr.write(`[voz] ${err instanceof Error ? err.message : String(err)}\n`);
  });
});

lines.on("close", () => {
  // No se corta la llamada en curso: se espera y se vacía stdout antes de salir.
  void queue.then(() => process.stdout.write("", () => process.exit(0)));
});
