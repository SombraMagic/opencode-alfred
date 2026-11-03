/**
 * Persistencia de conversaciones: un JSON por conversación en la carpeta indicada
 * (el host pasa `globalStorage`). Todo lo leído de disco se sanea. Sin `vscode`.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../pizarra/files";
import type { ChatMessage, ChatRole, ChatToolCall, Conversation } from "./types";

export const MAX_CONVERSATIONS = 50;
const MAX_TITLE = 60;
const MAX_MESSAGES = 1000;
const MAX_CONTENT = 200_000;
const ROLES: readonly ChatRole[] = ["system", "user", "assistant", "tool"];
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  updatedAt: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const MAX_ARG_KEYS = 32;
const MAX_ARG_CHARS = 10_000;

/**
 * Argumentos de una tool para el guardado: objeto plano y solo valores simples. Un valor
 * anidado o raro se descarta, para no arrastrar bultos al JSON de la conversación.
 */
function sanitizeArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (keys >= MAX_ARG_KEYS) break;
    if (!key || key.length > 100) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_ARG_CHARS);
    else if (typeof value === "boolean" || value === null) out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else continue;
    keys++;
  }
  return out;
}

function sanitizeMessage(raw: unknown): ChatMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.role !== "string" || !ROLES.includes(m.role as ChatRole)) return undefined;
  if (typeof m.content !== "string") return undefined;
  const message: ChatMessage = {
    id: typeof m.id === "string" && m.id ? m.id.slice(0, 64) : randomUUID(),
    role: m.role as ChatRole,
    content: m.content.slice(0, MAX_CONTENT),
    at: num(m.at),
  };
  if (Array.isArray(m.images)) {
    const images = m.images.filter((i): i is string => typeof i === "string" && i.length < 1000);
    if (images.length) message.images = images.slice(0, 16);
  }
  if (Array.isArray(m.toolCalls)) {
    const calls: ChatToolCall[] = [];
    for (const c of m.toolCalls) {
      const call = c as { name?: unknown; args?: unknown };
      if (call && typeof call.name === "string" && call.name) {
        const args =
          call.args && typeof call.args === "object" && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {};
        calls.push({ name: call.name.slice(0, 100), args });
      }
    }
    if (calls.length) message.toolCalls = calls;
  }
  if (typeof m.toolName === "string" && m.toolName) message.toolName = m.toolName.slice(0, 100);
  if (m.role === "tool") {
    const args = sanitizeArgs(m.args);
    if (args) message.args = args;
  }
  return message;
}

/** Conversación saneada o `undefined` si no tiene la forma esperada. */
export function sanitizeConversation(raw: unknown): Conversation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !ID_RE.test(c.id)) return undefined;
  const messages = (Array.isArray(c.messages) ? c.messages : [])
    .slice(0, MAX_MESSAGES)
    .map(sanitizeMessage)
    .filter((m): m is ChatMessage => !!m);
  return {
    id: c.id,
    title: typeof c.title === "string" ? c.title.slice(0, MAX_TITLE) : "",
    model: typeof c.model === "string" ? c.model.slice(0, 200) : "",
    createdAt: num(c.createdAt),
    updatedAt: num(c.updatedAt),
    messages,
  };
}

/** Título con las primeras palabras del primer mensaje del usuario. */
export function autoTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return "Conversación nueva";
  const words = first.content.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length > MAX_TITLE ? `${words.slice(0, MAX_TITLE - 1)}…` : words;
}

export function newConversation(model: string): Conversation {
  const now = Date.now();
  return { id: randomUUID(), title: "", model, createdAt: now, updatedAt: now, messages: [] };
}

export class ConversationStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error("Id de conversación no válido.");
    return join(this.dir, `${id}.json`);
  }

  /** Resúmenes, la más reciente primero. Un fichero roto se ignora. */
  async list(): Promise<ConversationSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: ConversationSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const conv = await this.load(name.slice(0, -5));
      if (conv) {
        out.push({ id: conv.id, title: conv.title || autoTitle(conv.messages), model: conv.model, updatedAt: conv.updatedAt });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<Conversation | undefined> {
    try {
      const conv = sanitizeConversation(JSON.parse(await readFile(this.file(id), "utf8")));
      return conv && conv.id === id ? conv : undefined;
    } catch {
      return undefined;
    }
  }

  /** Guarda (con título automático si no hay) y recorta a las 50 más recientes. */
  async save(conv: Conversation): Promise<Conversation> {
    const clean = sanitizeConversation(conv);
    if (!clean) throw new Error("Conversación no válida.");
    clean.title = clean.title.trim() || autoTitle(clean.messages);
    clean.updatedAt = Date.now();
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(this.file(clean.id), Buffer.from(JSON.stringify(clean), "utf8"));
    const all = await this.list();
    for (const old of all.slice(MAX_CONVERSATIONS)) {
      await this.remove(old.id);
    }
    return clean;
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.file(id));
    } catch {
      // Ya no estaba.
    }
  }
}
