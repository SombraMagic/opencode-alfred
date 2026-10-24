import * as fs from "fs";
import {
  isSamePath,
  opencodeDataDir,
  opencodeModelsCachePath,
  projectRoot,
} from "../agents/paths";
import { dbSignature, listDbFiles, openSqlite, parseModel } from "./opencodeStats";

export interface ContextSlice {
  key: string;
  label: string;
  tokens: number;
  estimated: boolean;
}

export interface ContextWindowInfo {
  ok: boolean;
  error?: string;
  sessionId?: string;
  title?: string;
  agent?: string;
  model?: string;
  /** Tokens de la última petición (input + caché leída + caché escrita); si `estimated`, aproximado. */
  used: number;
  /** Ventana del modelo; 0 si el registro no la trae. */
  limit: number;
  /** El total es estimado: aún no hay petición medida tras la compactación. */
  estimated?: boolean;
  slices: ContextSlice[];
  scannedAt: number;
}

interface SessionRow {
  id: string;
  title: string;
  agent: string;
  model: string;
  directory: string;
  time_updated: number;
}

type Db = NonNullable<ReturnType<typeof openSqlite>>;

const LABELS: Record<string, string> = {
  "core/instructions": "Instrucciones (AGENTS.md)",
  "core/skill-guidance": "Skills",
  "core/codemode": "Herramientas",
  "core/reference-guidance": "Referencias",
  "core/environment": "Entorno",
  "core/date": "Fecha",
};
const ORDER = Object.keys(LABELS);

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasTable(db: Db, name: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

function orderOf(key: string): number {
  const i = ORDER.indexOf(key);
  return i < 0 ? ORDER.length : i;
}

let registryCache: { key: string; registry: Record<string, unknown> } | undefined;

/** Registro models.dev cacheado por mtime+tamaño (el fichero pesa varios MB). */
function loadRegistry(): Record<string, unknown> | undefined {
  const file = opencodeModelsCachePath();
  try {
    const st = fs.statSync(file);
    const key = `${file}:${st.mtimeMs}:${st.size}`;
    if (registryCache?.key === key) {
      return registryCache.registry;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const registry =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    registryCache = { key, registry };
    return registry;
  } catch {
    return undefined;
  }
}

let catalogCache: { key: string; catalog: Record<string, unknown> } | undefined;

// El id puede contener "/", así que sólo el primer separador es proveedor/modelo.
function modelParts(model: string): [string, string] | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return undefined;
  }
  return [model.slice(0, slash), model.slice(slash + 1)];
}

function limitIn(registry: Record<string, unknown>, providerId: string, modelId: string): number {
  const provider = registry[providerId] as Record<string, unknown> | undefined;
  const models = provider?.models as Record<string, unknown> | undefined;
  const entry = models?.[modelId] as Record<string, unknown> | undefined;
  const limit = entry?.limit as Record<string, unknown> | undefined;
  const context = limit?.context;
  return typeof context === "number" && Number.isFinite(context) && context > 0 ? context : 0;
}

function contextLimit(model: string): number {
  const parts = modelParts(model);
  if (!parts) {
    return 0;
  }
  const registry = loadRegistry();
  return registry ? limitIn(registry, parts[0], parts[1]) : 0;
}

/**
 * Catálogo models.dev vivo que opencode guarda en la tabla kv de su BD: el
 * models.json de ~/.cache se queda obsoleto y no trae los modelos añadidos después.
 */
function catalogLimit(db: Db, model: string): number {
  const parts = modelParts(model);
  if (!parts) {
    return 0;
  }
  try {
    const row = db
      .prepare("SELECT value FROM kv WHERE key='models-dev:catalog'")
      .get() as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") {
      return 0;
    }
    const wrapped = JSON.parse(row.value) as Record<string, unknown>;
    const body = typeof wrapped.body === "string" ? wrapped.body : "";
    // Cuerpo de varios MB: sólo se reparsea cuando opencode publica otro catálogo.
    const key = `${num(wrapped.updatedAt)}:${body.length}`;
    if (!catalogCache || catalogCache.key !== key) {
      const parsed = JSON.parse(body) as unknown;
      catalogCache = {
        key,
        catalog: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {},
      };
    }
    return limitIn(catalogCache.catalog, parts[0], parts[1]);
  } catch {
    return 0;
  }
}

