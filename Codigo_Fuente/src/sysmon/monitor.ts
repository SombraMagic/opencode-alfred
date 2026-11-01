import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** Edad máxima de una muestra para darla por buena (ms). */
const FRESH_MS = 15_000;
/** Espera mínima entre intentos de arranque del proceso (ms). */
const RETRY_MS = 60_000;
/** Margen para que se acepte el UAC y escriba la primera muestra (Open() ~2,6 s). */
const ELEVATED_MS = 20_000;
/** Vueltas seguidas con JSON de error antes de reintentar el arranque sin esperar. */
const BAD_SAMPLES = 3;

/** Una muestra del equipo, tal como la lee el panel. */
export interface SysSample {
  /** Epoch ms de la muestra. */
  at: number;
  cpu: { temp: number | null; load: number | null };
  ram: { total: number | null; used: number | null };
  gpu: {
    name: string | null;
    temp: number | null;
    load: number | null;
    vramTotal: number | null;
    vramUsed: number | null;
  };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function objOf(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Valida y normaliza el JSON del proceso: sin `at` o sin bloques, no es muestra. */
function normalize(raw: unknown): SysSample | null {
  const src = objOf(raw);
  if (!src) return null;
  const cpu = objOf(src.cpu);
  const ram = objOf(src.ram);
  const gpu = objOf(src.gpu);
  if (!cpu || !ram || !gpu) return null;
  const at = num(src.at);
  if (at === null) return null;
  return {
    at,
    cpu: { temp: num(cpu.temp), load: num(cpu.load) },
    ram: { total: num(ram.total), used: num(ram.used) },
    gpu: {
      name: typeof gpu.name === "string" ? gpu.name : null,
      temp: num(gpu.temp),
      load: num(gpu.load),
      vramTotal: num(gpu.vramTotal),
      vramUsed: num(gpu.vramUsed),
    },
  };
}

/** Literal de PowerShell para un argumento de `-ArgumentList`: la ruta entre comillas dobles. */
function pathArg(p: string): string {
  // Start-Process -ArgumentList no entrecomilla nada por su cuenta, así que las
  // rutas con espacios tienen que llegar ya con sus comillas (las de dentro).
  // El elemento es un literal de PowerShell con comillas simples: la única
  // comilla que se escapa ahí es la simple, duplicándola.
  const quoted = `"${p}"`;
  return `'${quoted.replace(/'/g, "''")}'`;
}

/**
 * Lee las muestras que deja `resources/sysmon-lhm.ps1` y arranca ese proceso
 * cuando no hay ninguna fresca. El proceso es persistente porque Open() de la
 * librería tarda segundos; aquí solo se mira el fichero.
 */
export class SysMonitor {
  private readonly intervalMs: number;
  /** Arranque en curso: no se lanza otro hasta saber cómo acaba. */
  private starting = false;
  /** Muestras frescas seguidas que no eran muestra (JSON de error del script). */
  private badSamples = 0;
  /** Epoch ms del último intento; `0` = ninguno. */
  private lastStart = 0;
  /** Falso cuando el arranque elevado ha fallado de verdad: no se pide otro UAC. */
  private elevatedAllowed = true;
  /** El UAC ya dio un proceso bueno en esta sesión: si muere luego, no se repite. */
  private elevatedServed = false;
  private elevatedTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly opts: { script: string; outFile: string; intervalMs?: number }) {
    this.intervalMs = opts.intervalMs ?? 2000;
  }

  /** Muestra fresca, o null si aún no hay (y arranca el proceso si toca). */
  poll(): SysSample | null {
    if (this.disposed) return null;
    const fresh = this.readFresh();
    if (fresh === null) {
      // Fichero fresco con el JSON de error de una vuelta del script: no es una
      // muestra ni un arranque bueno, solo guiones. A las tres seguidas se
      // reintenta el arranque sin esperar los 60 s; el mutex del script deja
      // inofensivo el proceso sobrante.
      this.badSamples += 1;
      if (this.badSamples >= BAD_SAMPLES) {
        this.badSamples = 0;
        this.startIfDue(true);
      }
      return null;
    }
    this.badSamples = 0;
    if (fresh !== undefined) {
      // Con un arranque elevado en vuelo, la muestra que llega es la suya: no hay
      // que caer a no elevado.
      if (this.starting) this.settleElevated();
      return fresh;
    }
    // `startIfDue` no lanza nada mientras hay un arranque en vuelo, así que un
    // UAC pendiente no se duplica con un proceso no elevado.
    this.startIfDue();
    return null;
  }

  /**
   * No se mata el proceso: si va elevado, el host no puede y además se va solo
   * en cuanto muere el VS Code que lo lanzó (`-ParentPid`).
   */
  dispose(): void {
    this.disposed = true;
    this.clearElevatedTimer();
    this.starting = false;
  }

  /** `undefined` = sin fichero o viejo; `null` = fresco pero ilegible. */
  private readFresh(): SysSample | null | undefined {
    let mtime: number;
    try {
      mtime = statSync(this.opts.outFile).mtimeMs;
    } catch {
      return undefined;
    }
    if (Date.now() - mtime > FRESH_MS) return undefined;
    try {
      return normalize(JSON.parse(readFileSync(this.opts.outFile, "utf8")));
    } catch {
      return null;
    }
  }

  private startIfDue(force = false) {
    if (this.starting) return;
    const now = Date.now();
    // `force` lo usa `poll()` cuando el fichero fresco trae errores seguidos: ahí
    // esperar los 60 s deja el panel en guiones sin motivo.
    if (!force && this.lastStart !== 0 && now - this.lastStart < RETRY_MS) return;
    this.lastStart = now;
    if (this.elevatedAllowed && !this.elevatedServed) this.startElevated();
    else this.startPlain();
  }

  /**
   * Primero con UAC, que es la única forma de ver la temperatura de la CPU.
   * El lanzador se cierra en cuanto el proceso arranca: una salida distinta de
   * 0 es un UAC cancelado y se cae a no elevado; con 0 se espera la muestra.
   */
  private startElevated() {
    this.starting = true;
    const list = [
      "'-NoProfile'",
      "'-ExecutionPolicy'",
      "'Bypass'",
      "'-File'",
      pathArg(this.opts.script),
      "'-OutFile'",
      pathArg(this.opts.outFile),
      "'-IntervalMs'",
      String(this.intervalMs),
      "'-ParentPid'",
      String(process.pid),
    ].join(",");
    const wrapper =
      `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden ` +
      `-ArgumentList @(${list})`;
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-Command", wrapper], {
        windowsHide: true,
        stdio: "ignore",
      });
      child.on("error", () => this.failElevated());
      child.on("exit", (code) => {
        // 0 con UAC aceptado: el proceso ya corre, solo falta que escriba. Quien
        // decide entonces es el margen de 20 s (o la muestra que llegue antes).
        if (code !== 0) this.failElevated();
      });
    } catch {
      this.failElevated();
      return;
    }
    this.elevatedTimer = setTimeout(() => this.checkElevated(), ELEVATED_MS);
  }

  /** Sin muestra al vencer el margen: el arranque elevado se da por fallido. */
  private checkElevated() {
    this.elevatedTimer = undefined;
    if (!this.starting) return;
    // Un JSON de error también es fresco, así que solo una muestra lo da por bueno.
    if (this.readFresh()) this.settleElevated();
    else this.failElevated();
  }

  /** Arranque elevado bueno: hay un proceso escribiendo, se deja de vigilar. */
  private settleElevated() {
    this.starting = false;
    // Un solo UAC por sesión: si este proceso muere, se sigue sin elevar.
    this.elevatedServed = true;
    this.elevatedAllowed = false;
    this.clearElevatedTimer();
  }

  /**
   * Arranque elevado fallido (UAC cancelado o nada escrito en 20 s): se apaga el
   * UAC para el resto de la sesión y entra el proceso sin elevar, que es el
   * único que puede haber aquí: `poll()` no arranca nada mientras `starting`.
   */
  private failElevated() {
    if (!this.starting) return;
    this.starting = false;
    this.elevatedAllowed = false;
    this.clearElevatedTimer();
    this.startPlain();
  }

  private startPlain() {
    try {
      // Sin `detached`: powershell.exe con DETACHED_PROCESS no llega a ejecutar
      // nada (sale 0 al instante, comprobado también con pwsh y cmd sí funciona).
      // No hace falta: el proceso se va solo cuando muere el host por -ParentPid.
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.opts.script,
          "-OutFile",
          this.opts.outFile,
          "-IntervalMs",
          String(this.intervalMs),
          "-ParentPid",
          String(process.pid),
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      child.unref();
    } catch {
      // Sin proceso: el siguiente sondeo lo reintenta.
    }
  }

  private clearElevatedTimer() {
    if (this.elevatedTimer) clearTimeout(this.elevatedTimer);
    this.elevatedTimer = undefined;
  }
}
