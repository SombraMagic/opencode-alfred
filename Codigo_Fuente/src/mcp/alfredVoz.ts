/**
 * Herramientas de voz de `mcp_alfred` (`speak`, `list_voices`). Sin `vscode`: las usan el
 * servidor MCP (`alfredServer.ts`) y el chatbot de la extensión, con la misma lógica.
 * Leen la configuración compartida (`%APPDATA%\voz\config.json`) y publican la reproducción
 * en `now.json` para que el ecualizador del panel la siga.
 */
import { randomUUID } from "node:crypto";
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

const ENGINES = ["sapi", "edge", "openai", "elevenlabs"];

export const VOZ_TOOLS = [
  {
    name: "speak",
    description:
      "Lee un texto en voz alta con el motor de voz configurado.",
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

/**
 * `speak`: sintetiza, publica el evento de reproducción y espera a que suene.
 * Con `signal` (el chat) deja de esperar al abortar; el audio ya lanzado acaba solo,
 * porque `playPcm` no se puede cortar.
 */
async function speak(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
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

  if (signal?.aborted) throw new Error("Generación cancelada.");

  // Antes de bloquear la reproducción: el panel ya puede mover el ecualizador.
  publishPlayback({
    id: randomUUID(),
    startedAt: Date.now(),
    durationMs: pcm.durationMs,
    envelope: envelope32,
    energy,
    text,
  });

  const playing = playPcm(pcm, device < 0 ? undefined : device);
  if (signal) {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Generación cancelada."));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Si gana la cancelación, el rechazo posterior de `playing` no debe quedar sin atender.
    playing.catch(() => {});
    try {
      await Promise.race([playing, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  } else {
    await playing;
  }

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

/** Ejecuta una herramienta de voz; `undefined` si el nombre no es suyo. */
export async function callVozTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (name === "speak") return speak(args, signal);
  if (name === "list_voices") return listVoices(args);
  return undefined;
}
