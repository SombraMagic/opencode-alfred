/**
 * Servicio del Radar de noticias: estado, una sola pasada a la vez, conexión con el
 * perfil MariaDB del panel de bases de datos (contraseña desde `context.secrets`, nunca
 * a un fichero ni al webview), filtro por reglas + LLM, purga de 3 días y escritura
 * atómica de `.alfred/radar/ultimas.md` para los agentes.
 */

import * as vscode from "vscode";
import { join } from "node:path";
import { DbSession } from "../databases/driver";
import { SshTunnel, type HostKeyStore } from "../databases/ssh";
import type { DbProfile } from "../databases/types";
import { writeAtomic } from "../pizarra/files";
import { readSettings } from "../ollama/service";
import { setActivity } from "../panels/activity";
import {
  countItems,
  ensureSchema,
  insertItems,
  listFuenteStates,
  listItems,
  listPending,
  purgar,
  repuntuarItems,
  saveFuenteState,
  setFlag,
  setScore,
  syncFuentes,
  topItems,
  RETENCION_DIAS,
  type CampoFlag,
  type ListItemsOpts,
  type RadarFila,
} from "./db";
import { CONCURRENCIA, leerFuente, mapConcurrente } from "./ingest";
import { MAX_PUNTUAR_PASADA, nombreProveedor, puntuarLote, TAM_LOTE } from "./llm";
import {
  estadoVacio,
  sanearConfig,
  type RadarConfig,
  type RadarEstado,
  type RadarNoticia,
} from "./types";

/** Clave de la configuración en `globalState`. */
export const KEY_CONFIG = "opencodeAgents.radar.config";
/** Clave de la última pasada completada (epoch ms) en `globalState`. */
export const KEY_ULTIMA = "opencodeAgents.radar.lastRun";
/** Secreto con la clave del proveedor LLM. Nunca sale del llavero. */
export const KEY_CLAVE = "opencodeAgents.radar.llmKey";
/** Perfiles y huellas SSH del panel de bases de datos: se comparten, no se duplican. */
const KEY_PERFILES_DB = "opencodeAgents.dbProfiles";
const KEY_HOST_KEYS = "opencodeAgents.sshHostKeys";

/** Número de noticias que entran en `ultimas.md`. */
export const TOP_ULTIMAS = 30;

/** Vida de la conexión que reutiliza el panel entre llamadas. */
const TTL_SESION_MS = 5 * 60 * 1000;

/** Fallo de conexión o de perfil: el radar pasa a `sinBase` sin reintentos en bucle. */
export class RadarSinBase extends Error {}

/** Perfil visto por el panel de configuración: sin secretos, solo si los hay. */
export interface RadarPerfilView {
  id: string;
  name: string;
  hasPassword: boolean;
}

/** Sesión abierta contra MariaDB, con su túnel si el perfil lo pide. */
interface Conexion {
  session: DbSession;
  tunnel?: SshTunnel;
}

export class RadarService {
  private estado: RadarEstado = estadoVacio();
  private trabajando = false;
  private readonly oyentes: ((estado: RadarEstado) => void)[] = [];
  /** Conexión reutilizada por el panel: abrir una por clic costaba una conexión por llamada. */
  private sesion?: { con: Conexion; ultimoUso: number };
  /** `ensureSchema` ya corrió en la sesión cacheada: no se repite en cada lectura. */
  private esquemaListo = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ── Estado ────────────────────────────────────────────────────────────────

  estadoActual(): RadarEstado {
    return this.estado;
  }

  /** Epoch ms de la última pasada completada; undefined si no hubo ninguna. */
  ultimaPasada(): number | undefined {
    const valor = this.context.globalState.get<number>(KEY_ULTIMA);
    return typeof valor === "number" && valor > 0 ? valor : undefined;
  }

