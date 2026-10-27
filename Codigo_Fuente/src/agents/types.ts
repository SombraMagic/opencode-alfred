export type AgentMode = "primary" | "subagent" | "all";

export type Scope = "global" | "project";

export type Source = "file" | "inline" | "builtin";

export type PermissionAction = "allow" | "ask" | "deny";

/** A permission value is either a flat action or a pattern -> action map. */
export type PermissionValue = PermissionAction | Record<string, PermissionAction>;

export type Permission = Record<string, PermissionValue>;

export const FLAT_PERMISSION_TOOLS = [
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "doom_loop",
] as const;

export const PATTERN_PERMISSION_TOOLS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "lsp",
  "skill",
] as const;

export const ALL_PERMISSION_TOOLS = [
  ...PATTERN_PERMISSION_TOOLS,
  ...FLAT_PERMISSION_TOOLS,
] as const;

/** Frontmatter fields accepted by opencode's agent loader. */
export interface AgentFrontmatter {
  name?: string;
  model?: string;
  variant?: string;
  description?: string;
  mode?: AgentMode;
  hidden?: boolean;
  color?: string;
  steps?: number;
  options?: Record<string, unknown>;
  permission?: Permission;
  disable?: boolean;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface Agent {
  /** Agent key (file base name). */
  name: string;
  scope: Scope;
  source: Source;
  /** Absolute path of the .md file (file agents only). */
  filePath?: string;
  /** Directory that holds the agent file. */
  dir?: string;
  frontmatter: AgentFrontmatter;
  prompt: string;
  /** True when the name matches a built-in opencode agent. */
  builtin?: boolean;
  /** True when a higher-precedence scope defines the same name. */
  shadowed?: boolean;
  /** For builtins: whether a user/project override file exists. */
  overriddenBy?: Scope[];
}

export const BUILTIN_AGENTS = ["build", "plan", "general", "explore"] as const;
export const HIDDEN_BUILTIN_AGENTS = ["compaction", "title", "summary"] as const;

export const AGENT_MODES: AgentMode[] = ["primary", "subagent", "all"];

/** Nombres de tema que acepta el campo `color` de un agente, además de un hex válido. */
export const OPENCODE_AGENT_COLORS = [
  "primary",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
  "info",
] as const;
