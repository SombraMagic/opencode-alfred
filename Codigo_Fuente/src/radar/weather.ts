// Tiempo para el Radar: Open-Meteo (previsión, geocodificación, rejilla) y RainViewer (radar).
// Sin `vscode`. Nada lanza al llamador: los errores salen como `{ error }` en español.

export interface Lugar {
  nombre: string;
  pais?: string;
  lat: number;
  lon: number;
}
export interface LugarBusqueda extends Lugar {
  region?: string;
}
export interface Bounds {
  n: number;
  s: number;
  e: number;
  w: number;
}
export interface Actual {
  temp: number | null;
  sensacion: number | null;
  humedad: number | null;
  presion: number | null;
  viento: number | null;
  rachas: number | null;
  direccion: number | null;
  nubosidad: number | null;
  lluvia: number | null;
  uv: number | null;
  codigo: number | null;
  esDia: boolean;
}
export interface Hora {
  t: string;
  temp: number | null;
  lluvia: number | null;
  probLluvia: number | null;
  nubosidad: number | null;
  viento: number | null;
  direccion: number | null;
  codigo: number | null;
}
export interface Dia {
  fecha: string;
  max: number | null;
  min: number | null;
  lluviaTotal: number | null;
  probLluvia: number | null;
  vientoMax: number | null;
  uv: number | null;
  codigo: number | null;
  amanecer: string | null;
  atardecer: string | null;
}
export interface Prevision {
  actual: Actual;
  horas: Hora[];
  dias: Dia[];
}
export interface Rejilla {
  bounds: Bounds;
  nx: number;
  ny: number;
  tiempos: string[];
  temp: (number | null)[][];
  nubosidad: (number | null)[][];
  viento: (number | null)[][];
  direccion: (number | null)[][];
}
export interface Radar {
  host: string;
  frames: { time: number; path: string; nowcast: boolean }[];
  maxZoom: number;
}
export type Resultado<T> = { ok: T } | { error: string };

const TIMEOUT_MS = 15_000;
const MAX_PUNTOS = 100;
// RainViewer sirve tiles útiles hasta el zoom 7 (por encima devuelve el mismo mosaico ampliado).
const RADAR_MAX_ZOOM = 7;

export const DEFECTO: Lugar = { nombre: "Madrid", pais: "España", lat: 40.4168, lon: -3.7038 };

// ── Validación (también para lo que llega del webview) ───────────────────────

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

export function parseLugar(raw: unknown): Lugar | undefined {
  const o = obj(raw);
  const lat = num(o.lat);
  const lon = num(o.lon);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return undefined;
  }
  const nombre = typeof o.nombre === "string" ? o.nombre.trim().slice(0, 80) : "";
  if (!nombre) {
    return undefined;
  }
  const pais = typeof o.pais === "string" && o.pais.trim() ? o.pais.trim().slice(0, 80) : undefined;
  return { nombre, ...(pais ? { pais } : {}), lat, lon };
}

export function parseBusqueda(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const q = raw.trim();
  return q.length >= 2 && q.length <= 80 ? q : undefined;
}

/** Bounds sanos: dentro del mundo, n>s, e>w y como mucho 90° de alto por 180° de ancho. */
export function parseBounds(raw: unknown): Bounds | undefined {
  const o = obj(raw);
  const n = num(o.n);
  const s = num(o.s);
  const e = num(o.e);
  const w = num(o.w);
  if (n === null || s === null || e === null || w === null) {
    return undefined;
  }
  if (n > 85 || s < -85 || n <= s || e > 180 || w < -180 || e <= w) {
    return undefined;
  }
  if (n - s > 90 || e - w > 180) {
    return undefined;
  }
  return { n, s, e, w };
}

// ── HTTP y caché ─────────────────────────────────────────────────────────────

const cache = new Map<string, { hasta: number; valor: unknown }>();

async function pedirJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(timeout ? "El servicio del tiempo tardó demasiado en responder." : "Sin conexión con el servicio del tiempo.");
  }
  if (res.status === 429) {
    throw new Error("Demasiadas consultas al servicio del tiempo. Espera un minuto y vuelve a probar.");
  }
  if (!res.ok) {
    throw new Error(`El servicio del tiempo respondió con error ${res.status}.`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error("El servicio del tiempo devolvió una respuesta ilegible.");
  }
}