  /** Suscripción a los cambios de estado: la usa el panel para repintar sin sondeo. */
  onChange(fn: (estado: RadarEstado) => void): vscode.Disposable {
    this.oyentes.push(fn);
    return new vscode.Disposable(() => {
      const i = this.oyentes.indexOf(fn);
      if (i >= 0) {
        this.oyentes.splice(i, 1);
      }
    });
  }

  private notificar(): void {
    // La tarjeta del radar en el panel de voz sigue el paso en curso; en cualquier
    // otra fase se apaga. El nombre no cambia: la tarjeta se conserva, no se recrea.
    if (this.estado.fase === "working") {
      setActivity("radar", true, "RADAR", "radar", this.estado.trabajando || "Trabajando…");
    } else {
      setActivity("radar", false, "RADAR", "radar");
    }
    const copia = { ...this.estado, contadores: { ...this.estado.contadores }, fallos: [...this.estado.fallos] };
    for (const fn of this.oyentes) {
      try {
        fn(copia);
      } catch {
        // Un oyente roto no puede tumbar la pasada.
      }
    }
  }

  private setEstado(cambio: Partial<RadarEstado>): void {
    this.estado = { ...this.estado, ...cambio };
    this.notificar();
  }

  // ── Configuración ─────────────────────────────────────────────────────────

  config(): RadarConfig {
    return sanearConfig(this.context.globalState.get(KEY_CONFIG));
  }

  async saveConfig(parcial: Partial<RadarConfig>): Promise<void> {
    const actual = this.config();
    await this.context.globalState.update(KEY_CONFIG, sanearConfig({ ...actual, ...parcial }));
  }

  async setClave(clave: string): Promise<void> {
    await this.context.secrets.store(KEY_CLAVE, clave);
  }

  async borrarClave(): Promise<void> {
    await this.context.secrets.delete(KEY_CLAVE);
  }

  async hasClave(): Promise<boolean> {
    return Boolean(await this.context.secrets.get(KEY_CLAVE));
  }

  /** Perfiles MariaDB del panel de bases de datos, para el selector de CONFIGURACIÓN. */
  async perfiles(): Promise<RadarPerfilView[]> {
    const perfiles = this.context.globalState.get<DbProfile[]>(KEY_PERFILES_DB, []);
    const out: RadarPerfilView[] = [];
    for (const p of perfiles) {
      if (!p || typeof p.id !== "string") {
        continue;
      }
      out.push({
        id: p.id,
        name: typeof p.name === "string" ? p.name : p.id,
        hasPassword: Boolean(await this.context.secrets.get(`opencodeAgents.db.pw.${p.id}`)),
      });
    }
    return out;
  }

  /** Ruta de `ultimas.md`: en el proyecto si hay carpeta, si no en el almacén global. */
  ultimasPath(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root
      ? join(root, ".alfred", "radar", "ultimas.md")
      : join(this.context.globalStorageUri.fsPath, "radar", "ultimas.md");
  }

  // ── Conexión ──────────────────────────────────────────────────────────────

  private hostKeyStore(): HostKeyStore {
    const state = this.context.globalState;
    return {
      get: (server) => state.get<Record<string, string>>(KEY_HOST_KEYS, {})[server],
      remember: (server, fingerprint) => {
        const map = { ...state.get<Record<string, string>>(KEY_HOST_KEYS, {}) };
        map[server] = fingerprint;
        void state.update(KEY_HOST_KEYS, map);
      },
    };
  }

