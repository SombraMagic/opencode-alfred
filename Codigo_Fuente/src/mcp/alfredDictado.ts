/**
 * Herramientas del dictado de `mcp_alfred`: leer y configurar la botonera de comandos del
 * panel de dictado. Sin `vscode`: comparten el fichero `dictado-comandos.json` con la extensión.
 */
import { escribirComandos, leerComandos, MAX_BOTONES } from "../dictado/comandos";

export const DICTADO_TOOLS = [
  {
    name: "dictado_comandos_leer",
    description:
      "Devuelve los botones de comando que hay ahora en el panel de dictado (JSON con `botones` y `activo`, el índice del encendido o null).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dictado_comandos_escribir",
    description:
      "Sustituye los botones de comando del panel de dictado. Cada botón es el texto exacto del comando tal como se escribe en el prompt (p. ej. `/review`); el botón encendido se antepone al prompt al enviarlo. Máximo 10; deja todos apagados.",
    inputSchema: {
      type: "object",
      properties: {
        botones: { type: "array", items: { type: "string" }, maxItems: MAX_BOTONES },
      },
      required: ["botones"],
    },
  },
];

/** Ejecuta una herramienta del dictado; `undefined` si el nombre no es suyo. */
export async function callDictadoTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | undefined> {
  if (name === "dictado_comandos_leer") return JSON.stringify(leerComandos());
  if (name === "dictado_comandos_escribir") {
    if (!Array.isArray(input.botones)) throw new Error("`botones` debe ser una lista de textos.");
    if (input.botones.length > MAX_BOTONES) throw new Error(`Máximo ${MAX_BOTONES} botones.`);
    return JSON.stringify(await escribirComandos({ botones: input.botones as string[], activo: null }));
  }
  return undefined;
}
