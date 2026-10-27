/**
 * Motor SAPI de Windows: voces del sistema, offline y sin configuración.
 *
 * System.Speech expone las voces "Desktop" (Microsoft Helena, Laura, Pablo...).
 * Se invoca vía Windows PowerShell 5.1, que es el único que carga System.Speech.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MotorId, SynthOptions, SynthResult, TtsMotor, VoiceInfo } from "../types.js";

/** PowerShell 5.1 (Windows PowerShell) — pwsh 7 no carga System.Speech. */
const POWERSHELL = "powershell.exe";

interface SapiVoice {
  Name: string;
  Culture: string;
  Gender: string;
}

/**
 * Script PowerShell: lista las voces instaladas.
 * Imprime JSON por stdout para no depender del idioma del sistema.
 */
const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$out = @()
foreach ($v in $s.GetInstalledVoices()) {
  $i = $v.VoiceInfo
  $out += [pscustomobject]@{
    Name   = $i.Name
    Culture = $i.Culture.Name
    Gender = $i.Gender.ToString()
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

/**
 * Script PowerShell: sintetiza texto a WAV.
 * Variables: $Text, $OutFile, $Voice, $Rate, $Volume
 */
const SYNTH_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { $s.SelectVoice($Voice) }
$s.Rate = $Rate
$s.Volume = $Volume
$s.SetOutputToWaveFile($OutFile)
$s.Speak($Text)
$s.SetOutputToNull()
$s.Dispose()
Write-Output 'OK'
`;

/** Rango de Rate de SAPI: -10..+10. */
function sapiRate(percent: number): number {
  return Math.max(-10, Math.min(10, Math.round(percent / 10)));
}

export class SapiMotor implements TtsMotor {
  readonly id: MotorId = "sapi";
  readonly label = "Windows (SAPI)";
  readonly free = true;
  readonly needsNetwork = false;

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      await this.listVoices();
      return true;
    } catch {
      return false;
    }
  }

  async listVoices(): Promise<VoiceInfo[]> {
    if (process.platform !== "win32") return [];
    const { stdout } = await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT]);
    const raw = stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SapiVoice[] | SapiVoice;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((v) => ({
      id: v.Name,
      name: v.Name.replace(/\s*Desktop$/, ""),
      locale: v.Culture,
      gender: v.Gender === "Male" ? "male" : v.Gender === "Female" ? "female" : "neutral",
      engine: "sapi",
    }));
  }

  async synthesize(text: string, voice: string, options: SynthOptions = {}): Promise<SynthResult> {
    const outFile = join(tmpdir(), `voz-${randomUUID()}.wav`);
    const rate = sapiRate(options.rate ?? 0);
    const volume = Math.max(0, Math.min(100, options.volume ?? 100));

    const script = [
      `$Text = ${psQuote(text)}`,
      `$OutFile = ${psQuote(outFile)}`,
      `$Voice = ${psQuote(voice)}`,
      `$Rate = ${rate}`,
      `$Volume = ${volume}`,
      SYNTH_SCRIPT,
    ].join("\n");

    await run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script]);

    const data = await readFileOrThrow(outFile);
    return {
      data,
      format: "wav",
      durationMs: wavDurationMs(data),
      text,
      engine: this.id,
      voice,
    };
  }
}

/** Escapa una cadena para un literal de PowerShell (comilla simple, duplicando comillas). */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file}: ${stderr.trim() || err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function readFileOrThrow(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path);
  } catch (err) {
    throw new Error(`No se pudo leer el audio generado: ${(err as Error).message}`);
  } finally {
    await import("node:fs/promises").then((fs) => fs.unlink(path).catch(() => {}));
  }
}

/** Lee la duración de un WAV PCM (sin decodificar). */
export function wavDurationMs(buf: Buffer): number | undefined {
  if (buf.length < 44) return undefined;
  // Busca el chunk 'data'
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const byteRate = buf.readUInt32LE(28);
      if (byteRate > 0) return Math.round((size / byteRate) * 1000);
      return undefined;
    }
    off += 8 + size + (size % 2);
  }
  return undefined;
}