  /**
   * Abre sesión contra MariaDB con el perfil configurado (o el primero guardado).
   * Lanza `RadarSinBase` con un mensaje legible si no hay perfil o no conecta.
   */
  private async conectar(): Promise<Conexion> {
    const cfg = this.config();
    const perfiles = this.context.globalState.get<DbProfile[]>(KEY_PERFILES_DB, []);
    const perfil = cfg.profileId
      ? perfiles.find((p) => p?.id === cfg.profileId)
      : perfiles.find((p) => p && typeof p.id === "string");
    if (!perfil) {
      throw new RadarSinBase(
        cfg.profileId
          ? "El perfil de MariaDB elegido ya no existe: crea uno en el panel de Bases de datos."
          : "No hay ningún perfil de MariaDB: crea uno en el panel de Bases de datos y selecciónalo en CONFIGURACIÓN."
      );
    }
    const pw = (await this.context.secrets.get(`opencodeAgents.db.pw.${perfil.id}`)) ?? undefined;

    let tunnel: SshTunnel | undefined;
    if (perfil.tunnel?.enabled) {
      const sshPw = (await this.context.secrets.get(`opencodeAgents.db.sshPw.${perfil.id}`)) ?? undefined;
      const sshPass = (await this.context.secrets.get(`opencodeAgents.db.sshPass.${perfil.id}`)) ?? undefined;
      try {
        tunnel = await SshTunnel.open(perfil, { password: sshPw, passphrase: sshPass }, this.hostKeyStore());
      } catch (err) {
        throw new RadarSinBase(`Error al abrir el túnel SSH: ${mensajeDe(err)}`);
      }
    }

    try {
      const session = await DbSession.open(perfil, pw, tunnel);
      return { session, tunnel };
    } catch (err) {
      if (tunnel) {
        await tunnel.close().catch(() => undefined);
      }
      let msg = mensajeDe(err);
      if (msg.includes("auth_gssapi_client")) {
        msg +=
          " Consejo: MariaDB intentó autenticación GSSAPI, no soportada por el cliente. Usa una cuenta con mysql_native_password o ed25519.";
      } else if (!pw) {
        msg += " El perfil no tiene contraseña guardada; si el servidor la exige, guárdala en el panel de Bases de datos.";
      }
      throw new RadarSinBase(`No hay conexión con MariaDB («${perfil.name}»): ${msg}`);
    }
  }

  private async cerrar(con: Conexion): Promise<void> {
    await con.session.close().catch(() => undefined);
    if (con.tunnel) {
      await con.tunnel.close().catch(() => undefined);
    }
  }

  /**
   * Sesión propia del panel: se reutiliza mientras se use dentro del TTL. Pasado el
   * TTL se cierra y se abre otra. `sync()` y `repuntuar()` no pasan por aquí.
   */
  private async sesionDelPanel(): Promise<Conexion> {
    const ahora = Date.now();
    if (this.sesion) {
      if (ahora - this.sesion.ultimoUso < TTL_SESION_MS) {
        this.sesion.ultimoUso = ahora;
        return this.sesion.con;
      }
      await this.cerrarSesion();
    }
    const con = await this.conectar();
    this.sesion = { con, ultimoUso: Date.now() };
    return con;
  }

  /** Cierra la conexión cacheada del panel: `onDidDispose` y al guardar configuración. */
  async cerrarSesion(): Promise<void> {
    const cache = this.sesion;
    this.sesion = undefined;
    this.esquemaListo = false;
    if (cache) {
      await this.cerrar(cache.con);
    }
  }

  /** Cierre al desactivar la extensión: no dejar la conexión del panel abierta. */
  async dispose(): Promise<void> {
    await this.cerrarSesion();
  }

  // ── Pasada completa ───────────────────────────────────────────────────────

