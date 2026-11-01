/** Tipos del chatbot de pruebas de modelos locales. Sin `vscode`. */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** Llamada a una herramienta tal como la pide el modelo (argumentos sin validar). */
export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Rutas de imágenes (usuario: adjuntas; assistant: generadas por una tool). */
  images?: string[];
  toolCalls?: ChatToolCall[];
  /** Nombre de la tool que produjo un mensaje `tool`. */
  toolName?: string;
  at: number;
}

export interface ModelCapabilities {
  tools: boolean;
  thinking: boolean;
  vision: boolean;
}

export interface ToolResult {
  /** Lo único que ve el modelo. */
  text: string;
  /** Lo que ve la UI (nunca el modelo). */
  attachment?: { kind: "image"; file: string };
}

export interface ToolContext {
  signal?: AbortSignal;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema del objeto de argumentos. */
  parameters: Record<string, unknown>;
  /** Recibe los argumentos del modelo ya saneados por el registro. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ChatMetrics {
  evalCount: number;
  evalDurationMs: number;
  totalMs: number;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolStart"; name: string; args: Record<string, unknown> }
  | { type: "toolEnd"; name: string; result: ToolResult; error?: string }
  | { type: "done"; metrics: ChatMetrics }
  | { type: "error"; message: string };

export interface ChatOptions {
  model: string;
  system?: string;
  temperature?: number;
  numCtx?: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}
