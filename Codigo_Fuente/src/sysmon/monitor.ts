import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** Edad máxima de una muestra para darla por buena (ms). */
const FRESH_MS = 15_000;
/** Espera mínima entre intentos de arranque del proceso (ms). */
const RETRY_MS = 60_000;
/** Margen para que se acepte el UAC y escriba la primera muestra (Open() ~2,6 s). */
const ELEVATED_MS = 20_000;
/** Vueltas seguidas con JSON de error antes de reintentar el arranque sin esperar. */
const BAD_SAMPLES = 3;
/** Pausa tras matar el helper plano: el mutex `Local\AlfredSysMon` tarda en soltarse. */
const PLAIN_STOP_MS = 500;
/** Vida mínima del helper para relanzarlo al siguiente sondeo si muere (ms). */
const MIN_ALIVE_MS = 3_000;

/**
 * Helper sin elevar vivo. Vive en el módulo y no en `SysMonitor` porque
 * `resolveWebviewView` crea otro `VozPanel` con otro `SysMonitor` y la
 * referencia se perdería: `elevate()` tiene que poder matarlo igual.
 */
let helperChild: ChildProcess | null = null;
/** El helper elevado ya dio una muestra buena en esta sesión de VS Code. */
let elevatedServed = false;

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
 *
 * Nunca pide elevación: el UAC solo sale con `elevate()`, que es el clic en la
 * temperatura de la CPU del panel. Sin él se leen cargas, memoria y GPU; la
 * temperatura de la CPU queda en `null`.
 */
export class SysMonitor {
  private readonly intervalMs: number;
  /** Arranque en curso: no se lanza otro hasta saber cómo acaba. */
  private starting = false;
  /** Muestras frescas seguidas que no eran muestra (JSON de error del script). */
  private badSamples = 0;
  /** Epoch ms del último intento; `0` = ninguno. */
  private lastStart = 0;
  /** Epoch ms del lanzamiento elevado: solo vale una muestra posterior. */
  private elevatedFrom = 0;
  /** Resuelve la promesa de `elevate()` al terminar el arranque elevado. */
  private elevatedDone?: (ok: boolean) => void;
  private elevatedTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly opts: { script: string; outFile: string; intervalMs?: number }) {
    this.intervalMs = opts.intervalMs ?? 2000;
  }

  /** Ya hay un helper elevado bueno: un clic no pediría nada. */
  get elevated(): boolean {
    return elevatedServed;
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
      // Con un UAC en vuelo, la muestra que llega puede ser la que dejó el helper
      // plano antes de morir (sigue fresca 15 s): solo vale la escrita después
      // del lanzamiento, que es la suya.
      if (fresh && this.starting && fresh.at >= this.elevatedFrom) this.settleElevated();
      return fresh;
    }
    // `startIfDue` no lanza nada mientras hay un arranque en vuelo, así que el
    // helper plano no planta cara al mutex del elevado.
    this.startIfDue();
    return null;
  }

  /**
   * Pide el UAC a mano, desde el clic en la temperatura de la CPU del panel.
   * Hasta aquí el proceso iba sin elevar, así que se mata y se relanza elevado:
   * sin la pausa, el mutex `Local\AlfredSysMon` del plano rechaza al nuevo. Si
   * el UAC se cancela o no escribe, se vuelve al plano: el monitor no se queda
   * sin datos.
   */
  async elevate(): Promise<"pedido" | "ya" | "fallo"> {
    if (elevatedServed) return "ya";
    // Dos clics seguidos no pueden abrir dos UAC.
    if (this.starting) return "pedido";
    if (this.disposed) return "fallo";
    // Bloquea el sondeo mientras se mata el plano y se espera al UAC.
    this.starting = true;
    this.badSamples = 0;
    // Sella el clic: la muestra que dejó el plano (fresca 15 s) es anterior.
    this.elevatedFrom = Date.now();
    // El helper plano es nuestro y no está elevado: `kill()` basta.
    const plain = helperChild;
    helperChild = null;
    if (plain) {
      try {
        plain.kill();
      } catch {
        // Ya estaba muerto: el mutex se libera igual.
      }
    }
    await delay(PLAIN_STOP_MS);
    if (this.disposed) {
      this.finishElevated(false);
      return "fallo";
    }
    // Y otra vez al lanzar: a partir de aquí solo vale lo escrito por el elevado.
    this.elevatedFrom = Date.now();
    const ok = await this.startElevated();
    return ok ? "pedido" : "fallo";
  }

  /**
   * No se mata el proceso: si va elevado, el host no puede y además se va solo
   * en cuanto muere el VS Code que lo lanzó (`-ParentPid`).
   */
  dispose(): void {
    this.disposed = true;
    // Un UAC en vuelo deja la promesa resuelta como fallo y no relanza el plano.
    this.finishElevated(false);
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

  /**
   * Arranca el helper sin elevar: es el camino de `poll()`, así que abrir VS Code
   * no abre ninguna ventana de permisos.
   */
  private startIfDue(force = false) {
    if (this.starting) return;
    const now = Date.now();
    // `force` lo usa `poll()` cuando el fichero fresco trae errores seguidos: ahí
    // esperar los 60 s deja el panel en guiones sin motivo.
    if (!force && this.lastStart !== 0 && now - this.lastStart < RETRY_MS) return;
    this.lastStart = now;
    this.startPlain();
  }

  /**
   * Arranque elevado (`elevate()`): el lanzador se cierra en cuanto el proceso
   * arranca. Una salida distinta de 0 es un UAC cancelado; con 0 se espera la
   * muestra. Resuelve `true` cuando llega una muestra posterior al lanzamiento.
   */
  private startElevated(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.elevatedDone = resolve;
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
    });
  }

  /** Sin muestra posterior al lanzamiento al vencer el margen: arranque fallido. */
  private checkElevated() {
    this.elevatedTimer = undefined;
    if (!this.starting) return;
    // Un JSON de error también es fresco, así que solo una muestra vale.
    const fresh = this.readFresh();
    if (fresh && fresh.at >= this.elevatedFrom) this.settleElevated();
    else this.failElevated();
  }

  /** Arranque elevado bueno: hay un proceso escribiendo, se deja de vigilar. */
  private settleElevated() {
    this.finishElevated(true);
  }

  /** Arranque elevado fallido (UAC cancelado o nada escrito en 20 s): vuelve el plano. */
  private failElevated() {
    this.finishElevated(false);
    if (!this.disposed) this.startPlain();
  }

  private finishElevated(ok: boolean) {
    if (!this.starting) return;
    this.starting = false;
    this.clearElevatedTimer();
    if (ok) elevatedServed = true;
    const done = this.elevatedDone;
    this.elevatedDone = undefined;
    done?.(ok);
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
      // La referencia sobrevive al panel: `elevate()` mata este proceso aunque
      // venga de un `SysMonitor` anterior.
      helperChild = child;
      const startedAt = Date.now();
      child.on("exit", () => {
        // `elevate()` lo suelta antes de matarlo: ahí manda su propia secuencia.
        if (helperChild !== child) return;
        helperChild = null;
        // Muerto por su cuenta: el siguiente sondeo lo relanza ya, salvo que
        // apenas haya vivido (otra ventana tiene el mutex y lo rechaza al nacer).
        if (Date.now() - startedAt >= MIN_ALIVE_MS) this.lastStart = 0;
      });
      child.on("error", () => {
        if (helperChild === child) helperChild = null;
      });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
