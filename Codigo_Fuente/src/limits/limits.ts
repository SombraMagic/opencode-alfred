import * as fs from "fs/promises";
import { parse as parseJsonc } from "jsonc-parser";
import type { OpencodeApi } from "../agents/connectors";
import { configFileCandidates, opencodeAuthPath, opencodeDataDir } from "../agents/paths";
import { listDbFiles, openSqliteReadOnly } from "../stats/opencodeStats";

export type LimitWindow = {
  id: string;
  label: string;
  used: number;
  limit: number;
  /** Con «porcentaje»: `used` es el 0-100 ya calculado por la consola y `limit` vale 100. */
  unit: "usd" | "solicitudes" | "tokens" | "porcentaje";
  resetsAt?: number /*epoch ms*/;
  /** Divisa ISO real del dato (p. ej. "USD", "CNY") cuando `unit` es "usd" y la hay. */
  currency?: string;
};

export type ProviderLimits = {
  id: string;
  name: string;
  plan?: string;
  status: "ok" | "error";
  error?: string;
  estimated?: boolean;
  windows: LimitWindow[];
  updatedAt: number;
};

export type GoPlan = "go" | "go-plus";

/** Topes del plan de OpenCode Go en USD (constantes del bundle de la consola). */
export const GO_PLAN_LIMITS: Record<GoPlan, { fiveH: number; week: number; month: number }> = {
  go: { fiveH: 12, week: 30, month: 60 },
  "go-plus": { fiveH: 48, week: 120, month: 240 },
};

const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Sondeo de límites: 60 s bastan para no martillear las APIs del proveedor. */
const RESULT_CACHE_MS = 60_000;
/** La sonda de soportabilidad es más cara (copilot canjea token): 10 min. */
const SUPPORT_CACHE_MS = 10 * 60_000;

const PROVIDER_NAMES: Record<string, string> = {
  deepseek: "DeepSeek",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  "github-copilot": "GitHub Copilot",
};

const resultCache = new Map<string, { at: number; value: ProviderLimits }>();
const resultInFlight = new Map<string, Promise<ProviderLimits>>();
const supportCache = new Map<string, { at: number; value: boolean }>();
const supportInFlight = new Map<string, Promise<boolean>>();

function nameOf(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

function errorLimits(id: string, error: string, updatedAt: number): ProviderLimits {
  return { id, name: nameOf(id), status: "error", error, windows: [], updatedAt };
}

function finiteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Acepta epoch en s o en ms, o ISO. undefined si no es una fecha válida. */
function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : undefined;
  }
  return undefined;
}

interface HttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** El cuerpo empieza por `<`: es HTML (portal cautivo, términos de servicio), no JSON. */
  isHtml: boolean;
}

