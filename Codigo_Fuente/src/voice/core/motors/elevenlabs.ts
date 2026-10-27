/**
 * Motor ElevenLabs. Requiere ELEVENLABS_API_KEY.
 * La lista de voces se consulta en /v1/voices con la clave.
 */
import type { MotorId, SynthOptions, SynthResult, TtsMotor, VoiceInfo } from "../types.js";

const API = "https://api.elevenlabs.io/v1";

export class ElevenLabsMotor implements TtsMotor {
  readonly id: MotorId = "elevenlabs";
  readonly label = "ElevenLabs";
  readonly free = false;
  readonly needsNetwork = true;

  constructor(private readonly apiKey: string) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const res = await fetch(`${API}/voices`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs falló al listar voces (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      voices: Array<{
        voice_id: string;
        name: string;
        labels?: { language?: string; gender?: string };
      }>;
    };
    return json.voices.map((v) => ({
      id: v.voice_id,
      name: v.name,
      locale: v.labels?.language ?? "en-US",
      gender:
        v.labels?.gender === "male" ? "male" : v.labels?.gender === "female" ? "female" : "neutral",
      engine: "elevenlabs",
    }));
  }

  async synthesize(text: string, voice: string, options: SynthOptions = {}): Promise<SynthResult> {
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voice)}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: Math.max(0.7, Math.min(1.2, 1 + (options.rate ?? 0) / 400)),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs TTS falló (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    return { data, format: "mp3", text, engine: this.id, voice };
  }
}
