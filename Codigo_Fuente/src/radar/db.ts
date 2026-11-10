/**
 * Esquema y consultas del Radar sobre MariaDB, siempre contra la base propia
 * `alfred_radar` (nombres calificados: la conexión puede tener otra base por defecto).
 * Las bases de opencode no se tocan. Sin `vscode`.
 */

import type { DbSession } from "../databases/driver";
import type { DbCell } from "../databases/types";
import { escapeLike, ident, qualified } from "../databases/quote";
import type { RadarFuente, RadarNoticia } from "./types";

/** Base exclusiva del radar. */
export const RADAR_DB = "alfred_radar";

const ITEMS = qualified(RADAR_DB, "items");
const FUENTES = qualified(RADAR_DB, "fuentes");

/** Retención por defecto: 3 días. */
export const RETENCION_DIAS = 3;

/** Fila de noticia tal como viaja al panel. */
export interface RadarFila {
  id: number;
  hash: string;
  fuenteId: string;
  fuente: string;
  titulo: string;
  enlace: string;
  resumen: string;
  autor: string;
  publicada: number;
  recogida: number;
  /** -1 = sin puntuar todavía. */
  score: number;
  tema: string;
  /** Titular traducido al español; vacío si no se pidió traducción. */
  tituloEs: string;
  /** Cuerpo traducido al español; vacío si no se pidió traducción. */
  resumenEs: string;
  leida: boolean;
  guardada: boolean;
}

/** Noticia pendiente de puntuar por el LLM. */
export interface RadarPendiente {
  hash: string;
  titulo: string;
  resumen: string;
  temaRegla: string;
}

/** Estado de descarga condicional de una fuente. */
export interface FuenteState {
  etag: string;
  lastModified: string;
  ultimoError: string;
  actualizada: number;
}

/** Columnas de `items` en el orden fijo de todos los SELECT de este módulo. */
const COLS_ITEMS =
  "id, hash, fuente_id, fuente_nombre, titulo, enlace, resumen, autor, publicada, recogida, score, tema, leida, guardada, titulo_es, resumen_es";

function num(cell: DbCell | undefined): number {
  if (cell === null || cell === undefined) {
    return 0;
  }
  if (typeof cell === "object") {
    return 0;
  }
  const n = Number(cell);
  return Number.isFinite(n) ? n : 0;
}

function str(cell: DbCell | undefined): string {
  if (cell === null || cell === undefined) {
    return "";
  }
  return typeof cell === "object" ? "" : String(cell);
}

function bool(cell: DbCell | undefined): boolean {
  return num(cell) !== 0;
}

function filaDe(row: DbCell[]): RadarFila {
  return {
    id: num(row[0]),
    hash: str(row[1]),
    fuenteId: str(row[2]),
    fuente: str(row[3]),
    titulo: str(row[4]),
    enlace: str(row[5]),
    resumen: str(row[6]),
    autor: str(row[7]),
    publicada: num(row[8]),
    recogida: num(row[9]),
    score: num(row[10]),
    tema: str(row[11]),
    leida: bool(row[12]),
    guardada: bool(row[13]),
    tituloEs: str(row[14]),
    resumenEs: str(row[15]),
  };
}