/** GET JSON con tope de 8 s. Los errores salen ya en español, sin secretos. */
async function httpJson(url: string, headers: Record<string, string>): Promise<HttpResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      body,
      headers: out,
      isHtml: text.trimStart().startsWith("<"),
    };
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message))) {
      throw new Error("El proveedor no respondió a tiempo.");
    }
    if (err instanceof TypeError) {
      throw new Error("No se pudo contactar con el proveedor.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** auth.json de opencode. Las claves leídas de aquí jamás se loguean ni mandan al webview. */
async function readAuth(): Promise<Record<string, Record<string, unknown>>> {
  try {
    const obj = JSON.parse(await fs.readFile(opencodeAuthPath(), "utf8")) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, Record<string, unknown>> = {};
      for (const [id, value] of Object.entries(obj as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          out[id] = value as Record<string, unknown>;
        }
      }
      return out;
    }
  } catch {
    // sin auth.json: los proveedores quedan sin clave
  }
  return {};
}

async function readAuthField(id: string, field: string): Promise<string> {
  const auth = await readAuth();
  const value = auth[id]?.[field];
  return typeof value === "string" ? value : "";
}

/**
 * Clave `api` de un proveedor: primero la tabla `credential` (donde opencode v2 guarda
 * las claves nuevas), luego el auth.json heredado. Nunca se loguea ni viaja al webview.
 */
async function readProviderKey(id: string): Promise<string> {
  let best: { key: string; updated: number } | undefined;
  for (const file of listDbFiles(opencodeDataDir())) {
    const db = openSqliteReadOnly(file);
    if (!db) {
      continue;
    }
    try {
      const row = db
        .prepare(
          "SELECT value, time_updated FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1"
        )
        .get(id) as { value?: unknown; time_updated?: unknown } | undefined;
      if (!row || typeof row.value !== "string") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue; // `value` ilegible: se prueba con la siguiente BD
      }
      const key = (parsed as Record<string, unknown> | undefined)?.key;
      if (typeof key !== "string" || !key.trim()) {
        continue;
      }
      // Varias bases con clave: manda la fila actualizada más tarde (epoch ms).
      const updated = finiteNumber(row.time_updated) ?? 0;
      if (!best || updated > best.updated) {
        best = { key, updated };
      }
    } catch {
      // BD sin tabla `credential` (esquema v1): se ignora y sigue
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  return best ? best.key : await readAuthField(id, "key");
}

// ── DeepSeek ────────────────────────────────────────────────────────────────

/** Respuesta verificada: { is_available, balance_infos: [{ currency, total_balance, ... }] }. */
export function parseDeepseekBalance(body: unknown, updatedAt: number): ProviderLimits {
  const obj = (body ?? {}) as Record<string, unknown>;
  const infos = Array.isArray(obj.balance_infos) ? obj.balance_infos : [];
  const usd =
    infos.find((i) => (i as Record<string, unknown> | undefined)?.currency === "USD") ?? infos[0];
  const total = finiteNumber((usd as Record<string, unknown> | undefined)?.total_balance);
  if (total === undefined) {
    return errorLimits("deepseek", "DeepSeek no devolvió saldo.", updatedAt);
  }
  // La divisa real viaja en `currency` (el webview formatea con ella); la etiqueta
  // se queda limpia pase lo que pase con la divisa.
  const currencyRaw = (usd as Record<string, unknown>).currency;
  const currency = typeof currencyRaw === "string" && currencyRaw.trim() ? currencyRaw.toUpperCase() : undefined;
  return {
    id: "deepseek",
    name: nameOf("deepseek"),
    plan: obj.is_available ? "Disponible" : "Sin saldo",
    status: "ok",
    windows: [{ id: "balance", label: "Saldo restante", used: total, limit: 0, unit: "usd", ...(currency ? { currency } : {}) }],
    updatedAt,
  };
}

async function deepseekLimits(at: number): Promise<ProviderLimits> {
  const key = await readProviderKey("deepseek");
  if (!key) {
    throw new Error("Sin clave de DeepSeek.");
  }
  const res = await httpJson("https://api.deepseek.com/user/balance", {
    Authorization: `Bearer ${key}`,
  });
  if (res.status !== 200) {
    throw new Error(`DeepSeek respondió ${res.status}.`);
  }
  return parseDeepseekBalance(res.body, at);
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

export function monthStartUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function monthEndUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Suma de `amount.value` de los buckets; undefined si la forma no es la esperada. */
export function parseOpenaiCosts(body: unknown): number | undefined {
  const data = (body as Record<string, unknown> | undefined)?.data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  let total = 0;
  for (const item of data) {
    const buckets = (item as Record<string, unknown> | undefined)?.buckets;
    if (!Array.isArray(buckets)) {
      continue;
    }
    for (const bucket of buckets) {
      const results = (bucket as Record<string, unknown> | undefined)?.results;
      const entries = Array.isArray(results) ? results : [bucket];
      for (const r of entries) {
        const amount = (r as Record<string, unknown> | undefined)?.amount;
        const value = finiteNumber((amount as Record<string, unknown> | undefined)?.value);
        if (value !== undefined) {
          total += value;
        }
      }
    }
  }
  return total;
}

/** Respaldo sin scope de organización: cabeceras de límite de tokens del `GET /v1/models`. */
export function parseOpenaiRateHeaders(
  headers: Record<string, string>,
  status: number
): LimitWindow | undefined {
  if (status !== 200) {
    return undefined;
  }
  const limit = finiteNumber(headers["x-ratelimit-limit-tokens"]);
  const remaining = finiteNumber(headers["x-ratelimit-remaining-tokens"]);
  if (limit === undefined || limit <= 0 || remaining === undefined) {
    return undefined;
  }
  const win: LimitWindow = {
    id: "minute",
    label: "Límite por minuto",
    used: Math.max(0, limit - remaining),
    limit,
    unit: "tokens",
  };
  // reset-tokens vale solo si es epoch: si es «segundos restantes» no se interpreta.
  const reset = toEpochMs(finiteNumber(headers["x-ratelimit-reset-tokens"]));
  if (reset !== undefined && reset > 1e12) {
    win.resetsAt = reset;
  }
  return win;
}

async function openaiLimits(at: number): Promise<ProviderLimits> {
  const key = await readProviderKey("openai");
  if (!key) {
    throw new Error("Sin clave de OpenAI.");
  }
  const headers = { Authorization: `Bearer ${key}` };
  const startS = Math.floor(monthStartUtc(at) / 1000);
  const costs = await httpJson(
    `https://api.openai.com/v1/organization/costs?start_time=${startS}&bucket_width=1d`,
    headers
  );
  if (costs.status === 401 || costs.status === 403) {
    // Clave sin scope admin de organización: queda el límite de tokens por minuto.
    const models = await httpJson("https://api.openai.com/v1/models", headers);
    const win = parseOpenaiRateHeaders(models.headers, models.status);
    if (!win) {
      throw new Error(`OpenAI respondió ${costs.status} y sin cabeceras de límite.`);
    }
    return { id: "openai", name: nameOf("openai"), status: "ok", windows: [win], updatedAt: at };
  }
  if (costs.status !== 200) {
    throw new Error(`OpenAI respondió ${costs.status}.`);
  }
  const used = parseOpenaiCosts(costs.body);
  if (used === undefined) {
    throw new Error("OpenAI no devolvió gastos.");
  }
  return {
    id: "openai",
    name: nameOf("openai"),
    status: "ok",
    windows: [{ id: "month", label: "Gasto del mes", used, limit: 0, unit: "usd" }],
    updatedAt: at,
  };
}

// ── GitHub Copilot ──────────────────────────────────────────────────────────

const COPILOT_LABELS: Record<string, string> = {
  premium_interactions: "Peticiones premium",
  chat: "Chat",
  completions: "Autocompletado",
};

const COPILOT_PLANS: Record<string, string> = {
  individual: "Individual",
  business: "Business",
  enterprise: "Enterprise",
};

// opencode NO canjea `/copilot_internal/v2/token`: con el access de auth.json da 403
// (HTML de términos); el flujo de dispositivo llama directo a `/user` con ese Bearer.
function copilotUserHeaders(access: string): Record<string, string> {
  return {
    Authorization: `Bearer ${access}`,
    Accept: "application/json",
    "User-Agent": "opencode-alfred",
    "X-GitHub-Api-Version": "2025-05-01",
  };
}

/**
 * `quota_snapshots` → ventanas por bloque medido (`unlimited:false` y tope > 0).
 * `used` prefiere `credits_used` (consumo real, incluye el sobrepase) sobre
 * `entitlement − remaining`. Con todos los bloques ilimitados, tarjeta única.
 */
export function parseCopilotQuota(body: unknown, updatedAt: number): ProviderLimits {
  const obj = (body ?? {}) as Record<string, unknown>;
  const snapshots = (obj.quota_snapshots ?? {}) as Record<string, unknown>;
  const rawPlan = typeof obj.copilot_plan === "string" ? obj.copilot_plan.trim() : "";
  const plan = rawPlan ? COPILOT_PLANS[rawPlan.toLowerCase()] ?? rawPlan : undefined;
  // `quota_reset_date` es «YYYY-MM-DD» (medianoche UTC); `quota_reset_at` llega en s o ms.
  const resetsAt = toEpochMs(obj.quota_reset_date) ?? toEpochMs(obj.quota_reset_at);
  const windows: LimitWindow[] = [];
  let hayIlimitados = false;
  for (const [block, raw] of Object.entries(snapshots)) {
    const val = (raw ?? {}) as Record<string, unknown>;
    if (val.unlimited === true) {
      hayIlimitados = true;
      continue;
    }
    const entitlement = finiteNumber(val.entitlement);
    if (entitlement === undefined || entitlement <= 0) {
      continue;
    }
    const credits = finiteNumber(val.credits_used);
    const remaining = finiteNumber(val.remaining) ?? 0;
    const used = credits !== undefined && credits >= 0 ? credits : Math.max(0, entitlement - remaining);
    const win: LimitWindow = {
      id: block,
      label: COPILOT_LABELS[block] ?? block,
      used,
      limit: entitlement,
      unit: "solicitudes",
    };
    if (resetsAt !== undefined && resetsAt > 1e12) {
      win.resetsAt = resetsAt;
    }
    windows.push(win);
  }
  if (windows.length === 0) {
    if (!hayIlimitados) {
      return errorLimits("github-copilot", "Copilot no informó cuotas.", updatedAt);
    }
    return {
      id: "github-copilot",
      name: nameOf("github-copilot"),
      ...(plan ? { plan } : {}),
      status: "ok",
      windows: [{ id: "unlimited", label: "Plan ilimitado", used: 0, limit: 0, unit: "solicitudes" }],
      updatedAt,
    };
  }
  return {
    id: "github-copilot",
    name: nameOf("github-copilot"),
    ...(plan ? { plan } : {}),
    status: "ok",
    windows,
    updatedAt,
  };
}

async function copilotLimits(at: number): Promise<ProviderLimits> {
  const access = await readAuthField("github-copilot", "access");
  if (!access) {
    throw new Error("Sin credencial de GitHub Copilot.");
  }
  const res = await httpJson("https://api.github.com/copilot_internal/user", copilotUserHeaders(access));
  if (res.isHtml) {
    // Nunca se propaga el HTML: solo el estado.
    throw new Error(`GitHub no devolvió JSON (${res.status} de términos de servicio).`);
  }
  if (res.status !== 200) {
    throw new Error(`GitHub respondió ${res.status}.`);
  }
  if (!res.body || typeof res.body !== "object") {
    throw new Error("GitHub no devolvió JSON.");
  }
  return parseCopilotQuota(res.body, at);
}

// ── OpenCode Go (estimación local sobre las BD de opencode, solo lectura) ───

export interface GoCostRow {
  created: number;
  cost: number;
}

/** Tokens de un mensaje assistant con modelo opencode-go/*, listos para tarifar. */
export interface GoMsgRow {
  created: number;
  /** Id del modelo (campo `id` de `data.model`), clave para buscar la tarifa. */
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Tarifas en USD por millón de tokens (`cost.text` del catálogo de opencode). */
export interface GoPrices {
  input: number;
  cacheRead: number;
  output: number;
  cacheWrite?: number;
}

/**
 * Coste de un mensaje: tokens × tarifa / 1e6. Límite: las tarifas del catálogo
 * no distinguen pico/valle ni aplican sus `overrides` por longitud de contexto.
 */
export function goMessageCost(r: GoMsgRow, p: GoPrices | undefined): number {
  if (!p) {
    return 0;
  }
  const write = p.cacheWrite ? r.cacheWrite * p.cacheWrite : 0;
  return (r.input * p.input + r.cacheRead * p.cacheRead + write + r.output * p.output) / 1e6;
}

/**
 * Ventanas Go a partir de filas y tarifas. Con mensajes del proveedor pero ninguna
 * tarifa en el catálogo, opencode no anota coste real (sale 0): mejor avisar que
 * pintar barras a cero. El plan siempre es el ajuste `goPlan`: no se inventa.
 */
export function buildGoEstimate(
  rows: GoMsgRow[],
  prices: Map<string, GoPrices>,
  at: number,
  plan: GoPlan
): ProviderLimits {
  if (rows.length > 0 && !rows.some((r) => prices.has(r.model))) {
    return errorLimits(
      "opencode-go",
      `opencode no anota coste y el catálogo no trae tarifa para ${rows[0].model}.`,
      at
    );
  }
  const costed: GoCostRow[] = rows.map((r) => ({
    created: r.created,
    cost: goMessageCost(r, prices.get(r.model)),
  }));
  return {
    id: "opencode-go",
    name: nameOf("opencode-go"),
    plan: plan === "go" ? "Go" : "Go Plus",
    status: "ok",
    estimated: true,
    windows: goWindows(costed, at, plan),
    updatedAt: at,
  };
}

export function utcWeekStart(now: number): number {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const dow = new Date(dayStart).getUTCDay();
  return dayStart - ((dow + 6) % 7) * DAY_MS;
}

/** Las tres ventanas del plan Go: 5 h rodante, semana UTC (lunes 00:00) y mes UTC. */
export function goWindows(rows: GoCostRow[], now: number, plan: GoPlan): LimitWindow[] {
  const caps = GO_PLAN_LIMITS[plan];
  const fiveStart = now - 5 * 3_600_000;
  const weekStart = utcWeekStart(now);
  const weekEnd = weekStart + 7 * DAY_MS;
  const monthStart = monthStartUtc(now);
  const monthEnd = monthEndUtc(now);
  let five = 0;
  let week = 0;
  let month = 0;
  for (const r of rows) {
    if (r.created >= fiveStart) {
      five += r.cost;
    }
    if (r.created >= weekStart && r.created < weekEnd) {
      week += r.cost;
    }
    if (r.created >= monthStart && r.created < monthEnd) {
      month += r.cost;
    }
  }
  // Dos decimales: el ruido de punto flotante del sumatorio no debe asomar en la barra.
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return [
    { id: "5h", label: "Últimas 5 horas", used: round2(five), limit: caps.fiveH, unit: "usd" },
    { id: "week", label: "Semana", used: round2(week), limit: caps.week, unit: "usd", resetsAt: weekEnd },
    { id: "month", label: "Mes", used: round2(month), limit: caps.month, unit: "usd", resetsAt: monthEnd },
  ];
}

/** Proveedor de un campo `model` (objeto con providerID, JSON en string o "prov/id"). */
function providerOf(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const p = (raw as Record<string, unknown>).providerID;
    return typeof p === "string" ? p : "";
  }
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      return typeof obj.providerID === "string" ? obj.providerID : "";
    } catch {
      const slash = raw.indexOf("/");
      return slash > 0 ? raw.slice(0, slash) : "";
    }
  }
  return "";
}

/** Id de modelo dentro de `data.model` (objeto o string JSON o "prov/id"). */
function modelIdOf(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const id = (raw as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  if (typeof raw === "string") {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      return typeof obj.id === "string" ? obj.id : "";
    } catch {
      const slash = raw.indexOf("/");
      return slash > 0 ? raw.slice(slash + 1) : raw;
    }
  }
  return "";
}

interface GoScan {
  ok: boolean;
  error?: string;
  rows: GoMsgRow[];
}

/** Tokens de los mensajes assistant con modelo opencode-go/* (esquema v2). */
function scanGoMessages(dataDir: string = opencodeDataDir()): GoScan {
  const dbs = listDbFiles(dataDir);
  if (dbs.length === 0) {
    return { ok: false, error: "No hay bases de datos de opencode.", rows: [] };
  }
  const rows: GoMsgRow[] = [];
  let opened = 0;
  for (const file of dbs) {
    // Estricta lectura (openSqliteReadOnly): nunca se toca ni se crea una BD de opencode.
    const db = openSqliteReadOnly(file);
    if (!db) {
      continue;
    }
    opened += 1;
    try {
      const sessionProvider = new Map<string, string>();
      try {
        const srows = db.prepare("SELECT id, model FROM session_v2").all() as Array<
          Record<string, unknown>
        >;
        for (const r of srows) {
          sessionProvider.set(String(r.id), providerOf(r.model));
        }
      } catch {
        // esquema v1: no aporta consumos de Go, se omite la base
        continue;
      }
      const mrows = db
        .prepare("SELECT session_id, time_created, data FROM session_message WHERE type='assistant'")
        .all() as Array<Record<string, unknown>>;
      for (const row of mrows) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(row.data)) as Record<string, unknown>;
        } catch {
          continue;
        }
        const provider = providerOf(msg.model) || sessionProvider.get(String(row.session_id)) || "";
        if (provider !== "opencode-go") {
          continue;
        }
        const time = (msg.time ?? {}) as Record<string, unknown>;
        const created = finiteNumber(time.created) ?? finiteNumber(row.time_created) ?? 0;
        const tokens = (msg.tokens ?? {}) as Record<string, unknown>;
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        if (created > 0) {
          rows.push({
            created,
            model: modelIdOf(msg.model),
            input: finiteNumber(tokens.input) ?? 0,
            output: finiteNumber(tokens.output) ?? 0,
            cacheRead: finiteNumber(cache.read) ?? 0,
            cacheWrite: finiteNumber(cache.write) ?? 0,
          });
        }
      }
    } catch {
      // BD ilegible a media pasada: se omite y sigue con la siguiente
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (opened === 0) {
    return {
      ok: false,
      error: "El Node del editor no trae node:sqlite o las bases no se pueden abrir.",
      rows: [],
    };
  }
  return { ok: true, rows };
}