async function conCache<T>(clave: string, ttlMs: number, carga: () => Promise<T>): Promise<Resultado<T>> {
  const hit = cache.get(clave);
  if (hit && hit.hasta > Date.now()) {
    return { ok: hit.valor as T };
  }
  try {
    const valor = await carga();
    cache.set(clave, { hasta: Date.now() + ttlMs, valor });
    if (cache.size > 60) {
      const ahora = Date.now();
      for (const [k, v] of cache) {
        if (v.hasta <= ahora) {
          cache.delete(k);
        }
      }
    }
    return { ok: valor };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "No se pudo consultar el tiempo." };
  }
}

// ── Previsión ────────────────────────────────────────────────────────────────

const HOURLY = "temperature_2m,precipitation,precipitation_probability,cloud_cover,wind_speed_10m,wind_direction_10m,weather_code";
const DAILY =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset";
const CURRENT =
  "temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,precipitation,weather_code,is_day";

function col(h: Record<string, unknown>, k: string): unknown[] {
  return arr(h[k]);
}

export function parsePrevision(raw: unknown): Prevision {
  const r = obj(raw);
  const c = obj(r.current);
  const h = obj(r.hourly);
  const d = obj(r.daily);
  const tiempos = col(h, "time");
  if (!tiempos.length) {
    throw new Error("El servicio del tiempo no devolvió previsión para ese lugar.");
  }
  // La hora actual del lugar es `current.time`; la lista empieza en esa hora para dar 48 útiles.
  const ahora = str(c.time)?.slice(0, 13);
  let ini = ahora ? tiempos.findIndex((t) => typeof t === "string" && t.slice(0, 13) === ahora) : 0;
  if (ini < 0) {
    ini = 0;
  }
  const horas: Hora[] = [];
  for (let i = ini; i < tiempos.length && horas.length < 48; i++) {
    horas.push({
      t: String(tiempos[i]),
      temp: num(col(h, "temperature_2m")[i]),
      lluvia: num(col(h, "precipitation")[i]),
      probLluvia: num(col(h, "precipitation_probability")[i]),
      nubosidad: num(col(h, "cloud_cover")[i]),
      viento: num(col(h, "wind_speed_10m")[i]),
      direccion: num(col(h, "wind_direction_10m")[i]),
      codigo: num(col(h, "weather_code")[i]),
    });
  }
  const fechas = col(d, "time");
  const dias: Dia[] = fechas.slice(0, 7).map((f, i) => ({
    fecha: String(f),
    max: num(col(d, "temperature_2m_max")[i]),
    min: num(col(d, "temperature_2m_min")[i]),
    lluviaTotal: num(col(d, "precipitation_sum")[i]),
    probLluvia: num(col(d, "precipitation_probability_max")[i]),
    vientoMax: num(col(d, "wind_speed_10m_max")[i]),
    uv: num(col(d, "uv_index_max")[i]),
    codigo: num(col(d, "weather_code")[i]),
    amanecer: str(col(d, "sunrise")[i]),
    atardecer: str(col(d, "sunset")[i]),
  }));
  // El UV actual no está en `current` de forma fiable: se toma el máximo del día de hoy.
  const actual: Actual = {
    temp: num(c.temperature_2m),
    sensacion: num(c.apparent_temperature),
    humedad: num(c.relative_humidity_2m),
    presion: num(c.pressure_msl),
    viento: num(c.wind_speed_10m),
    rachas: num(c.wind_gusts_10m),
    direccion: num(c.wind_direction_10m),
    nubosidad: num(c.cloud_cover),
    lluvia: num(c.precipitation),
    uv: dias[0]?.uv ?? null,
    codigo: num(c.weather_code),
    esDia: c.is_day === 1,
  };
  return { actual, horas, dias };
}

export function cargarPrevision(lat: number, lon: number): Promise<Resultado<Prevision>> {
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  return conCache(`prev:${la},${lo}`, 10 * 60_000, async () => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}` +
      `&current=${CURRENT}&hourly=${HOURLY}&daily=${DAILY}` +
      `&forecast_days=7&forecast_hours=72&timezone=auto&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm`;
    return parsePrevision(await pedirJson(url));
  });
}

// ── Geocodificación ──────────────────────────────────────────────────────────

export async function buscarLugares(q: string): Promise<Resultado<LugarBusqueda[]>> {
  try {
    const raw = obj(
      await pedirJson(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&language=es&count=8&format=json`
      )
    );
    const lugares: LugarBusqueda[] = [];
    for (const it of arr(raw.results)) {
      const o = obj(it);
      const lat = num(o.latitude);
      const lon = num(o.longitude);
      const nombre = str(o.name);
      if (lat === null || lon === null || !nombre) {
        continue;
      }
      const pais = str(o.country);
      const region = str(o.admin1);
      lugares.push({ nombre, ...(pais ? { pais } : {}), ...(region ? { region } : {}), lat, lon });
    }
    return { ok: lugares };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "No se pudo buscar el lugar." };
  }
}