/** Crea la base y las tablas si faltan. Idempotente. */
export async function ensureSchema(s: DbSession): Promise<void> {
  await s.query(
    `CREATE DATABASE IF NOT EXISTS ${ident(RADAR_DB)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    [],
    { timeoutMs: 15000 }
  );
  await s.query(
    `CREATE TABLE IF NOT EXISTS ${FUENTES} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      nombre VARCHAR(200) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      activa TINYINT NOT NULL DEFAULT 1,
      etag VARCHAR(255) NULL,
      last_modified VARCHAR(255) NULL,
      ultimo_error VARCHAR(1000) NULL,
      actualizada BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    [],
    { timeoutMs: 15000 }
  );
  await s.query(
    `CREATE TABLE IF NOT EXISTS ${ITEMS} (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      hash CHAR(64) NOT NULL,
      fuente_id VARCHAR(64) NOT NULL,
      fuente_nombre VARCHAR(200) NOT NULL DEFAULT '',
      titulo VARCHAR(1000) NOT NULL,
      enlace VARCHAR(2000) NOT NULL,
      resumen TEXT NULL,
      autor VARCHAR(200) NULL,
      publicada BIGINT NOT NULL DEFAULT 0,
      recogida BIGINT NOT NULL DEFAULT 0,
      score INT NOT NULL DEFAULT -1,
      tema VARCHAR(64) NOT NULL DEFAULT '',
      tema_regla VARCHAR(64) NOT NULL DEFAULT '',
      descartada TINYINT NOT NULL DEFAULT 0,
      leida TINYINT NOT NULL DEFAULT 0,
      guardada TINYINT NOT NULL DEFAULT 0,
      titulo_es VARCHAR(1000) NULL,
      resumen_es TEXT NULL,
      UNIQUE KEY uq_items_hash (hash),
      FULLTEXT KEY ft_items_texto (titulo, resumen)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    [],
    { timeoutMs: 15000 }
  );
  // Bases creadas antes de la traducción: se añaden las columnas una sola vez, sin recrear
  // la tabla. Con ellas ya en su sitio, el `ALTER` no se repite en cada pasada (bloqueo de
  // metadatos). `titulo_es` y `resumen_es` se añaden juntas, así que basta mirar una.
  const existe = await s.query(
    `SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'titulo_es'`,
    [RADAR_DB],
    { timeoutMs: 10000 }
  );
  if (num(existe.rows[0]?.[0]) === 0) {
    await s.query(
      `ALTER TABLE ${ITEMS}
         ADD COLUMN IF NOT EXISTS titulo_es VARCHAR(1000) NULL,
         ADD COLUMN IF NOT EXISTS resumen_es TEXT NULL`,
      [],
      { timeoutMs: 15000 }
    );
  }
}

/** Refleja la configuración de fuentes en la tabla, sin pisar etag ni errores. */
export async function syncFuentes(s: DbSession, fuentes: RadarFuente[]): Promise<void> {
  for (const f of fuentes) {
    await s.query(
      `INSERT INTO ${FUENTES} (id, nombre, url, activa) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), url = VALUES(url), activa = VALUES(activa)`,
      [f.id, f.nombre, f.url, f.activa ? 1 : 0],
      { timeoutMs: 10000 }
    );
  }
}

/** Estado de descarga condicional de todas las fuentes, por id. */
export async function listFuenteStates(s: DbSession): Promise<Map<string, FuenteState>> {
  const res = await s.query(
    `SELECT id, etag, last_modified, ultimo_error, actualizada FROM ${FUENTES}`,
    [],
    { timeoutMs: 10000 }
  );
  const map = new Map<string, FuenteState>();
  for (const row of res.rows) {
    map.set(str(row[0]), {
      etag: str(row[1]),
      lastModified: str(row[2]),
      ultimoError: str(row[3]),
      actualizada: num(row[4]),
    });
  }
  return map;
}

/** Anota el resultado de la descarga de una fuente (etag/last-modified o error). */
export async function saveFuenteState(
  s: DbSession,
  id: string,
  state: { etag?: string; lastModified?: string; error?: string }
): Promise<void> {
  await s.query(
    `UPDATE ${FUENTES} SET
       etag = COALESCE(?, etag),
       last_modified = COALESCE(?, last_modified),
       ultimo_error = ?,
       actualizada = ?
     WHERE id = ?`,
    [state.etag ?? null, state.lastModified ?? null, state.error ?? null, Date.now(), id],
    { timeoutMs: 10000 }
  );
}

/**
 * Inserta noticias nuevas (INSERT IGNORE sobre el hash único) y devuelve cuántas
 * entraron de verdad. Idempotente: dos pasadas seguidas no duplican.
 */
export async function insertItems(s: DbSession, noticias: RadarNoticia[]): Promise<number> {
  let insertadas = 0;
  const LOTE = 50;
  for (let i = 0; i < noticias.length; i += LOTE) {
    const lote = noticias.slice(i, i + LOTE);
    const valores = lote.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params: unknown[] = [];
    for (const n of lote) {
      params.push(
        n.hash,
        n.fuenteId,
        n.fuenteNombre,
        n.titulo,
        n.enlace,
        n.resumen,
        n.autor,
        n.publicada,
        n.recogida,
        n.temaRegla,
        n.descartada ? 1 : 0,
        n.temaRegla
      );
    }
    const res = await s.query(
      `INSERT IGNORE INTO ${ITEMS}
         (hash, fuente_id, fuente_nombre, titulo, enlace, resumen, autor, publicada, recogida, tema_regla, descartada, tema)
       VALUES ${valores}`,
      params,
      { timeoutMs: 20000 }
    );
    insertadas += res.affected;
  }
  return insertadas;
}

/** Noticias sin puntuar que pasaron las reglas, por antigüedad. Tope para acotar el coste del LLM.
 *  Solo la ventana de retención: lo que la purga borraría no se manda a puntuar. */
export async function listPending(
  s: DbSession,
  limit: number,
  dias: number = RETENCION_DIAS
): Promise<RadarPendiente[]> {
  const corte = Date.now() - dias * 24 * 60 * 60 * 1000;
  const res = await s.query(
    `SELECT hash, titulo, resumen, tema_regla FROM ${ITEMS}
     WHERE score = -1 AND descartada = 0 AND recogida >= ?
     ORDER BY recogida ASC, id ASC
     LIMIT ?`,
    [corte, limit],
    { timeoutMs: 15000 }
  );
  return res.rows.map((row) => ({
    hash: str(row[0]),
    titulo: str(row[1]),
    resumen: str(row[2]),
    temaRegla: str(row[3]),
  }));
}

/** Guarda la puntuación del LLM: nota 0-100, tema, resumen de una línea y traducciones.
 *  Las traducciones solo se pisan cuando llegan con texto: apagar la casilla y repuntuar
 *  conserva lo ya traducido. */
export async function setScore(
  s: DbSession,
  hash: string,
  score: number,
  tema: string,
  resumen: string,
  tituloEs: string,
  resumenEs: string
): Promise<void> {
  await s.query(
    `UPDATE ${ITEMS} SET
       score = ?,
       tema = ?,
       resumen = CASE WHEN ? = '' THEN resumen ELSE ? END,
       titulo_es = COALESCE(NULLIF(?, ''), titulo_es),
       resumen_es = COALESCE(NULLIF(?, ''), resumen_es)
     WHERE hash = ?`,
    [score, tema, resumen, resumen, tituloEs, resumenEs, hash],
    { timeoutMs: 10000 }
  );
}

/** Borra lo viejo (recogido o publicado antes del corte) que no está guardado. Devuelve cuántas filas cayeron. */
export async function purgar(s: DbSession, dias: number = RETENCION_DIAS): Promise<number> {
  const corte = Date.now() - dias * 24 * 60 * 60 * 1000;
  const res = await s.query(
    `DELETE FROM ${ITEMS} WHERE (recogida < ? OR (publicada > 0 AND publicada < ?)) AND guardada = 0`,
    [corte, corte],
    { timeoutMs: 20000 }
  );
  return res.affected;
}

/** Total de noticias vivas (sin descartar). */
export async function countItems(s: DbSession): Promise<number> {
  const res = await s.query(`SELECT COUNT(*) FROM ${ITEMS} WHERE descartada = 0`, [], {
    timeoutMs: 10000,
  });
  return num(res.rows[0]?.[0]);
}

/** Las mejores para `ultimas.md`: por encima del umbral, nota descendente. */
export async function topItems(s: DbSession, umbral: number, limit: number): Promise<RadarFila[]> {
  const res = await s.query(
    `SELECT ${COLS_ITEMS} FROM ${ITEMS}
     WHERE descartada = 0 AND score >= ?
     ORDER BY score DESC, publicada DESC, id DESC
     LIMIT ?`,
    [umbral, limit],
    { timeoutMs: 15000 }
  );
  return res.rows.map(filaDe);
}

/** Filtros de la lista del panel. */
export interface ListItemsOpts {
  /** Búsqueda por título, resumen y sus traducciones (LIKE, sin FULLTEXT: el volumen de
   *  3 días es pequeño). */
  busqueda?: string;
  /** Id o nombre de tema; vacío = todos. */
  tema?: string;
  offset?: number;
  limit?: number;
}

/** Página de noticias para el panel: el webview nunca consulta la base por su cuenta. */
export async function listItems(
  s: DbSession,
  opts: ListItemsOpts
): Promise<{ filas: RadarFila[]; total: number }> {
  const where: string[] = ["descartada = 0"];
  const params: unknown[] = [];
  if (opts.tema) {
    where.push("tema = ?");
    params.push(opts.tema);
  }
  if (opts.busqueda && opts.busqueda.trim()) {
    const termino = `%${escapeLike(opts.busqueda.trim())}%`;
    // También las traducciones: buscar en español debe encontrar lo que solo vive en `titulo_es`.
    where.push(
      "(titulo LIKE ? ESCAPE '\\\\' OR resumen LIKE ? ESCAPE '\\\\'" +
        " OR titulo_es LIKE ? ESCAPE '\\\\' OR resumen_es LIKE ? ESCAPE '\\\\')"
    );
    params.push(termino, termino, termino, termino);
  }
  const whereSql = ` WHERE ${where.join(" AND ")}`;
  const limit = Math.min(500, Math.max(1, Math.round(opts.limit ?? 100)));
  const offset = Math.max(0, Math.round(opts.offset ?? 0));

  const countRes = await s.query(`SELECT COUNT(*) FROM ${ITEMS}${whereSql}`, params, {
    timeoutMs: 15000,
  });
  const res = await s.query(
    `SELECT ${COLS_ITEMS} FROM ${ITEMS}${whereSql}
     ORDER BY score DESC, recogida DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
    { timeoutMs: 15000 }
  );
  return { filas: res.rows.map(filaDe), total: num(countRes.rows[0]?.[0]) };
}

/** Campos de bandera que el panel puede alternar: lista blanca, nunca un nombre libre. */
export type CampoFlag = "leida" | "guardada";

/** Alterna leída/guardada por id. */
export async function setFlag(s: DbSession, id: number, campo: CampoFlag, valor: boolean): Promise<void> {
  const columna = campo === "leida" ? "leida" : "guardada";
  await s.query(`UPDATE ${ITEMS} SET ${ident(columna)} = ? WHERE id = ?`, [valor ? 1 : 0, id], {
    timeoutMs: 10000,
  });
}

/** Deja sin puntuar lo de los últimos días para que la siguiente pasada lo repuntúe. */
export async function repuntuarItems(s: DbSession, dias: number = RETENCION_DIAS): Promise<number> {
  const corte = Date.now() - dias * 24 * 60 * 60 * 1000;
  const res = await s.query(
    `UPDATE ${ITEMS} SET score = -1, tema = '' WHERE descartada = 0 AND recogida >= ?`,
    [corte],
    { timeoutMs: 20000 }
  );
  return res.affected;
}
