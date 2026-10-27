import * as fs from "fs";
import { parseJsoncSafe } from "../agents/config";
import type { Registry } from "../agents/config";
import { configFileCandidates, isSamePath, opencodeDataDir, opencodeModelsCachePath } from "../agents/paths";
import { writeAtomic } from "../agents/store";
import {
  scanOpencodePrompts,
  type PromptLane,
  type PromptRates,
  type PromptRecord,
  type PromptScanResult,
  type PromptSegment,
  type PromptStatsSnapshot,
} from "./promptFlow";

/** Máximo de registros guardados en disco (de todos los proyectos). */
const MAX_SAVED = 500;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Importe no negativo: con un valor ausente o loco se usa el respaldo. */
function price(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Bloque `cost` de opencode/models.dev, en USD por millón.
 * shortcut: se ignoran los tramos por contexto (`tier`); vale el precio de la franja base.
 */
function ratesFromCost(raw: unknown): PromptRates | undefined {
  const cost = asObj(raw);
  if (!cost) {
    return undefined;
  }
  const hasInput = typeof cost.input === "number" && Number.isFinite(cost.input);
  const hasOutput = typeof cost.output === "number" && Number.isFinite(cost.output);
  if (!hasInput && !hasOutput) {
    // Un bloque de coste sin input ni output no es una tarifa: sigue habiendo incógnita.
    return undefined;
  }
  const input = price(cost.input, 0);
  const output = price(cost.output, 0);
  return {
    input,
    output,
    reasoning: price(cost.reasoning, output),
    cacheRead: price(cost.cache_read, input),
    cacheWrite: price(cost.cache_write, input),
  };
}

let configCache: { sig: string; values: Array<Record<string, unknown> | undefined> } | undefined;

/** opencode.json(c) en orden de `configFileCandidates()`: el proyecto va antes que el global. */
function configValues(): Array<Record<string, unknown> | undefined> {
  const files = configFileCandidates();
  const sig = files
    .map((file) => {
      try {
        const st = fs.statSync(file);
        return `${file}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${file}:-`;
      }
    })
    .join("|");
  if (configCache && configCache.sig === sig) {
    return configCache.values;
  }
  const values = files.map((file) => {
    try {
      return parseJsoncSafe(fs.readFileSync(file, "utf8")).value;
    } catch {
      // Fichero ausente o ilegible: se prueba con el siguiente.
      return undefined;
    }
  });
  configCache = { sig, values };
  return values;
}

let registryCache: { key: string; registry: Registry } | undefined;

/** models.dev que opencode deja en ~/.cache/opencode/models.json (pesa varios MB). */
function loadRegistry(): Registry | undefined {
  const file = opencodeModelsCachePath();
  try {
    const st = fs.statSync(file);
    const key = `${file}:${st.mtimeMs}:${st.size}`;
    if (registryCache && registryCache.key === key) {
      return registryCache.registry;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const registry = parsed && typeof parsed === "object" ? (parsed as Registry) : {};
    registryCache = { key, registry };
    return registry;
  } catch {
    return undefined;
  }
}

/**
 * Tarifa del modelo en USD por millón. Orden: lo declarado en opencode.json(c), el
 * models.json de la caché y, al final, el mismo catálogo buscando sólo el id del modelo
 * (los proveedores propios no están en models.dev y repiten id entre proveedores).
 * Sólo se leen precios: nunca claves ni credenciales.
 */
export function ratesFor(provider: string, model: string): PromptRates | undefined {
  if (!model) {
    return undefined;
  }
  for (const value of configValues()) {
    const entry = asObj(asObj(asObj(value?.provider)?.[provider])?.models)?.[model];
    const rates = ratesFromCost(asObj(entry)?.cost);
    if (rates) {
      return rates;
    }
  }
  const registry = loadRegistry();
  if (!registry) {
    return undefined;
  }
  const exact = ratesFromCost(registry[provider]?.models?.[model]?.cost);
  if (exact) {
    return exact;
  }
  for (const providerEntry of Object.values(registry)) {
    const rates = ratesFromCost(providerEntry.models?.[model]?.cost);
    if (rates) {
      return rates;
    }
  }
  return undefined;
}

function readSegment(raw: unknown): PromptSegment | undefined {
  const obj = asObj(raw);
  const start = num(obj?.start);
  const end = num(obj?.end);
  return start > 0 && end >= start ? { start, end } : undefined;
}

function readLane(raw: unknown): PromptLane | undefined {
  const obj = asObj(raw);
  const agent = typeof obj?.agent === "string" ? obj.agent : "";
  if (!obj || !agent) {
    return undefined;
  }
  const segments = (Array.isArray(obj.segments) ? obj.segments : [])
    .map(readSegment)
    .filter((s): s is PromptSegment => s !== undefined);
  const lane: PromptLane = {
    agent,
    color: typeof obj?.color === "string" ? obj.color : undefined,
    root: obj?.root === true,
    segments,
    input: Math.max(0, num(obj?.input)),
    output: Math.max(0, num(obj?.output)),
    reasoning: Math.max(0, num(obj?.reasoning)),
    cacheRead: Math.max(0, num(obj?.cacheRead)),
    cacheWrite: Math.max(0, num(obj?.cacheWrite)),
    total: Math.max(0, num(obj?.total)),
    workMs: segments.reduce((ms, s) => ms + Math.max(0, s.end - s.start), 0),
    cost: Math.max(0, num(obj?.cost)),
    costEstimated: obj?.costEstimated === true,
    priced: obj?.priced === true,
  };
  return lane;
}

/** Lectura tolerante: un registro malformado se descarta, no se tira el historial. */
function readRecord(raw: unknown): PromptRecord | undefined {
  const obj = asObj(raw);
  const id = typeof obj?.id === "string" ? obj.id : "";
  const project = typeof obj?.project === "string" ? obj.project : "";
  const startedAt = num(obj?.startedAt);
  const endedAt = num(obj?.endedAt);
  if (!obj || !id || !project || startedAt <= 0 || endedAt < startedAt) {
    return undefined;
  }
  // Un registro guardado ya no está vivo, por mucho que diga el JSON.
  const lanes = (Array.isArray(obj.lanes) ? obj.lanes : [])
    .map(readLane)
    .filter((l): l is PromptLane => l !== undefined);
  const record: PromptRecord = {
    id,
    project,
    prompt: typeof obj.prompt === "string" && obj.prompt ? obj.prompt : "(prompt sin texto)",
    startedAt,
    endedAt,
    live: false,
    lanes,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    workMs: 0,
    cost: 0,
    costEstimated: false,
    priced: false,
  };
  for (const lane of lanes) {
    record.input += lane.input;
    record.output += lane.output;
    record.reasoning += lane.reasoning;
    record.cacheRead += lane.cacheRead;
    record.cacheWrite += lane.cacheWrite;
    record.total += lane.total;
    record.workMs += lane.workMs;
    record.cost += lane.cost;
    record.costEstimated = record.costEstimated || lane.costEstimated;
    record.priced = record.priced || lane.priced;
  }
  return record;
}

/** Se recolorean las filas al devolver: los colores cambian sin reescribir el JSON. */
function recolor(record: PromptRecord, colorOf: (agent: string) => string | undefined): PromptRecord {
  return { ...record, lanes: record.lanes.map((lane) => ({ ...lane, color: colorOf(lane.agent) })) };
}

export class PromptStatsService {
  private loaded = false;
  private monitor = false;
  private since = 0;
  private saved: PromptRecord[] = [];
  /**
   * Momento del último `clear`: ningún cierre anterior a esta marca vuelve del escáner. No se
   * persiste: al recargar, `setMonitor(true)` fija un `since` posterior al borrado y promptFlow.ts
   * descarta de por sí lo que cerró antes (`end < since`), así que lo borrado no regresa.
   */
  private clearedAt = 0;
  /** Mensaje breve cuando el JSON está ilegible: no se sobrescribe hasta tener datos válidos. */
  private damage?: string;
  /** Cola interna: `setMonitor`, `collect` y `clear` nunca escriben el estado solapados. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  get monitoring(): boolean {
    return this.monitor;
  }

  get monitorSince(): number {
    return this.since;
  }

  /** Encadena la tarea tras la anterior, haya fallado o no: un `clear` jamás pisa a un `collect`. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  setMonitor(on: boolean, now?: number): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.monitor = on;
      if (on) {
        this.since = now ?? Date.now();
      }
    });
  }

  collect(options: {
    project: string | undefined;
    colorOf(agent: string): string | undefined;
    now?: number;
  }): Promise<PromptStatsSnapshot> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const scannedAt = options.now ?? Date.now();
      if (!options.project) {
        return this.snapshot([], [], scannedAt, options.project);
      }

      // Con la monitorización apagada no se consulta ninguna base de opencode.
      let scan: PromptScanResult | undefined;
      if (this.monitor) {
        scan = scanOpencodePrompts({
          dataDir: opencodeDataDir(),
          project: options.project,
          since: this.since,
          now: scannedAt,
          colorOf: options.colorOf,
          ratesFor,
        });
        if (scan.ok) {
          await this.merge(scan.completed);
        }
      }

      const saved: PromptRecord[] = [];
      const savedById = new Map<string, PromptRecord>();
      for (const record of this.saved) {
        if (isSamePath(record.project, options.project)) {
          const shown = recolor(record, options.colorOf);
          saved.push(shown);
          savedById.set(shown.id, shown);
        }
      }
      // Lo vivo sólo existe con la monitorización encendida, se pinta y nunca se persiste.
      // Si coincide con un guardado por `id` gana la ventana más larga; el id no se duplica.
      const live: PromptRecord[] = [];
      const shadowed = new Set<string>();
      if (scan) {
        for (const prompt of scan.prompts) {
          if (!prompt.live) {
            continue;
          }
          const known = savedById.get(prompt.id);
          if (known) {
            if (known.endedAt - known.startedAt >= prompt.endedAt - prompt.startedAt) {
              continue;
            }
            shadowed.add(prompt.id);
          }
          live.push(prompt);
        }
      }
      const shownSaved = shadowed.size ? saved.filter((p) => !shadowed.has(p.id)) : saved;
      return this.snapshot(live, shownSaved, scannedAt, options.project, scan?.error);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      this.saved = [];
      this.damage = undefined;
      this.clearedAt = Date.now();
      await this.persist();
    });
  }

  private snapshot(
    live: PromptRecord[],
    saved: PromptRecord[],
    scannedAt: number,
    project: string | undefined,
    scanError?: string
  ): PromptStatsSnapshot {
    return {
      ok: !this.damage && !scanError,
      error: this.damage ?? scanError,
      monitor: this.monitor,
      monitorSince: this.since,
      project,
      scannedAt,
      // Primero lo en curso, luego lo terminado por fecha de cierre.
      prompts: [...live, ...saved.sort((a, b) => b.endedAt - a.endedAt)],
      // La UI lo usa como «guardados del proyecto»: lo del resto de proyectos no cuenta.
      savedCount: project
        ? this.saved.reduce((n, p) => (isSamePath(p.project, project) ? n + 1 : n), 0)
        : 0,
    };
  }

  private async merge(completed: PromptRecord[]): Promise<void> {
    const index = new Map<string, number>();
    this.saved.forEach((p, i) => {
      if (!index.has(p.id)) {
        index.set(p.id, i);
      }
    });
    // Ningún registro nuevo se inserta por debajo de `dropBefore`: lo cerrado antes del último
    // `clear` y, con el tope lleno, lo más viejo de lo guardado. Sin esto, el recorte expulsaría ese
    // registro y el escáner lo devolvería en cada tick, reescribiendo el fichero una y otra vez.
    let dropBefore = this.clearedAt;
    if (this.saved.length >= MAX_SAVED) {
      const oldest = this.saved.reduce((min, p) => Math.min(min, p.endedAt), Number.POSITIVE_INFINITY);
      dropBefore = Math.max(dropBefore, oldest);
    }
    let changed = false;
    for (const record of completed) {
      const at = index.get(record.id);
      if (at === undefined) {
        if (record.endedAt <= dropBefore) {
          continue;
        }
        index.set(record.id, this.saved.length);
        this.saved.push(record);
        changed = true;
        continue;
      }
      // Un cierre posterior reemplaza al registro que quedó truncado por el silencio.
      if (record.endedAt > this.saved[at].endedAt) {
        this.saved[at] = record;
        changed = true;
      }
    }
    if (this.saved.length > MAX_SAVED) {
      // Se conservan los cierres más recientes, sean del proyecto que sean.
      this.saved.sort((a, b) => b.endedAt - a.endedAt);
      this.saved = this.saved.slice(0, MAX_SAVED);
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    if (this.damage && this.saved.length === 0) {
      return;
    }
    try {
      await writeAtomic(this.file, JSON.stringify({ version: 1, prompts: this.saved }, null, 2));
      this.damage = undefined;
    } catch (err) {
      this.damage = `No se pudo escribir el historial de prompts: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      // Sin fichero no hay historial: no es un error.
      return;
    }
    try {
      const root = asObj(JSON.parse(text) as unknown);
      if (!root || !Array.isArray(root.prompts)) {
        throw new Error("sin lista de prompts");
      }
      this.saved = root.prompts.map(readRecord).filter((p): p is PromptRecord => p !== undefined);
      this.damage = undefined;
    } catch {
      this.saved = [];
      this.damage = "El historial de prompts está dañado: se trabaja con la lista vacía sin sobrescribirlo.";
    }
  }
}