  /**
   * Una pasada: descargar feeds, guardar, filtrar, puntuar, purgar y escribir
   * `ultimas.md`. Una sola a la vez; sin base, estado `sinBase` y nada escrito.
   */
  async sync(manual: boolean): Promise<void> {
    if (this.trabajando) {
      this.setEstado({ mensaje: "Ya hay una pasada del radar en marcha." });
      return;
    }
    this.trabajando = true;
    const estado: RadarEstado = {
      ...estadoVacio(),
      fase: "working",
      trabajando: "Conectando con MariaDB…",
      ultimaPasada: this.ultimaPasada(),
    };
    this.estado = estado;
    this.notificar();

    let con: Conexion | undefined;
    try {
      const cfg = this.config();
      try {
        con = await this.conectar();
      } catch (err) {
        if (err instanceof RadarSinBase) {
          this.estado = { ...estado, fase: "sinBase", trabajando: undefined, mensaje: err.message };
          this.notificar();
          return;
        }
        throw err;
      }
      const { session } = con;

      estado.trabajando = "Preparando la base…";
      this.notificar();
      await ensureSchema(session);
      await syncFuentes(session, cfg.fuentes);
      const states = await listFuenteStates(session);

      estado.trabajando = "Descargando feeds…";
      this.notificar();
      const activas = cfg.fuentes.filter((f) => f.activa);
      const ahora = Date.now();
      const resultados = await mapConcurrente(activas, CONCURRENCIA, async (fuente) => {
        try {
          const previo = states.get(fuente.id);
          const r = await leerFuente(fuente, { etag: previo?.etag, lastModified: previo?.lastModified }, cfg.temas, ahora);
          if (r.descarga.tipo === "nuevo") {
            await saveFuenteState(session, fuente.id, {
              etag: r.descarga.etag,
              lastModified: r.descarga.lastModified,
              error: undefined,
            });
          } else {
            // Un 304 también limpia el error de una pasada anterior: la fuente está sana.
            await saveFuenteState(session, fuente.id, { error: undefined });
          }
          return { fuente, noticias: r.noticias, error: undefined as string | undefined };
        } catch (err) {
          const msg = mensajeDe(err);
          // Un feed roto no tumba la pasada: se anota y se sigue con los demás.
          await saveFuenteState(session, fuente.id, { error: msg }).catch(() => undefined);
          return { fuente, noticias: [] as RadarNoticia[], error: msg };
        }
      });

      const noticias: RadarNoticia[] = [];
      for (const r of resultados) {
        if (r.error) {
          estado.fallos.push({ fuente: r.fuente.nombre, error: r.error });
        }
        estado.contadores.descargadas += r.noticias.length;
        noticias.push(...r.noticias);
      }
      estado.contadores.descartadas = noticias.filter((n) => n.descartada).length;

      if (noticias.length > 0) {
        estado.trabajando = "Guardando noticias…";
        this.notificar();
        estado.contadores.nuevas = await insertItems(session, noticias);
      }

      await this.puntuarPendientes(session, cfg, estado);

      estado.trabajando = "Purgando…";
      this.notificar();
      estado.contadores.purgadas = await purgar(session, RETENCION_DIAS);

      estado.trabajando = "Escribiendo ultimas.md…";
      this.notificar();
      const top = await topItems(session, cfg.umbral, TOP_ULTIMAS);
      await writeAtomic(this.ultimasPath(), Buffer.from(contenidoUltimas(top, cfg.umbral), "utf8"));
      estado.total = await countItems(session);

      const pasada = Date.now();
      await this.context.globalState.update(KEY_ULTIMA, pasada);
      this.estado = {
        ...estado,
        fase: "idle",
        trabajando: undefined,
        ultimaPasada: pasada,
        mensaje: this.resumenPasada(estado, manual),
      };
      this.notificar();
    } catch (err) {
      this.estado = {
        ...estado,
        fase: "error",
        trabajando: undefined,
        mensaje: mensajeDe(err),
      };
      this.notificar();
    } finally {
      this.trabajando = false;
      if (con) {
        await this.cerrar(con);
      }
    }
  }

  /** Texto de aviso tras una pasada completada. */
  private resumenPasada(estado: RadarEstado, manual: boolean): string | undefined {
    const c = estado.contadores;
    const partes = [`${c.nuevas} nueva(s)`, `${c.puntuadas} puntuada(s)`, `${c.purgadas} purgada(s)`];
    const base = manual ? `Radar actualizado: ${partes.join(", ")}.` : `Pasada del radar: ${partes.join(", ")}.`;
    if (estado.fallos.length > 0) {
      return `${base} Fallos: ${estado.fallos.map((f) => `${f.fuente} (${f.error})`).join("; ")}`;
    }
    return base;
  }

