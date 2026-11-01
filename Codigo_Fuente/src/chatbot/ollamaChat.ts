/**
 * Cliente de chat de Ollama (`/api/chat` en NDJSON) con bucle de herramientas.
 * Sin `vscode`. Los errores salen como evento `error`, no como excepción.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { baseOf, ollamaRequest, unreachable } from "../ollama/client";
import type { ToolRegistry } from "./toolsRegistry";
import type { ChatEvent, ChatMessage, ChatOptions, ChatToolCall, ModelCapabilities } from "./types";

/** Rondas máximas de llamada al modelo por turno (cada una puede pedir herramientas). */
export const MAX_TOOL_ROUNDS = 5;

/** Capacidades del modelo según `/api/show`; si falla, todas a `false`. */
export async function modelCapabilities(
  baseURL: string,
  model: string
): Promise<ModelCapabilities> {
  const none = { tools: false, thinking: false, vision: false };
  try {
    const data = await ollamaRequest<{ capabilities?: unknown }>(baseURL, "/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const list = Array.isArray(data?.capabilities) ? data.capabilities : [];
    return {
      tools: list.includes("tools"),
      thinking: list.includes("thinking"),
      vision: list.includes("vision"),
    };
  } catch {
    return none;
  }
}

interface WireMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

/** Pasa el historial al formato de Ollama. Las imágenes solo viajan si el modelo tiene visión. */
async function toWire(
  messages: ChatMessage[],
  system: string | undefined,
  vision: boolean
): Promise<WireMessage[]> {
  const out: WireMessage[] = [];
  if (system?.trim()) {
    out.push({ role: "system", content: system });
  }
  for (const m of messages) {
    if (m.role === "system") {
      continue;
    }
    const wire: WireMessage = { role: m.role, content: m.content };
    if (m.role === "user" && m.images?.length && vision) {
      const images: string[] = [];
      for (const file of m.images) {
        try {
          images.push((await readFile(file)).toString("base64"));
        } catch {
          // Una imagen que ya no existe no debe romper la conversación.
        }
      }
      if (images.length) wire.images = images;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      wire.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
    }
    if (m.role === "tool" && m.toolName) {
      wire.tool_name = m.toolName;
    }
    out.push(wire);
  }
  return out;
}

interface RoundResult {
  content: string;
  toolCalls: ChatToolCall[];
  evalCount: number;
  evalDurationMs: number;
}

/** Una petición en streaming: cede delta/	hinking según llegan y devuelve lo acumulado. */
async function* streamRound(
  baseURL: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined
): AsyncGenerator<ChatEvent, RoundResult> {
  let response: Response;
  try {
    response = await fetch(`${baseOf(baseURL)}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error("Generación cancelada.");
    throw unreachable(baseURL, err);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).trim();
    throw new Error(
      `Ollama respondió ${response.status} en /api/chat${text ? `: ${text.slice(0, 300)}` : "."}`
    );
  }
  if (!response.body) {
    throw new Error("Ollama no abrió el flujo del chat.");
  }

  const result: RoundResult = { content: "", toolCalls: [], evalCount: 0, evalDurationMs: 0 };
  const pendingEvents: ChatEvent[] = [];
  const emit = (event: ChatEvent): void => {
    pendingEvents.push(event);
  };
  const consume = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Línea a medias: se ignora.
    }
    if (typeof data.error === "string" && data.error.trim()) {
      throw new Error(`Ollama: ${data.error.trim()}`);
    }
    const message = data.message as Record<string, unknown> | undefined;
    if (message) {
      if (typeof message.thinking === "string" && message.thinking) {
        emit({ type: "thinking", text: message.thinking });
      }
      if (typeof message.content === "string" && message.content) {
        result.content += message.content;
        emit({ type: "delta", text: message.content });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function;
          if (fn && typeof fn.name === "string" && fn.name) {
            const args =
              fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)
                ? (fn.arguments as Record<string, unknown>)
                : {};
            result.toolCalls.push({ name: fn.name, args });
          }
        }
      }
    }
    if (data.done === true) {
      if (typeof data.eval_count === "number") result.evalCount = data.eval_count;
      if (typeof data.eval_duration === "number") result.evalDurationMs = data.eval_duration / 1e6;
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      let index = rest.indexOf("\n");
      while (index >= 0) {
        consume(rest.slice(0, index));
        rest = rest.slice(index + 1);
        index = rest.indexOf("\n");
      }
      yield* pendingEvents.splice(0);
    }
    consume(rest + decoder.decode());
    yield* pendingEvents.splice(0);
  } catch (err) {
    if (signal?.aborted) throw new Error("Generación cancelada.");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    void reader.cancel().catch(() => {});
  }
  return result;
}

export interface ChatRunParams {
  baseURL: string;
  options: ChatOptions;
  /** Historial hasta el mensaje del usuario inclusive. */
  messages: ChatMessage[];
  registry: ToolRegistry;
  signal?: AbortSignal;
  /** Capacidades ya conocidas; si faltan se consultan a `/api/show`. */
  capabilities?: ModelCapabilities;
  /** Cada mensaje nuevo (assistant, tool) para que el host lo guarde en la conversación. */
  onMessage?: (message: ChatMessage) => void;
}

/** Un turno completo: streaming, herramientas y vuelta al modelo hasta que conteste sin ellas. */
export async function* runChat(params: ChatRunParams): AsyncGenerator<ChatEvent> {
  const started = Date.now();
  const { baseURL, options, registry, signal } = params;
  const history = [...params.messages];
  let evalCount = 0;
  let evalDurationMs = 0;

  try {
    const caps = params.capabilities ?? (await modelCapabilities(baseURL, options.model));
    const tools = registry.specsFor(caps);
    const modelOptions: Record<string, unknown> = {};
    if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
    if (options.numCtx !== undefined) modelOptions.num_ctx = options.numCtx;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: await toWire(history, options.system, caps.vision),
        stream: true,
        options: modelOptions,
      };
      if (tools.length) body.tools = tools;
      if (caps.thinking) body.think = true;

      const stream = streamRound(baseURL, body, signal);
      let round_: RoundResult;
      for (;;) {
        const next = await stream.next();
        if (next.done) {
          round_ = next.value;
          break;
        }
        yield next.value;
      }
      evalCount += round_.evalCount;
      evalDurationMs += round_.evalDurationMs;

      const assistant: ChatMessage = {
        id: randomUUID(),
        role: "assistant",
        content: round_.content,
        toolCalls: round_.toolCalls.length ? round_.toolCalls : undefined,
        at: Date.now(),
      };
      history.push(assistant);
      params.onMessage?.(assistant);

      if (!round_.toolCalls.length) {
        yield { type: "done", metrics: { evalCount, evalDurationMs, totalMs: Date.now() - started } };
        return;
      }

      for (const call of round_.toolCalls) {
        if (signal?.aborted) throw new Error("Generación cancelada.");
        yield { type: "toolStart", name: call.name, args: call.args };
        const { result, error } = await registry.run(call.name, call.args, { signal });
        yield { type: "toolEnd", name: call.name, result, error };
        const toolMsg: ChatMessage = {
          id: randomUUID(),
          role: "tool",
          content: result.text,
          toolName: call.name,
          images: result.attachment ? [result.attachment.file] : undefined,
          at: Date.now(),
        };
        history.push(toolMsg);
        params.onMessage?.(toolMsg);
      }
    }
    yield {
      type: "error",
      message: `El modelo pidió herramientas más de ${MAX_TOOL_ROUNDS} veces seguidas; se detuvo el turno.`,
    };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
