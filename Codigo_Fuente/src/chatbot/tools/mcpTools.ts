/**
 * Adaptador de las herramientas de `mcp_alfred` (voz, pizarra) al chatbot.
 * Sin `vscode`. Los argumentos van crudos (`rawArgs`): cada módulo MCP valida los suyos.
 */
import type { ToolContext, ToolSpec } from "../types";

/** Tope del texto que vuelve al modelo y a la tarjeta (`pizarra_leer` puede dar JSON enorme). */
export const MAX_RESULT_CHARS = 8000;

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** `undefined` = el módulo no conoce el nombre. */
export type McpCall = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
) => string | undefined | Promise<string | undefined>;

export function mcpToolSpecs(defs: McpToolDef[], call: McpCall): ToolSpec[] {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.inputSchema as Record<string, unknown>,
    rawArgs: true,
    async run(args, ctx) {
      const text = await call(def.name, args, ctx);
      if (text === undefined) throw new Error(`La herramienta «${def.name}» no existe.`);
      return {
        text:
          text.length > MAX_RESULT_CHARS
            ? `${text.slice(0, MAX_RESULT_CHARS)}\n… [recortado: ${text.length} caracteres, se muestran ${MAX_RESULT_CHARS}]`
            : text,
      };
    },
  }));
}