  /** Puntúa con el LLM lo que pasó las reglas y aún no tiene nota, en lotes de 20. */
  private async puntuarPendientes(
    session: DbSession,
    cfg: RadarConfig,
    estado: RadarEstado
  ): Promise<void> {
    const pendientes = await listPending(session, MAX_PUNTUAR_PASADA);
    if (pendientes.length === 0) {
      return;
    }
    let clave: string | undefined;
    if (cfg.proveedor !== "ollama") {
      clave = await this.context.secrets.get(KEY_CLAVE);
      if (!clave) {
        estado.fallos.push({
          fuente: `Filtro LLM (${nombreProveedor(cfg.proveedor)})`,
          error: `falta la clave en el llavero; ${pendientes.length} noticia(s) se quedan sin puntuar.`,
        });
        return;
      }
    }
    // Al modelo hay que darle también los temas fijos de las fuentes: si «Juegos» o
    // «Humor» no están en la lista, no puede devolverlos y la noticia pierde su tema.
    const temas = [
      ...new Set([
        ...cfg.temas.map((t) => t.nombre),
        ...cfg.fuentes.map((f) => f.temaFijo ?? ""),
      ]),
    ].filter((t) => t.length > 0);
    const ollamaBase = readSettings(this.context).baseURL;
    for (let i = 0; i < pendientes.length; i += TAM_LOTE) {
      const lote = pendientes.slice(i, i + TAM_LOTE);
      estado.trabajando = `Puntuando con el LLM ${i + lote.length}/${pendientes.length}…`;
      this.notificar();
      try {
        const scores = await puntuarLote(
          {
            proveedor: cfg.proveedor,
            modelo: cfg.modelo,
            clave,
            ollamaBase,
            temas,
            traducir: cfg.traducir,
          },
          lote.map((p, j) => ({ n: j + 1, titulo: p.titulo, resumen: p.resumen }))
        );
        for (const sc of scores) {
          const pend = lote[sc.n - 1];
          if (!pend) {
            continue;
          }
          await setScore(
            session,
            pend.hash,
            sc.puntuacion,
            sc.tema || pend.temaRegla,
            sc.resumen,
            sc.tituloEs,
            sc.resumenEs
          );
          estado.contadores.puntuadas++;
        }
      } catch (err) {
        // El proveedor falló: se anota y no se le sigue llamando en esta pasada.
        estado.fallos.push({
          fuente: `Filtro LLM (${nombreProveedor(cfg.proveedor)})`,
          error: mensajeDe(err),
        });
        return;
      }
    }
  }

  // ── Operaciones del panel ─────────────────────────────────────────────────

  /** Repuntúa con el LLM las noticias de los últimos 3 días y reescribe `ultimas.md`. */
  async repuntuar(): Promise<void> {
    if (this.trabajando) {
      this.setEstado({ mensaje: "Ya hay una pasada del radar en marcha." });
      return;
    }
    this.trabajando = true;
    const estado: RadarEstado = {
      ...this.estado,
      fase: "working",
      trabajando: "Repuntuando…",
      contadores: { descargadas: 0, nuevas: 0, descartadas: 0, puntuadas: 0, purgadas: 0 },
      fallos: [],
    };
    this.estado = estado;
    this.notificar();
    let con: Conexion | undefined;
    try {
      const cfg = this.config();
      try {
        con = await this.conectar();
      } catch (err) {
        if (err instanceof RadarSinBase) {
          this.estado = { ...estado, fase: "sinBase", trabajando: undefined, mensaje: err.message };
          this.notificar();
          return;
        }
        throw err;
      }
      const { session } = con;
      await ensureSchema(session);
      await repuntuarItems(session, RETENCION_DIAS);
      await this.puntuarPendientes(session, cfg, estado);
      const top = await topItems(session, cfg.umbral, TOP_ULTIMAS);
      await writeAtomic(this.ultimasPath(), Buffer.from(contenidoUltimas(top, cfg.umbral), "utf8"));
      estado.total = await countItems(session);
      this.estado = {
        ...estado,
        fase: "idle",
        trabajando: undefined,
        mensaje: `Repuntuadas ${estado.contadores.puntuadas} noticia(s).`,
      };
      this.notificar();
    } catch (err) {
      this.estado = { ...estado, fase: "error", trabajando: undefined, mensaje: mensajeDe(err) };
      this.notificar();
    } finally {
      this.trabajando = false;
      if (con) {
        await this.cerrar(con);
      }
    }
  }