export class ContextWindowService {
  private cache?: { sig: string; info: ContextWindowInfo };

  async collect(): Promise<ContextWindowInfo> {
    const dataDir = opencodeDataDir();
    const dbs = listDbFiles(dataDir);
    const scannedAt = Date.now();

    if (dbs.length === 0) {
      return {
        ok: false,
        error: `No se encontraron bases de datos de opencode en ${dataDir}`,
        used: 0,
        limit: 0,
        slices: [],
        scannedAt,
      };
    }

    // La sesión elegida depende de la carpeta abierta, así que entra en la clave de caché.
    const sig = `${dbSignature(dbs)}|${projectRoot() ?? ""}`;
    if (this.cache && this.cache.sig === sig) {
      return this.cache.info;
    }

    try {
      const info = this.scan(dbs, scannedAt);
      this.cache = { sig, info };
      return info;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        used: 0,
        limit: 0,
        slices: [],
        scannedAt,
      };
    }
  }

  private scan(dbs: string[], scannedAt: number): ContextWindowInfo {
    const root = projectRoot();
    let best: { project: boolean; updated: number; info: ContextWindowInfo } | undefined;

    for (const file of dbs) {
      const db = openSqlite(file);
      if (!db) {
        continue;
      }
      try {
        db.exec("PRAGMA busy_timeout=3000");
        if (!hasTable(db, "session_v2") || !hasTable(db, "session_message")) {
          continue;
        }
        const rows = db
          .prepare(
            "SELECT id, title, agent, model, directory, time_updated FROM session_v2 " +
              "WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 100"
          )
          .all() as unknown as SessionRow[];
        if (rows.length === 0) {
          continue;
        }
        const match = root && rows.find((r) => r.directory && isSamePath(r.directory, root));
        const session = match || rows[0];
        const project = !!match;
        const updated = num(session.time_updated);
        // Prefiere siempre una sesión del proyecto abierto, aunque otra BD tenga una más nueva.
        if (best && (best.project !== project ? best.project : best.updated >= updated)) {
          continue;
        }
        best = { project, updated, info: this.readSession(db, session, scannedAt) };
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
    }

    if (!best) {
      return {
        ok: false,
        error: "No hay sesiones de opencode todavía.",
        used: 0,
        limit: 0,
        slices: [],
        scannedAt,
      };
    }
    return best.info;
  }

  private readSession(db: Db, session: SessionRow, scannedAt: number): ContextWindowInfo {
    const model = parseModel(session.model);
    const compaction = this.lastCompaction(db, session.id);
    const afterSeq = compaction?.seq ?? -1;
    let used = this.usedTokens(db, session.id, afterSeq);

    const slices = this.systemSlices(db, session.id);
    const conversation = this.conversationTokens(db, session.id, afterSeq, compaction?.chars ?? 0);
    if (conversation > 0) {
      slices.push({
        key: "conversation",
        label: "Conversación",
        tokens: conversation,
        estimated: true,
      });
    }

    // Los textos guardados sólo dan una estimación: si suman más que la petición real,
    // se reparten proporcionalmente para que el total cuadre con lo medido.
    const estimated = slices.reduce((n, s) => n + s.tokens, 0);
    // Recién compactado no hay petición medida: el resumen ocupa su sitio hasta la siguiente.
    let estimatedTotal = false;
    if (compaction && used <= 0 && estimated > 0) {
      used = estimated;
      estimatedTotal = true;
    }
    let finalSlices: ContextSlice[];
    if (estimated > used && estimated > 0) {
      const factor = used / estimated;
      finalSlices = slices.map((s) => ({ ...s, tokens: Math.round(s.tokens * factor) }));
    } else {
      finalSlices = slices;
      const rest = used - estimated;
      if (rest > 0) {
        // Esquemas de herramientas, MCP y demás sistema que opencode no persiste.
        finalSlices.push({
          key: "unattributed",
          label: "Sin atribuir",
          tokens: rest,
          estimated: true,
        });
      }
    }

    return {
      ok: true,
      sessionId: session.id,
      title: session.title ? String(session.title) : "",
      agent: session.agent ? String(session.agent) : "",
      model,
      used,
      estimated: estimatedTotal || undefined,
      // Primero el catálogo vivo de la BD; models.json sólo como respaldo de BDs viejas.
      limit: catalogLimit(db, model) || contextLimit(model),
      slices: finalSlices.filter((s) => s.tokens > 0),
      scannedAt,
    };
  }

  /** Lo anterior a una compactación ya no viaja al modelo: sólo cuenta lo posterior. */
  private lastCompaction(
    db: Db,
    sessionId: string
  ): { seq: number; chars: number } | undefined {
    const rows = db
      .prepare(
        "SELECT seq, data FROM session_message WHERE session_id=? AND type='compaction' " +
          "ORDER BY seq DESC LIMIT 5"
      )
      .all(sessionId) as unknown as Array<{ seq: number; data: string }>;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        // Una compactación a medias todavía no ha recortado el historial.
        if (data.status && data.status !== "completed") {
          continue;
        }
        const summary = typeof data.summary === "string" ? data.summary : "";
        return { seq: num(row.seq), chars: summary.length };
      } catch {
        /* JSON en curso o corrupto: probar con la anterior */
      }
    }
    return undefined;
  }

  private usedTokens(db: Db, sessionId: string, afterSeq: number): number {
    const rows = db
      .prepare(
        "SELECT data FROM session_message WHERE session_id=? AND type='assistant' AND seq > ? " +
          "ORDER BY seq DESC LIMIT 20"
      )
      .all(sessionId, afterSeq) as unknown as Array<{ data: string }>;
    for (const row of rows) {
      try {
        const msg = JSON.parse(row.data) as Record<string, unknown>;
        const tokens = msg.tokens as Record<string, unknown> | undefined;
        if (!tokens) {
          continue;
        }
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        return num(tokens.input) + num(cache.read) + num(cache.write);
      } catch {
        /* mensaje en curso o corrupto: probar con el anterior */
      }
    }
    return 0;
  }

  private systemSlices(db: Db, sessionId: string): ContextSlice[] {
    const out: ContextSlice[] = [];
    let values: Record<string, unknown> = {};
    try {
      const row = db
        .prepare("SELECT current_values FROM instruction_state WHERE session_id=?")
        .get(sessionId) as { current_values?: string } | undefined;
      if (row && typeof row.current_values === "string") {
        values = JSON.parse(row.current_values) as Record<string, unknown>;
      }
    } catch {
      return out;
    }

    for (const key of Object.keys(values).sort((a, b) => orderOf(a) - orderOf(b))) {
      const hash = values[key];
      if (typeof hash !== "string") {
        continue;
      }
      const row = db
        .prepare("SELECT LENGTH(value) AS len FROM instruction_blob WHERE hash=?")
        .get(hash) as { len?: number } | undefined;
      const chars = num(row?.len);
      if (chars <= 0) {
        continue;
      }
      out.push({ key, label: LABELS[key] ?? key, tokens: Math.ceil(chars / 4), estimated: true });
    }
    return out;
  }

  private conversationTokens(
    db: Db,
    sessionId: string,
    afterSeq: number,
    extraChars: number = 0
  ): number {
    const rows = db
      .prepare(
        "SELECT type, data FROM session_message " +
          "WHERE session_id=? AND type IN ('user','assistant') AND seq > ?"
      )
      .all(sessionId, afterSeq) as unknown as Array<{ type: string; data: string }>;
    let chars = 0;
    for (const row of rows) {
      const data = typeof row.data === "string" ? row.data : "";
      chars += data.length;
      if (row.type !== "assistant") {
        continue;
      }
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (Array.isArray(msg.content)) {
          for (const rawPart of msg.content) {
            const part = rawPart as Record<string, unknown>;
            // El razonamiento no se reenvía al modelo en la siguiente petición.
            if (part.type === "reasoning" && typeof part.text === "string") {
              chars -= part.text.length;
            }
          }
        }
      } catch {
        /* ignorar */
      }
    }
    // El resumen de la compactación sí viaja al modelo, aunque no sea un mensaje user/assistant.
    const total = chars + extraChars;
    return total > 0 ? Math.ceil(total / 4) : 0;
  }
}
