/**
 * Motor OpenAI (TTS). Requiere OPENAI_API_KEY.
 * Modelos: gpt-4o-mini-tts (actual), tts-1, tts-1-hd.
 */
import type { MotorId, SynthOptions, SynthResult, TtsMotor, VoiceInfo } from "../types.js";

const ENDPOINT = "https://api.openai.com/v1/audio/speech";

/** Voces de OpenAI con su etiqueta. */
const OPENAI_VOICES: Array<{ id: string; name: string; gender: "male" | "female" | "neutral" }> = [
  { id: "alloy", name: "Alloy", gender: "neutral" },
  { id: "ash", name: "Ash", gender: "male" },
  { id: "ballad", name: "Ballad", gender: "male" },
  { id: "coral", name: "Coral", gender: "female" },
  { id: "echo", name: "Echo", gender: "male" },
  { id: "fable", name: "Fable", gender: "male" },
  { id: "onyx", name: "Onyx", gender: "male" },
  { id: "nova", name: "Nova", gender: "female" },
  { id: "sage", name: "Sage", gender: "female" },
  { id: "shimmer", name: "Shimmer", gender: "female" },
];

export class OpenAIMotor implements TtsMotor {
  readonly id: MotorId = "openai";
  readonly label = "OpenAI";
  readonly free = false;
  readonly needsNetwork = true;

  constructor(private readonly apiKey: string) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return OPENAI_VOICES.map((v) => ({
      id: v.id,
      name: v.name,
      locale: "en-US",
      gender: v.gender,
      engine: "openai",
    }));
  }

  async synthesize(text: string, voice: string, options: SynthOptions = {}): Promise<SynthResult> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: voice || "alloy",
        input: text,
        response_format: "mp3",
        speed: Math.max(0.25, Math.min(4, 1 + (options.rate ?? 0) / 100)),
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI TTS falló (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    return { data, format: "mp3", text, engine: this.id, voice };
  }
}
