import * as vscode from "vscode";
import {
  createMotors,
  envelope,
  listOutputDevices,
  pickMotor,
  playPcm,
  resolveVoice,
  toPcm,
  writeConfig,
} from "./core/index.js";
import type { MotorId, TtsMotor, VoiceInfo } from "./core/types.js";

/** Configuración actual de la extensión. */
export interface VozSettings {
  engine: MotorId;
  voice: string;
  rate: number;
  pitch: number;
  volume: number;
  outputDevice: number;
}

/** Lee los ajustes del workspace. */
export function readSettings(): VozSettings {
  const cfg = vscode.workspace.getConfiguration("voz");
  return {
    engine: cfg.get("engine", "sapi") as MotorId,
    voice: cfg.get("voice", ""),
    rate: cfg.get("rate", 0),
    pitch: cfg.get("pitch", 0),
    volume: cfg.get("volume", 100),
    outputDevice: cfg.get("outputDevice", -1),
  };
}

/**
 * Copia los ajustes al estado compartido (%APPDATA%\voz\config.json) para
 * que el servidor MCP hable con el mismo motor, voz y velocidad que el panel.
 * Sin esto son dos almacenes independientes y el agente usa la primera voz.
 */
export async function syncSharedConfig(): Promise<void> {
  const s = readSettings();
  try {
    writeConfig({
      engine: s.engine,
      // Si este perfil no tiene voz guardada, no se borra la que ya había:
      // otra ventana de VS Code con otros ajustes la pisaría.
      ...(s.voice ? { voice: s.voice } : {}),
      rate: s.rate,
      pitch: s.pitch,
      volume: s.volume,
      device: s.outputDevice,
    });
  } catch {
    // Sin permisos de escritura: el MCP usará sus valores por defecto.
  }
}

/** Motores disponibles con su estado. */
export async function describeMotors(): Promise<
  Array<{ id: string; label: string; free: boolean; needsNetwork: boolean; available: boolean }>
> {
  const motors = createMotors();
  return Promise.all(
    motors.map(async (m) => ({
      id: m.id,
      label: m.label,
      free: m.free,
      needsNetwork: m.needsNetwork,
      available: await m.isAvailable(),
    })),
  );
}

/** Voces de un motor. */
export async function listVoices(motorId: string): Promise<VoiceInfo[]> {
  const motors = createMotors();
  const motor = pickMotor(motors, motorId);
  try {
    return await motor.listVoices();
  } catch {
    return [];
  }
}

/** Sintetiza y reproduce. Avisa con `onStart` justo antes de sonar. */
export async function speak(
  text: string,
  engineId: string,
  opts?: { rate?: number; pitch?: number; volume?: number; device?: number },
  onStart?: (info: {
    envelope: number[];
    energy: number[];
    durationMs: number;
    voice: string;
  }) => void,
): Promise<{ envelope: number[]; durationMs: number; voice: string; engine: string }> {
  const settings = readSettings();
  const motors = createMotors();
  const motor: TtsMotor = pickMotor(motors, engineId || settings.engine);

  // Si la voz guardada no existe en este motor (p. ej. se cambió de Edge a
  // SAPI), se usa la primera en lugar de fallar.
  const voice = await resolveVoice(motor, settings.voice);
  const result = await motor.synthesize(text, voice, {
    rate: opts?.rate ?? settings.rate,
    pitch: opts?.pitch ?? settings.pitch,
    volume: opts?.volume ?? settings.volume,
  });

  const pcm = await toPcm(result.data, result.format);
  const env = envelope(pcm, 32);
  // Serie temporal de energía: hace que la esfera lata con la voz.
  const energy = envelope(pcm, 64);

  // Antes de bloquear la reproducción: el ecualizador ya puede moverse.
  onStart?.({ envelope: env, energy, durationMs: pcm.durationMs, voice });

  const device = opts?.device ?? settings.outputDevice;
  await playPcm(pcm, device < 0 ? undefined : device);

  return {
    envelope: env,
    durationMs: pcm.durationMs,
    voice,
    engine: motor.label,
  };
}

/** Dispositivos de salida. */
export async function devices() {
  return listOutputDevices();
}
