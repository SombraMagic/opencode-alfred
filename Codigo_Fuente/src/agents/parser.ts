import * as yaml from "js-yaml";
import { AgentFrontmatter } from "./types";

export interface ParsedAgent {
  frontmatter: AgentFrontmatter;
  prompt: string;
}

const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export function parseAgentFile(text: string): ParsedAgent {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { frontmatter: {}, prompt: text.replace(/^\uFEFF/, "") };
  }
  const body = match[2] ?? "";
  let frontmatter: AgentFrontmatter = {};
  try {
    const loaded = yaml.load(match[1]);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      frontmatter = loaded as AgentFrontmatter;
    } else if (loaded != null) {
      throw new Error("El frontmatter debe ser un mapa YAML.");
    }
  } catch (err) {
    throw new Error(
      `Frontmatter YAML inválido: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { frontmatter, prompt: body.replace(/^\r?\n/, "") };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

export function serializeAgentFile(frontmatter: AgentFrontmatter, prompt: string): string {
  const clean = stripUndefined(frontmatter as Record<string, unknown>);
  const yamlText = yaml
    .dump(clean, { lineWidth: 100, noRefs: true, sortKeys: false, quotingType: '"' })
    .replace(/\n$/, "");
  const body = (prompt ?? "").replace(/^\r?\n/, "");
  return `---\n${yamlText}\n---\n\n${body}${body.endsWith("\n") || body === "" ? "" : "\n"}`;
}

export const EMPTY_FRONTMATTER_TEXT = "---\n---\n\n";
