/**
 * Registro de motores de texto-a-voz.
 *
 * Los motores de pago se crean sólo si hay clave configurada; sin ella, la
 * interfaz los muestra como no disponibles en lugar de fallar.
 */
import { SapiMotor } from "./motors/sapi.js";
import { EdgeMotor } from "./motors/edge.js";
import { OpenAIMotor } from "./motors/openai.js";
import { ElevenLabsMotor } from "./motors/elevenlabs.js";
import type { MotorId, TtsMotor } from "./types.js";

export type { MotorId, SynthOptions, SynthResult, TtsMotor, VoiceInfo } from "./types.js";
export { toPcm, wavToPcm, mp3ToPcm, envelope, mixToMono } from "./pcm.js";
export type { Pcm } from "./pcm.js";
export { listOutputDevices, playPcm } from "./player.js";
export type { OutputDevice } from "./player.js";
export { hasMicrophone, startRecording, wavOf, RECORD_RATE } from "./recorder.js";
export type { Recorder, Recording } from "./recorder.js";
export { denoiseWav, noiseFloorDb, voiceMs } from "./noise.js";
export type { DenoiseOptions } from "./noise.js";
export {
  stateDir,
  readConfig,
  writeConfig,
  publishPlayback,
  resolveVoice,
} from "./shared.js";
export type { VozConfig, PlaybackEvent } from "./shared.js";

/** Claves de API leídas del entorno. */
export interface ProviderKeys {
  openai?: string;
  elevenlabs?: string;
  azure?: string;
  azureRegion?: string;
  google?: string;
  awsAccessKey?: string;
  awsSecretKey?: string;
  awsRegion?: string;
}

/** Lee las claves del entorno. */
export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderKeys {
  return {
    openai: env.OPENAI_API_KEY,
    elevenlabs: env.ELEVENLABS_API_KEY,
    azure: env.AZURE_SPEECH_KEY,
    azureRegion: env.AZURE_SPEECH_REGION,
    google: env.GOOGLE_TTS_API_KEY,
    awsAccessKey: env.AWS_ACCESS_KEY_ID,
    awsSecretKey: env.AWS_SECRET_ACCESS_KEY,
    awsRegion: env.AWS_REGION,
  };
}

/** Crea todos los motores conocidos, con las claves disponibles. */
export function createMotors(keys: ProviderKeys = keysFromEnv()): TtsMotor[] {
  const motors: TtsMotor[] = [new SapiMotor(), new EdgeMotor()];
  if (keys.openai) motors.push(new OpenAIMotor(keys.openai));
  if (keys.elevenlabs) motors.push(new ElevenLabsMotor(keys.elevenlabs));
  return motors;
}

/** Motor predeterminado: Windows, porque funciona sin configuración y sin red. */
export const DEFAULT_MOTOR: MotorId = "sapi";

/** Motor por defecto de un conjunto de motores. */
export function pickMotor(motors: TtsMotor[], id?: string): TtsMotor {
  return motors.find((m) => m.id === id) ?? motors[0];
}