  /** Página de noticias para el panel y el último error de cada fuente. Lanza `RadarSinBase` sin conexión. */
  async listar(
    opts: ListItemsOpts
  ): Promise<{ filas: RadarFila[]; total: number; estados: Map<string, string> }> {
    try {
      const con = await this.sesionDelPanel();
      if (!this.esquemaListo) {
        await ensureSchema(con.session);
        this.esquemaListo = true;
      }
      // `listItems` ya cuenta la consulta: el total sale de ahí, sin un COUNT aparte.
      const res = await listItems(con.session, opts);
      // `ultimoError` existe en la tabla desde la primera pasada; el panel lo pinta.
      const estados = new Map<string, string>();
      for (const [id, state] of await listFuenteStates(con.session)) {
        if (state.ultimoError) {
          estados.set(id, state.ultimoError);
        }
      }
      if (res.total !== this.estado.total) {
        this.setEstado({ total: res.total });
      }
      return { ...res, estados };
    } catch (err) {
      if (err instanceof RadarSinBase) {
        throw err;
      }
      if (esFalloConexion(err)) {
        await this.cerrarSesion();
        throw new RadarSinBase(`No hay conexión con MariaDB: ${mensajeDe(err)}`);
      }
      throw err;
    }
  }

  /** Alterna leída/guardada. Lanza `RadarSinBase` si se pierde la conexión. */
  async marcar(id: number, campo: CampoFlag, valor: boolean): Promise<void> {
    const con = await this.sesionDelPanel();
    try {
      await setFlag(con.session, id, campo, valor);
    } catch (err) {
      if (err instanceof RadarSinBase) {
        throw err;
      }
      if (esFalloConexion(err)) {
        await this.cerrarSesion();
        throw new RadarSinBase(`No hay conexión con MariaDB: ${mensajeDe(err)}`);
      }
      throw err;
    }
  }
}

/** Errores del driver que significan «el servidor no está»: el panel dice «sin conexión». */
function esFalloConexion(err: unknown): boolean {
  if (err instanceof RadarSinBase) {
    return true;
  }
  const msg = mensajeDe(err);
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("PROTOCOL_CONNECTION_LOST") ||
    msg.includes("ECONNRESET") ||
    msg.includes("Tiempo de espera agotado") ||
    msg.includes("cerrada")
  );
}

function mensajeDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Contenido de `ultimas.md`: una línea por noticia, `puntuación · fuente · titular · enlace`.
 *  Con traducción guardada se escribe el titular en español; el original sigue en la base. */
export function contenidoUltimas(filas: RadarFila[], umbral: number): string {
  const lineas = [
    "# Radar — últimas noticias",
    "",
    `Generado: ${new Date().toISOString()} · umbral ${umbral} · ${filas.length} noticia(s).`,
    "",
  ];
  if (filas.length === 0) {
    lineas.push("Sin noticias por encima del umbral en los últimos 3 días.");
  }
  for (const f of filas) {
    const titular = f.tituloEs || f.titulo;
    lineas.push(`${f.score} · ${f.fuente} · ${titular} · ${f.enlace}`);
  }
  lineas.push("");
  return lineas.join("\n");
}
