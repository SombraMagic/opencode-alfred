/** Registro extensible de herramientas del chatbot. Sin `vscode`. */
import type { ModelCapabilities, ToolContext, ToolResult, ToolSpec } from "./types";

/** Forma que Ollama espera en `tools` de `/api/chat`. */
export interface OllamaToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type Schema = { type?: string; properties?: Record<string, Schema & { maxLength?: number }>; required?: string[]; maxLength?: number; minimum?: number; maximum?: number };

/**
 * Valida y limpia lo que mandó el modelo contra el schema de la tool: solo pasan las
 * propiedades declaradas, con su tipo y sus topes. Lanza un `Error` legible si falta algo.
 */
function sanitizeArgs(schema: Schema, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Los argumentos deben ser un objeto.");
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const value = input[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (prop.type === "string") {
      if (typeof value !== "string") throw new Error(`«${key}» debe ser texto.`);
      if (prop.maxLength && value.length > prop.maxLength) {
        throw new Error(`«${key}» pasa de ${prop.maxLength} caracteres.`);
      }
      out[key] = value;
    } else if (prop.type === "number" || prop.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`«${key}» debe ser un número.`);
      }
      if (prop.minimum !== undefined && value < prop.minimum) throw new Error(`«${key}» es menor que ${prop.minimum}.`);
      if (prop.maximum !== undefined && value > prop.maximum) throw new Error(`«${key}» es mayor que ${prop.maximum}.`);
      out[key] = prop.type === "integer" ? Math.round(value) : value;
    } else if (prop.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`«${key}» debe ser verdadero o falso.`);
      out[key] = value;
    } else {
      throw new Error(`Tipo no soportado para «${key}».`);
    }
  }
  for (const key of schema.required ?? []) {
    if (out[key] === undefined || (typeof out[key] === "string" && !(out[key] as string).trim())) {
      throw new Error(`Falta «${key}».`);
    }
  }
  return out;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(tool: ToolSpec): void {
    this.tools.set(tool.name, tool);
  }

  /** Definiciones para Ollama; sin la capacidad `tools` del modelo no se ofrece ninguna. */
  specsFor(capabilities: ModelCapabilities): OllamaToolDef[] {
    if (!capabilities.tools) {
      return [];
    }
    return [...this.tools.values()].map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }

  /** Ejecuta una tool; nunca lanza: un fallo vuelve como texto para el modelo. */
  async run(
    name: string,
    args: unknown,
    ctx: ToolContext = {}
  ): Promise<{ result: ToolResult; error?: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      const error = `La herramienta «${name}» no existe.`;
      return { result: { text: error }, error };
    }
    try {
      const clean = sanitizeArgs(tool.parameters as Schema, args);
      return { result: await tool.run(clean, ctx) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { result: { text: `Error: ${error}` }, error };
    }
  }
}
