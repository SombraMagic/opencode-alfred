/** Exporta una conversación a Markdown. Sin `vscode`. */
import type { Conversation } from "./types";

const LABEL = { system: "Sistema", user: "Usuario", assistant: "Asistente", tool: "Herramienta" } as const;

export function toMarkdown(conv: Conversation): string {
  const lines = [`# ${conv.title || "Conversación"}`, "", `Modelo: \`${conv.model}\``, ""];
  for (const m of conv.messages) {
    const name = m.role === "tool" && m.toolName ? `${LABEL.tool} (${m.toolName})` : LABEL[m.role];
    lines.push(`## ${name}`, "");
    if (m.content.trim()) lines.push(m.content.trim(), "");
    for (const call of m.toolCalls ?? []) {
      lines.push(`> Llama a \`${call.name}\`: \`${JSON.stringify(call.args)}\``, "");
    }
    for (const file of m.images ?? []) lines.push(`![imagen](${file.replace(/\\/g, "/")})`, "");
  }
  return lines.join("\n");
}
