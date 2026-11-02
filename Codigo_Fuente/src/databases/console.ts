/**
 * Consola SQL para MariaDB: divide el guion en sentencias, las ejecuta en orden y se
 * detiene en el primer error, devolviendo lo conseguido hasta ese momento. Los avisos
 * del servidor (`SHOW WARNINGS`) solo enriquecen el mensaje de error: la forma del
 * resultado no cambia. Sin `vscode`.
 */

import type { DbSession } from "./driver";
import { isReadOnlyStatement, splitStatements } from "./quote";
import type { DbQueryResult } from "./types";

/** Sentencia suelta del guion, con su marca de solo lectura. */
export interface ConsoleStatement {
  text: string;
  readOnly: boolean;
}

/** Resultado de una sentencia ejecutada. */
export interface ConsoleStatementResult {
  statement: string;
  result: DbQueryResult;
}

/** Lo que devuelve la consola: los éxitos previos y, si algo falló, el error con su índice. */
export interface ConsoleRun {
  results: ConsoleStatementResult[];
  error?: { index: number; message: string };
}

/** Divide el guion y marca cada sentencia como de solo lectura o no. */
export function statementsOf(sql: string): ConsoleStatement[] {
  return splitStatements(sql).map((text) => ({ text, readOnly: isReadOnlyStatement(text) }));
}

/**
 * Avisos pendientes en la conexión. Tras una sentencia fallida el servidor los deja
 * escritos (p. ej. el truncado que provocó el rechazo), así que se leen aquí y no en
 * otro sitio. Si la lectura misma falla (conexión en cancelación), se ignora.
 */
async function warningsOf(s: DbSession): Promise<string> {
  try {
    const res = await s.query("SHOW WARNINGS", [], { rowLimit: 100 });
    return res.rows
      .map((row) => {
        const mensaje = typeof row[2] === "string" ? row[2] : "";
        const nivel = typeof row[0] === "string" ? row[0] : "";
        return `${nivel} ${mensaje}`.trim();
      })
      .filter((linea) => linea.length > 0)
      .join("; ");
  } catch {
    return "";
  }
}

/**
 * Ejecuta el guion sentencia a sentencia. Sin sentencias no lanza nada contra el
 * servidor. Al primer error se detiene y devuelve los resultados previos con el índice
 * y el mensaje (los avisos del servidor van pegados al mensaje).
 */
export async function runConsole(
  s: DbSession,
  sql: string,
  opts?: { timeoutMs?: number; rowLimit?: number }
): Promise<ConsoleRun> {
  const sentencias = statementsOf(sql);
  const run: ConsoleRun = { results: [] };
  for (let i = 0; i < sentencias.length; i++) {
    const st = sentencias[i];
    try {
      const result = await s.query(st.text, [], opts);
      run.results.push({ statement: st.text, result });
    } catch (e) {
      const base = e instanceof Error ? e.message : String(e);
      const avisos = await warningsOf(s);
      run.error = { index: i, message: avisos ? `${base}. Avisos: ${avisos}` : base };
      return run;
    }
  }
  return run;
}