// ── Rejilla de mapa ──────────────────────────────────────────────────────────

const GRID_VARS = ["temperature_2m", "cloud_cover", "wind_speed_10m", "wind_direction_10m"] as const;

export function cargarRejilla(b: Bounds): Promise<Resultado<Rejilla>> {
  // Bounds redondeados a 0,5° para que un pequeño arrastre reutilice la caché.
  const r = (v: number, f: (x: number) => number) => f(v * 2) / 2;
  const nb: Bounds = {
    n: Math.min(85, r(b.n, Math.ceil)),
    s: Math.max(-85, r(b.s, Math.floor)),
    e: Math.min(180, r(b.e, Math.ceil)),
    w: Math.max(-180, r(b.w, Math.floor)),
  };
  return conCache(`rej:${nb.n},${nb.s},${nb.e},${nb.w}`, 10 * 60_000, async () => {
    // 10x10 como tope; la proporción sigue la del recuadro para que las celdas no salgan muy planas.
    const ancho = nb.e - nb.w;
    const alto = nb.n - nb.s;
    const nx = Math.max(2, Math.min(10, Math.round(10 * Math.sqrt(ancho / alto))));
    const ny = Math.max(2, Math.min(10, Math.floor(MAX_PUNTOS / nx)));
    const lats: string[] = [];
    const lons: string[] = [];
    for (let j = 0; j < ny; j++) {
      const lat = nb.n - (alto * j) / (ny - 1);
      for (let i = 0; i < nx; i++) {
        lats.push(lat.toFixed(3));
        lons.push((nb.w + (ancho * i) / (nx - 1)).toFixed(3));
      }
    }
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(",")}&longitude=${lons.join(",")}` +
      `&hourly=${GRID_VARS.join(",")}&forecast_days=2&timezone=GMT&wind_speed_unit=kmh`;
    const raw = await pedirJson(url);
    const puntos = Array.isArray(raw) ? raw : [raw];
    if (puntos.length !== nx * ny) {
      throw new Error("La rejilla del tiempo llegó incompleta.");
    }
    const horasDe = (p: unknown) => col(obj(obj(p).hourly), "time");
    const tiempos = horasDe(puntos[0]).map(String).slice(0, 48);
    if (!tiempos.length) {
      throw new Error("La rejilla del tiempo llegó vacía.");
    }
    const por = (k: string) =>
      tiempos.map((_, h) => puntos.map((p) => num(col(obj(obj(p).hourly), k)[h])));
    return {
      bounds: nb,
      nx,
      ny,
      tiempos,
      temp: por("temperature_2m"),
      nubosidad: por("cloud_cover"),
      viento: por("wind_speed_10m"),
      direccion: por("wind_direction_10m"),
    };
  });
}

// ── Radar (RainViewer) ───────────────────────────────────────────────────────

export function cargarRadar(): Promise<Resultado<Radar>> {
  return conCache("radar", 5 * 60_000, async () => {
    const raw = obj(await pedirJson("https://api.rainviewer.com/public/weather-maps.json"));
    const host = str(raw.host);
    if (!host || !/^https:\/\//.test(host)) {
      throw new Error("El radar de lluvia devolvió una respuesta que no vale.");
    }
    const r = obj(raw.radar);
    const frames: Radar["frames"] = [];
    for (const [lista, nowcast] of [[r.past, false], [r.nowcast, true]] as const) {
      for (const f of arr(lista)) {
        const o = obj(f);
        const time = num(o.time);
        const path = str(o.path);
        if (time !== null && path && path.startsWith("/")) {
          frames.push({ time, path, nowcast });
        }
      }
    }
    if (!frames.length) {
      throw new Error("El radar de lluvia no tiene fotogramas ahora mismo.");
    }
    return { host, frames, maxZoom: RADAR_MAX_ZOOM };
  });
}
