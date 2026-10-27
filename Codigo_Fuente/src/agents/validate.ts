import { AgentFrontmatter, AGENT_MODES, ALL_PERMISSION_TOOLS, FLAT_PERMISSION_TOOLS } from "./types";

export interface ValidationIssue {
  level: "error" | "warning";
  field?: string;
  message: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** provider/model-id: el model-id puede llevar "/" (p. ej. nvidia/meta/llama-3.1), opencode parte por la primera. */
const MODEL_RE = /^[^/\s]+\/[^\s]+$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ACTIONS = new Set(["allow", "ask", "deny"]);

const KNOWN_FIELDS = new Set([
  "name",
  "model",
  "variant",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "options",
  "permission",
  "disable",
  "temperature",
  "top_p",
]);

export function validateAgentName(name: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!name || !name.trim()) {
    issues.push({ level: "error", field: "name", message: "El nombre es obligatorio." });
    return issues;
  }
  if (!NAME_RE.test(name)) {
    issues.push({
      level: "error",
      field: "name",
      message: "Usa minúsculas, dígitos, punto, guion o guion bajo (sin espacios).",
    });
  }
  return issues;
}

export function validateFrontmatter(
  fm: AgentFrontmatter,
  knownModels?: Set<string>
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (fm.mode !== undefined && !AGENT_MODES.includes(fm.mode)) {
    issues.push({
      level: "error",
      field: "mode",
      message: `mode debe ser uno de: ${AGENT_MODES.join(", ")}.`,
    });
  }

  if (fm.model !== undefined) {
    if (typeof fm.model !== "string" || !MODEL_RE.test(fm.model)) {
      issues.push({
        level: "error",
        field: "model",
        message: 'model debe tener el formato "provider/model-id".',
      });
    } else if (knownModels && knownModels.size > 0 && !knownModels.has(fm.model)) {
      issues.push({
        level: "warning",
        field: "model",
        message: `"${fm.model}" no está en el catálogo de modelos detectado (opencode.json + models.dev).`,
      });
    }
  }

  if (fm.color !== undefined && typeof fm.color === "string" && fm.color.trim() !== "") {
    const c = fm.color.trim();
    const named = /^[a-zA-Z]+$/.test(c);
    if (!named && !HEX_COLOR_RE.test(c)) {
      issues.push({
        level: "warning",
        field: "color",
        message: "color debería ser un nombre de color o un hex (#rrggbb).",
      });
    }
  }

  if (fm.temperature !== undefined) {
    if (typeof fm.temperature !== "number" || fm.temperature < 0 || fm.temperature > 2) {
      issues.push({ level: "error", field: "temperature", message: "temperature debe estar entre 0 y 2." });
    }
  }

  if (fm.top_p !== undefined) {
    if (typeof fm.top_p !== "number" || fm.top_p < 0 || fm.top_p > 1) {
      issues.push({ level: "error", field: "top_p", message: "top_p debe estar entre 0 y 1." });
    }
  }

  if (fm.steps !== undefined) {
    if (typeof fm.steps !== "number" || !Number.isInteger(fm.steps) || fm.steps <= 0) {
      issues.push({ level: "error", field: "steps", message: "steps debe ser un entero positivo." });
    }
  }

  if (fm.permission !== undefined) {
    if (typeof fm.permission !== "object" || Array.isArray(fm.permission) || fm.permission === null) {
      issues.push({ level: "error", field: "permission", message: "permission debe ser un objeto." });
    } else {
      for (const [tool, value] of Object.entries(fm.permission)) {
        if (typeof value === "string") {
          if (!ACTIONS.has(value)) {
            issues.push({
              level: "error",
              field: "permission",
              message: `${tool}: acción "${value}" inválida (allow|ask|deny).`,
            });
          }
        } else if (value && typeof value === "object") {
          for (const [pattern, action] of Object.entries(value)) {
            if (typeof action !== "string" || !ACTIONS.has(action)) {
              issues.push({
                level: "error",
                field: "permission",
                message: `${tool}["${pattern}"]: acción inválida (allow|ask|deny).`,
              });
            }
          }
        } else {
          issues.push({ level: "error", field: "permission", message: `${tool}: valor de permiso inválido.` });
        }
      }
      const flat = new Set<string>(FLAT_PERMISSION_TOOLS);
      for (const tool of Object.keys(fm.permission)) {
        if (flat.has(tool) && typeof fm.permission[tool] !== "string") {
          issues.push({
            level: "warning",
            field: "permission",
            message: `${tool} solo admite una acción plana (allow|ask|deny), no patrones.`,
          });
        }
      }
    }
  }

  if (fm.mode === "subagent" && fm.description === undefined) {
    issues.push({
      level: "warning",
      field: "description",
      message: "Un subagente sin description es difícil de descubrir por el agente principal.",
    });
  }

  for (const key of Object.keys(fm)) {
    if (!KNOWN_FIELDS.has(key)) {
      issues.push({
        level: "warning",
        field: key,
        message: `Campo desconocido "${key}": opencode lo moverá a options.`,
      });
    }
  }

  return issues;
}

export function unknownPermissionTools(fm: AgentFrontmatter): string[] {
  if (!fm.permission) {
    return [];
  }
  const known = new Set<string>(ALL_PERMISSION_TOOLS);
  return Object.keys(fm.permission).filter((t) => !known.has(t));
}