/** El catálogo vivo son 11 MB: se reparsea solo cuando opencode publica otro. */
let goCatalogCache: { sig: string; prices: Map<string, GoPrices> } | undefined;

function parseGoPrices(catalog: Record<string, unknown>): Map<string, GoPrices> {
  const out = new Map<string, GoPrices>();
  const provider = catalog["opencode-go"] as Record<string, unknown> | undefined;
  const models = (provider?.models ?? {}) as Record<string, unknown>;
  for (const [id, raw] of Object.entries(models)) {
    const cost = (raw as Record<string, unknown> | undefined)?.cost as
      | Record<string, unknown>
      | undefined;
    const text = cost?.text as Record<string, unknown> | undefined;
    const input = text?.input as Record<string, unknown> | undefined;
    const output = text?.output as Record<string, unknown> | undefined;
    const cache = input?.cache as Record<string, unknown> | undefined;
    const pIn = finiteNumber(input?.price);
    const pOut = finiteNumber(output?.price);
    const pRead = finiteNumber(cache?.read);
    if (pIn === undefined || pOut === undefined || pRead === undefined) {
      continue;
    }
    const prices: GoPrices = { input: pIn, cacheRead: pRead, output: pOut };
    const pWrite = finiteNumber(cache?.write);
    if (pWrite !== undefined) {
      prices.cacheWrite = pWrite;
    }
    out.set(id, prices);
  }
  return out;
}

