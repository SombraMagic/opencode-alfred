/**
 * Detector de pausa y habla adaptativo para modo manos libres (sin dependencias de VS Code).
 *
 * Utiliza RMS por ventanas (~100 ms) sin ganancia, estimador de ruido de fondo
 * adaptativo (mínimo móvil con subida lenta), histéresis entre entrada a voz
 * y mantenimiento, confirmación de voz sostenida (evita que un clic aislado marque 'heard')
 * y detección de silencio con umbral relativo al fondo.
 */

export interface PauseDetectorOptions {
  /** Milisegundos de silencio continuo para cerrar fragmento tras voz sostenida. Defecto: 1200. */
  pauseMs?: number;
  /** Tope máximo en ms de un fragmento antes de forzar corte. Defecto: 12000. */
  maxChunkMs?: number;
  /** Mínimo absoluto de RMS para considerar que puede haber voz. Defecto: 0.005 (−46 dBFS). */
  minVoiceRms?: number;
  /** Multiplicador sobre el suelo para activar voz (histéresis alta). Defecto: 3.2. */
  voiceFactor?: number;
  /** Multiplicador sobre el suelo para mantener voz (histéresis baja). Defecto: 2.0. */
  holdFactor?: number;
  /** Ventanas consecutivas de voz requeridas para confirmar habla sostenida. Defecto: 2 (~200 ms). */
  consecutiveVoiceFrames?: number;
  /** Ventana de tiempo (ms) para el mínimo móvil del suelo. Defecto: 3000 ms. */
  floorWindowMs?: number;
}

export interface PauseTickResult {
  /** Nivel RMS medido en esta ventana (0..1). */
  rms: number;
  /** Suelo de ruido adaptativo estimado (0..1). */
  floor: number;
  /** Si esta ventana califica como voz activa. */
  isVoice: boolean;
  /** Si ya se ha confirmado voz sostenida en el fragmento actual. */
  heard: boolean;
  /**
   * Acción recomendada:
   * - "none": continuar grabando.
   * - "cut_pause": cortar por pausa tras hablar.
   * - "cut_max": cortar por haber alcanzado el tope máximo de duración.
   */
  action: "none" | "cut_pause" | "cut_max";
}

export class PauseDetector {
  private readonly pauseMs: number;
  private readonly maxChunkMs: number;
  private readonly minVoiceRms: number;
  private readonly voiceFactor: number;
  private readonly holdFactor: number;
  private readonly consecutiveFramesNeeded: number;
  private readonly floorWindowMs: number;

  private floor = 0.003;
  private floorHistory: Array<{ time: number; rms: number }> = [];
  private consecutiveVoice = 0;
  private heard = false;
  private chunkStart = 0;
  private lastVoiceTime = 0;
  private inVoiceState = false;

  constructor(options: PauseDetectorOptions = {}) {
    this.pauseMs = options.pauseMs ?? 1200;
    this.maxChunkMs = options.maxChunkMs ?? 12000;
    this.minVoiceRms = options.minVoiceRms ?? 0.005;
    this.voiceFactor = options.voiceFactor ?? 3.2;
    this.holdFactor = options.holdFactor ?? 2.0;
    this.consecutiveFramesNeeded = options.consecutiveVoiceFrames ?? 2;
    this.floorWindowMs = options.floorWindowMs ?? 3000;
    this.reset(Date.now());
  }

  /** Reinicia el estado para un nuevo fragmento. */
  reset(now = Date.now()): void {
    this.heard = false;
    this.consecutiveVoice = 0;
    this.inVoiceState = false;
    this.chunkStart = now;
    this.lastVoiceTime = now;
  }

  /** Procesa una muestra de nivel RMS (0..1) medida en una ventana (típicamente 100 ms). */
  tick(rms: number, now = Date.now()): PauseTickResult {
    if (this.chunkStart === 0) this.chunkStart = now;

    // 1. Actualizar historial de suelo con ventana móvil de ~3 s
    this.floorHistory.push({ time: now, rms });
    const cutoff = now - this.floorWindowMs;
    while (this.floorHistory.length > 0 && this.floorHistory[0].time < cutoff) {
      this.floorHistory.shift();
    }

    // El suelo es el mínimo en la ventana reciente, pero con subida gradual
    let minRecent = rms;
    for (const item of this.floorHistory) {
      if (item.rms < minRecent) minRecent = item.rms;
    }
    // Subida suave del suelo para no atascarse si el ambiente cambia
    if (minRecent > this.floor) {
      this.floor += (minRecent - this.floor) * 0.05;
    } else {
      this.floor = minRecent;
    }
    if (this.floor < 0.001) this.floor = 0.001;

    // 2. Umbrales de histéresis
    const enterThreshold = Math.max(this.minVoiceRms, this.floor * this.voiceFactor);
    const holdThreshold = Math.max(this.minVoiceRms * 0.8, this.floor * this.holdFactor);

    if (this.inVoiceState) {
      this.inVoiceState = rms >= holdThreshold;
    } else {
      this.inVoiceState = rms >= enterThreshold;
    }

    // 3. Confirmación de voz sostenida (evita clics sueltos)
    if (this.inVoiceState) {
      this.consecutiveVoice++;
      if (this.consecutiveVoice >= this.consecutiveFramesNeeded) {
        this.heard = true;
        this.lastVoiceTime = now;
      }
    } else {
      this.consecutiveVoice = 0;
    }

  // 4. Decisiones de corte
  let action: PauseTickResult["action"] = "none";
  if (now - this.chunkStart >= this.maxChunkMs) {
    action = "cut_max";
  } else if (this.heard && now - this.lastVoiceTime >= this.pauseMs) {
    action = "cut_pause";
  }

    return {
      rms,
      floor: this.floor,
      isVoice: this.inVoiceState,
      heard: this.heard,
      action,
    };
  }

  get isHeard(): boolean {
    return this.heard;
  }

  get currentFloor(): number {
    return this.floor;
  }
}
