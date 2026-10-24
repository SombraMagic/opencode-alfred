/**
 * Cliente mínimo del servicio "Read aloud" de Edge.
 *
 * No se usa la librería msedge-tts porque fija cabeceras y versión de cliente:
 * cuando Microsoft las cambia (y cambia a menudo) deja de conectar sin más
 * explicación que un HTTP 200 en el handshake. Aquí el protocolo está a la
 * vista: token, cabeceras, SSML y tramas.
 *
 * Requiere internet y no tiene ninguna garantía: el servicio es no oficial.
 */
import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1";
const VOICES_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";
/** Debe ir en la onda con la versión de Edge que se anuncia en el User-Agent. */
const EDGE_VERSION = "155.0.4283.45";
const GEC_VERSION = `1-${EDGE_VERSION}`;
const FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DELIM = "\r\n\r\n";
/** El servicio corta los textos largos: se mandan por trozos. */
const MAX_CHARS = 3500;

/** Desfase del reloj local respecto al servidor, para el token. */
let clockOffsetMs = 0;

function headers(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      `Chrome/${EDGE_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${EDGE_VERSION.split(".")[0]}.0.0.0`,
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    // Sin esta cookie el servicio contesta 200 y no abre el WebSocket.
    Cookie: `MUID=${randomUUID().replace(/-/g, "").toUpperCase()}`,
  };
}

/**
 * Sec-MS-GEC: SHA-256 de (ticks de Windows cada 5 min + token), en hexadecimal.
 * Si el reloj local va desfasado el servicio responde 403 y hay que corregirlo.
 */
function secMsGec(): string {
  const ticks = Math.floor((Date.now() + clockOffsetMs) / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  return createHash("sha256")
    .update(`${rounded * 10_000_000}${TRUSTED_CLIENT_TOKEN}`, "ascii")
    .digest("hex")
    .toUpperCase();
}

function synthUrl(): string {
  return (
    `${WSS_URL}?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${randomUUID()}`
  );
}

export interface EdgeVoice {
  id: string;
  name: string;
  locale: string;
  gender: "male" | "female" | "neutral";
}

/** Voces disponibles. */
export async function listEdgeVoices(): Promise<EdgeVoice[]> {
  const res = await fetch(`${VOICES_URL}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Edge no devolvió las voces (HTTP ${res.status})`);
  const raw = (await res.json()) as Array<{
    ShortName: string;
    FriendlyName: string;
    Locale: string;
    Gender: string;
  }>;
  return raw.map((v) => ({
    id: v.ShortName,
    name: v.FriendlyName,
    locale: v.Locale,
    gender: v.Gender === "Male" ? "male" : v.Gender === "Female" ? "female" : "neutral",
  }));
}

export interface EdgeSpeakOptions {
  rate?: number;
  pitch?: number;
  volume?: number;
}

/** Sintetiza y devuelve el MP3 completo. */
export async function speakEdge(
  text: string,
  voice: string,
  options: EdgeSpeakOptions = {},
): Promise<Buffer> {
  const chunks = splitText(text);
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    parts.push(await speakChunk(chunk, voice, options));
  }
  return Buffer.concat(parts);
}

/** Un trozo: una conexión, una locución. */
async function speakChunk(text: string, voice: string, options: EdgeSpeakOptions): Promise<Buffer> {
  const audio = await new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(synthUrl(), { headers: headers(), handshakeTimeout: 15_000 });
    const parts: Buffer[] = [];
    let settled = false;

    const done = (err?: Error, data?: Buffer) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ya cerrado */
      }
      if (err) reject(err);
      else resolve(data ?? Buffer.alloc(0));
    };

    ws.on("unexpected-response", (_req, res) => {
      // 403 por reloj desfasado: se corrige con la hora del servidor.
      const serverDate = Date.parse(String(res.headers.date ?? ""));
      if (res.statusCode === 403 && Number.isFinite(serverDate)) {
        clockOffsetMs = serverDate - Date.now();
        done(new Error("Edge TTS: reloj desfasado, reintentando."));
      } else {
        done(
          new Error(
            res.statusCode === 429
              ? "Edge TTS: demasiadas peticiones (HTTP 429)."
              : `Edge TTS no abrió la conexión (HTTP ${res.statusCode}).`,
          ),
        );
      }
      res.destroy();
    });

    ws.on("error", (err) => done(err instanceof Error ? err : new Error(String(err))));

    ws.on("open", () => {
      ws.send(
        `X-Timestamp:${httpDate()}\r\n` +
          "Content-Type:application/json; charset=utf-8\r\n" +
          `Path:speech.config${DELIM}` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                  outputFormat: FORMAT,
                },
              },
            },
          }),
      );

      ws.send(
        `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
          "Content-Type:application/ssml+xml\r\n" +
          `X-Timestamp:${httpDate()}Z\r\n` +
          `Path:ssml${DELIM}` +
          ssml(text, voice, options),
      );
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const textFrame = data.toString("utf8");
        if (textFrame.includes("Path:turn.end")) done(undefined, Buffer.concat(parts));
        return;
      }
      // Trama binaria: 2 bytes con la longitud de cabeceras (big endian).
      if (data.length < 2) return;
      const headerLength = data.readUInt16BE(0);
      const from = 2 + headerLength;
      if (from < data.length) parts.push(data.subarray(from));
    });

    ws.on("close", () => {
      if (!settled) done(new Error("Edge TTS cerró la conexión sin audio."));
    });
  });

  if (audio.length === 0) throw new Error("Edge TTS no devolvió audio.");
  return audio;
}

/** SSML con velocidad, tono y volumen en el formato que espera Edge. */
function ssml(text: string, voice: string, options: EdgeSpeakOptions): string {
  const rate = `${sign(options.rate ?? 0)}%`;
  const pitch = `${sign(options.pitch ?? 0)}Hz`;
  // Volumen a 0 sí está permitido en Edge ("-100%" sería silencio total).
  const volume = `${sign((options.volume ?? 100) - 100)}%`;
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='es-ES'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    escapeXml(text) +
    "</prosody></voice></speak>"
  );
}

function sign(value: number): string {
  const v = Math.round(value);
  return `${v >= 0 ? "+" : ""}${v}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Tope de caracteres por mensaje, cortando por frases o palabras. */
function splitText(text: string): string[] {
  const clean = text.trim();
  if (clean.length <= MAX_CHARS) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(". ", MAX_CHARS);
    if (cut < MAX_CHARS * 0.5) cut = rest.lastIndexOf(" ", MAX_CHARS);
    if (cut <= 0) cut = MAX_CHARS;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Fecha en el formato que usa Edge (sin zona; el servicio la ignora). */
function httpDate(): string {
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}