/** Tarifas `cost.text` del catálogo models.dev vivo que opencode guarda en `kv`. */
export function readGoCatalogPrices(dataDir: string = opencodeDataDir()): Map<string, GoPrices> {
  for (const file of listDbFiles(dataDir)) {
    const db = openSqliteReadOnly(file);
    if (!db) {
      continue;
    }
    try {
      let row: { value?: unknown } | undefined;
      for (const key of ["models-dev:v2:catalog", "models-dev:catalog"]) {
        try {
          row = db.prepare("SELECT value FROM kv WHERE key=?").get(key) as
            | { value?: unknown }
            | undefined;
          if (typeof row?.value === "string") {
            break;
          }
        } catch {
          row = undefined; // BD sin tabla kv (esquema v1 viejo): a por la siguiente
        }
      }
      if (typeof row?.value !== "string") {
        continue;
      }
      const wrapped = JSON.parse(row.value) as Record<string, unknown>;
      const body = wrapped.body;
      if (typeof body !== "string") {
        continue;
      }
      const sig = `${wrapped.updatedAt ?? ""}:${wrapped.digest ?? ""}:${body.length}`;
      if (goCatalogCache && goCatalogCache.sig === sig) {
        return goCatalogCache.prices;
      }
      const catalog = JSON.parse(body) as Record<string, unknown>;
      const prices = parseGoPrices(catalog);
      goCatalogCache = { sig, prices };
      return prices;
    } catch {
      // catálogo ilegible: se prueba con la siguiente BD
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  return new Map();
}

async function goLimits(at: number, plan: GoPlan, api?: OpencodeApi): Promise<ProviderLimits> {
  // La consola da el consumo real de la cuenta; la estimación sobre las BD es el respaldo.
  if (api) {
    try {
      const data = parseConsoleLimits(JSON.parse(await api("GET", "/api/experimental/usage/limits")));
      if (data?.go) {
        return buildGoFromConsole(data, at, plan);
      }
    } catch {
      // opencode en marcha pero sin esa ruta (build viejo): se estima como siempre
    }
  }
  const scan = scanGoMessages();
  if (!scan.ok) {
    return errorLimits("opencode-go", scan.error ?? "Sin datos.", at);
  }
  return buildGoEstimate(scan.rows, readGoCatalogPrices(), at, plan);
}

// ── OpenCode Go desde la consola (dato real; la estimación queda de respaldo) ─

export interface ConsoleGoWindow {
  percent: number;
  limited: boolean;
  resetsAt?: number /*epoch ms*/;
}

export interface ConsoleBudget {
  ruleID?: string;
  policyID?: string;
  limitDollars?: number;
  spentDollars?: number;
  coverage?: string;
  modelCount?: number;
  resetsAt?: number /*epoch ms*/;
}

export interface ConsoleLimits {
  go?: { rolling?: ConsoleGoWindow; weekly?: ConsoleGoWindow; monthly?: ConsoleGoWindow };
  budgets?: ConsoleBudget[];
}

function consoleGoWindow(raw: unknown): ConsoleGoWindow | undefined {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const percent = finiteNumber(obj.percent);
  if (percent === undefined) {
    return undefined;
  }
  const win: ConsoleGoWindow = {
    percent: Math.max(0, Math.min(100, percent)),
    limited: obj.limited === true || obj.limited === "true",
  };
  const resetsAt = toEpochMs(obj.resetsAt);
  if (resetsAt !== undefined) {
    win.resetsAt = resetsAt;
  }
  return win;
}

function consoleBudget(raw: unknown): ConsoleBudget | undefined {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const limitDollars = finiteNumber(obj.limitDollars);
  if (limitDollars === undefined || limitDollars <= 0) {
    return undefined;
  }
  const budget: ConsoleBudget = { limitDollars };
  const spentDollars = finiteNumber(obj.spentDollars);
  if (spentDollars !== undefined) {
    budget.spentDollars = spentDollars;
  }
  if (typeof obj.ruleID === "string") {
    budget.ruleID = obj.ruleID;
  }
  if (typeof obj.policyID === "string") {
    budget.policyID = obj.policyID;
  }
  if (typeof obj.coverage === "string") {
    budget.coverage = obj.coverage;
  }
  const modelCount = finiteNumber(obj.modelCount);
  if (modelCount !== undefined) {
    budget.modelCount = modelCount;
  }
  const resetsAt = toEpochMs(obj.resetsAt);
  if (resetsAt !== undefined) {
    budget.resetsAt = resetsAt;
  }
  return budget;
}

/** `GET /api/experimental/usage/limits`: la respuesta envuelve en `{ location, data }`. */
export function parseConsoleLimits(body: unknown): ConsoleLimits | undefined {
  const data = (body as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const out: ConsoleLimits = {};
  const goRaw = (data.go ?? {}) as Record<string, unknown>;
  const go: NonNullable<ConsoleLimits["go"]> = {};
  const rolling = consoleGoWindow(goRaw.rolling);
  const weekly = consoleGoWindow(goRaw.weekly);
  const monthly = consoleGoWindow(goRaw.monthly);
  if (rolling) {
    go.rolling = rolling;
  }
  if (weekly) {
    go.weekly = weekly;
  }
  if (monthly) {
    go.monthly = monthly;
  }
  if (Object.keys(go).length === 0) {
    return undefined;
  }
  out.go = go;
  const budgets = (Array.isArray(data.budgets) ? data.budgets : [])
    .map(consoleBudget)
    .filter((b): b is ConsoleBudget => b !== undefined);
  if (budgets.length > 0) {
    out.budgets = budgets;
  }
  return out;
}

/** Etiquetas y orden de las tres ventanas Go de la consola. */
const CONSOLE_WINDOW_KEYS: Array<{ key: "rolling" | "weekly" | "monthly"; label: string }> = [
  { key: "rolling", label: "Últimas 5 horas" },
  { key: "weekly", label: "Semana" },
  { key: "monthly", label: "Mes" },
];

/**
 * Tarjeta Go con el consumo real de la consola (sin `estimated`). Una ventana `limited`
 * conserva su porcentaje y lo dice en la etiqueta: inflarla al 100 % escondía el dato.
 */
export function buildGoFromConsole(data: ConsoleLimits, at: number, plan: GoPlan): ProviderLimits {
  const windows: LimitWindow[] = [];
  for (const { key, label } of CONSOLE_WINDOW_KEYS) {
    const w = data.go?.[key];
    if (!w) {
      continue;
    }
    const win: LimitWindow = {
      id: key,
      label: w.limited ? `${label} · al límite` : label,
      used: w.percent,
      limit: 100,
      unit: "porcentaje",
    };
    if (w.resetsAt !== undefined) {
      win.resetsAt = w.resetsAt;
    }
    windows.push(win);
  }
  // Los presupuestos en USD caen en la misma tarjeta.
  (data.budgets ?? []).forEach((b, i) => {
    if (b.limitDollars === undefined || b.limitDollars <= 0) {
      return;
    }
    const win: LimitWindow = {
      id: `budget-${i}`,
      label: "Presupuesto",
      used: b.spentDollars ?? 0,
      limit: b.limitDollars,
      unit: "usd",
    };
    if (b.resetsAt !== undefined) {
      win.resetsAt = b.resetsAt;
    }
    windows.push(win);
  });
  return {
    id: "opencode-go",
    name: nameOf("opencode-go"),
    plan: plan === "go" ? "Go" : "Go Plus",
    status: "ok",
    windows,
    updatedAt: at,
  };
}

// ── ¿Hay conexión con ese proveedor? ────────────────────────────────────────

/** Sonda real: 200 con `quota_snapshots` (aunque todo sea ilimitado). Cacheada 10 min. */
async function copilotProbe(access: string): Promise<boolean> {
  try {
    const res = await httpJson("https://api.github.com/copilot_internal/user", copilotUserHeaders(access));
    if (res.status !== 200) {
      return false;
    }
    const snapshots = (res.body as Record<string, unknown> | undefined)?.quota_snapshots;
    return !!snapshots && typeof snapshots === "object" && !Array.isArray(snapshots);
  } catch {
    return false;
  }
}

/** auth.json, entrada `provider`/`providers` en la config o conexión en la tabla `credential`. */
async function hasGoConnection(): Promise<boolean> {
  const auth = await readAuth();
  if (auth["opencode-go"]) {
    return true;
  }
  for (const file of configFileCandidates()) {
    try {
      const obj = parseJsonc(await fs.readFile(file, "utf8")) as Record<string, unknown> | undefined;
      for (const key of ["provider", "providers"]) {
        const map = obj?.[key];
        if (
          map &&
          typeof map === "object" &&
          !Array.isArray(map) &&
          (map as Record<string, unknown>)["opencode-go"] !== undefined
        ) {
          return true;
        }
      }
    } catch {
      // fichero ilegible: se prueba con el siguiente
    }
  }
  for (const file of listDbFiles(opencodeDataDir())) {
    const db = openSqliteReadOnly(file);
    if (!db) {
      continue;
    }
    try {
      const row = db
        .prepare("SELECT 1 AS one FROM credential WHERE integration_id = ?")
        .get("opencode-go");
      if (row) {
        return true;
      }
    } catch {
      // BD sin tabla credential (esquema v1)
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/** Proveedores con adaptador de límites: lista blanca de escrituras a `limitsProviders`. */
export const LIMITS_ADAPTER_IDS = ["deepseek", "openai", "github-copilot", "opencode-go"] as const;

/**
 * Lista nueva de `opencodeAgents.limitsProviders` con `id` añadido o quitado:
 * deduplicada, sin vacíos. Se usa al marcar/desmarcar y al purgar conectores borrados.
 */
export function withLimitsProvider(ids: string[], id: string, on: boolean): string[] {
  const set = new Set(ids.filter((x) => typeof x === "string" && x !== ""));
  if (on) {
    set.add(id);
  } else {
    set.delete(id);
  }
  return [...set];
}

/**
 * Lectura saneada del ajuste `limitsProviders`: ni basura de tipos ni ids sin
 * adaptador — un id desconocido metido a mano crearía una tarjeta «Sin adaptador»
 * que la UI no puede quitar.
 */
export function sanitizeLimitsIds(raw: unknown): string[] {
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x !== "") : [];
  return [...new Set(ids)].filter((id) => (LIMITS_ADAPTER_IDS as readonly string[]).includes(id));
}

/**
 * Guard del repintado asíncrono de Conectores: tras la sonda, `repaint` solo si
 * `data` sigue siendo el catálogo pintado (identidad con `latest()`). Un repintado
 * viejo cerraría formularios abiertos y resucitaría conectores ya borrados.
 */
export async function repaintIfLatest<T>(
  data: T,
  latest: () => T | undefined,
  changed: Promise<boolean>,
  repaint: (data: T) => void
): Promise<void> {
  if ((await changed) && latest() === data) {
    repaint(data);
  }
}

/** ¿El panel de límites puede ofrecer este proveedor? Cacheado 10 min. */
export async function supportsLimits(id: string): Promise<boolean> {
  const hit = supportCache.get(id);
  if (hit && Date.now() - hit.at < SUPPORT_CACHE_MS) {
    return hit.value;
  }
  // Caché fría con dos sondas simultáneas: comparten la promesa en vuelo
  // (Copilot no canjea su token dos veces por un mismo repintado).
  const running = supportInFlight.get(id);
  if (running) {
    return running;
  }
  const probe = probeSupport(id).then((value) => {
    supportCache.set(id, { at: Date.now(), value });
    supportInFlight.delete(id);
    return value;
  });
  supportInFlight.set(id, probe);
  return probe;
}

async function probeSupport(id: string): Promise<boolean> {
  try {
    if (id === "deepseek" || id === "openai") {
      return (await readProviderKey(id)) !== "";
    }
    if (id === "github-copilot") {
      const access = await readAuthField("github-copilot", "access");
      return access !== "" && (await copilotProbe(access));
    }
    if (id === "opencode-go") {
      return await hasGoConnection();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Valor ya sondeado (caché de 10 min) o `false`: síncrono y sin red, para pintar
 * Conectores de inmediato. `supportsLimits` lanza la sonda real después.
 */
export function supportsLimitsCached(id: string): boolean {
  const hit = supportCache.get(id);
  return hit && Date.now() - hit.at < SUPPORT_CACHE_MS ? hit.value : false;
}

// ── Entrada del host ────────────────────────────────────────────────────────

async function limitsFor(
  id: string,
  plan: GoPlan,
  now: number,
  api?: OpencodeApi
): Promise<ProviderLimits> {
  try {
    switch (id) {
      case "deepseek":
        return await deepseekLimits(now);
      case "openai":
        return await openaiLimits(now);
      case "github-copilot":
        return await copilotLimits(now);
      case "opencode-go":
        return await goLimits(now, plan, api);
      default:
        throw new Error(`Sin adaptador de límites para «${id}».`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorLimits(id, msg.slice(0, 160), now);
  }
}

/**
 * Consumo de los proveedores pedidos. Cada resultado se cachea 60 s por id y plan
 * (`force` la salta, para el botón REFRESCAR y el alta desde Conectores). Dos
 * llamadas concurrentes por la misma clave comparten la petición en vuelo: ni el
 * botón ni el sondeo del panel doblan las consultas a los proveedores.
 */
export async function collectLimits(
  ids: string[],
  opts: { goPlan: GoPlan; force?: boolean; api?: OpencodeApi }
): Promise<ProviderLimits[]> {
  const now = Date.now();
  return Promise.all(
    ids.map((id) => {
      const key = `${id}|${opts.goPlan}`;
      const hit = resultCache.get(key);
      if (!opts.force && hit && now - hit.at < RESULT_CACHE_MS) {
        return Promise.resolve(hit.value);
      }
      const running = resultInFlight.get(key);
      if (running) {
        return running;
      }
      // `limitsFor` no rechaza nunca: el .then siempre limpia la entrada en vuelo.
      const probe = limitsFor(id, opts.goPlan, now, opts.api).then((value) => {
        resultCache.set(key, { at: Date.now(), value });
        resultInFlight.delete(key);
        return value;
      });
      resultInFlight.set(key, probe);
      return probe;
    })
  );
}
