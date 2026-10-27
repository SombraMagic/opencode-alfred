/**
 * Contrato común de los motores de texto-a-voz.
 */

export type MotorId = "sapi" | "edge" | "openai" | "elevenlabs" | "azure" | "google" | "aws";

export interface VoiceInfo {
  id: string;
  name: string;
  locale: string;
  gender: "male" | "female" | "neutral";
  engine?: string;
}

export interface SynthOptions {
  /** Velocidad en porcentaje: +30 = 30% más rápido. Rango -50..+100. */
  rate?: number;
  /** Tono en Hz: +10 = 10 Hz más agudo. Rango -50..+50. */
  pitch?: number;
  /** Volumen 0..100. */
  volume?: number;
  /** Formato de salida de audio. */
  format?: "wav" | "mp3";
}

export interface SynthResult {
  /** Audio listo para reproducir. */
  data: Buffer;
  format: "wav" | "mp3";
  /** Duración en milisegundos, si se conoce. */
  durationMs?: number;
  /** Texto que realmente se dijo (puede normalizarse). */
  text: string;
  engine: MotorId;
  voice: string;
}

export interface TtsMotor {
  readonly id: MotorId;
  /** Nombre legible para la interfaz. */
  readonly label: string;
  /** true si el motor funciona sin claves de API. */
  readonly free: boolean;
  /** true si necesita conexión a internet. */
  readonly needsNetwork: boolean;
  /** true si el motor está configurado y listo (p.ej. clave de API presente). */
  isAvailable(): Promise<boolean>;
  listVoices(): Promise<VoiceInfo[]>;
  synthesize(text: string, voice: string, options?: SynthOptions): Promise<SynthResult>;
}
