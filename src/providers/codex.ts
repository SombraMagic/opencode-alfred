/**
 * Lectura y edición de la configuración de Codex (`~/.codex/config.toml`) para el
 * Explorador. Las escrituras son quirúrgicas: solo tocan la clave pedida, vía
 * `setValue` de `toml.ts`, y el fichero solo se reescribe si el texto cambia.
 */
import { readdirSync, readFileSync, type Dirent } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { parseAgentFile } from "../agents/parser";
import { writeAtomic } from "../agents/store";
import type { ExplorerAgent, ExplorerCatalogItem } from "../panels/explorerPanel";
import { findTable, getValue, listTables, setValue } from "./toml";

export interface CodexExplorer {
  agents: { project: ExplorerAgent[]; global: ExplorerAgent[]; builtin: ExplorerAgent[] };
  mcp: ExplorerCatalogItem[];
  skills: ExplorerCatalogItem[];
  plugins: ExplorerCatalogItem[];
  autoAccept: boolean;
}

/* --------------------------------- rutas --------------------------------- */

export function codexHome(): string {
  const dir = process.env.CODEX_HOME?.trim();
  return dir ? path.normalize(dir) : path.join(os.homedir(), ".codex");
}

export function codexConfigFile(): string {
  return path.join(codexHome(), "config.toml");
}

export function codexInstructionsFile(
  scope: "project" | "global",
  projectRoot: string | undefined
): string {
  if (scope === "global") {
    return path.join(codexHome(), "AGENTS.md");
  }
  if (!projectRoot) {
    throw new Error("No hay un proyecto abierto.");
  }
  // El mismo AGENTS.md que lee opencode en el proyecto: aquí solo se devuelve la ruta.
  return path.join(projectRoot, "AGENTS.md");
}

/* --------------------------------- lectura -------------------------------- */

function readConfig(): string {
  try {
    return readFileSync(codexConfigFile(), "utf8");
  } catch {
    return "";
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function readAgents(text: string, file: string): ExplorerAgent[] {
  return listTables(text, ["agents"])
    .map((name) => ({
      name,
      // Los agentes de Codex son roles de multiagente: siempre globales y sin actividad.
      mode: "subagent" as const,
      scope: "global" as const,
      description: getValue(text, ["agents", name], "description"),
      filePath: file,
      working: false,
      streaming: false,
      tokens: 0,
      workMs: 0,
      cost: 0,
    }))
    .sort(byName);
}

function readMcp(text: string, file: string): ExplorerCatalogItem[] {
  return listTables(text, ["mcp_servers"])
    .map((name) => {
      const table = ["mcp_servers", name];
      const command = getValue(text, table, "command")?.trim();
      return {
        name,
        scope: "global" as const,
        // `enabled` ausente = servidor activo.
        enabled: getValue(text, table, "enabled") !== "false",
        detail: command || (getValue(text, table, "url") ? "http" : undefined),
        filePath: file,
      };
    })
    .sort(byName);
}

function readSkills(): ExplorerCatalogItem[] {
  const dir = path.join(codexHome(), "skills");
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExplorerCatalogItem[] = [];
  for (const entry of entries) {
    // `.system` son las skills internas de Codex: no se listan.
    if (!entry.isDirectory() || entry.name === ".system") {
      continue;
    }
    const file = path.join(dir, entry.name, "SKILL.md");
    try {
      const { frontmatter } = parseAgentFile(readFileSync(file, "utf8"));
      out.push({
        name: entry.name,
        scope: "global",
        enabled: true,
        // Codex no documenta forma de desactivar una skill: solo se muestra.
        toggleable: false,
        detail: frontmatter.description,
        filePath: file,
      });
    } catch {
      // Sin SKILL.md o con frontmatter ilegible: no es una skill utilizable.
    }
  }
  return out.sort(byName);
}

function readPlugins(text: string, file: string): ExplorerCatalogItem[] {
  return listTables(text, ["plugins"])
    .map((name) => {
      const at = name.lastIndexOf("@");
      return {
        name,
        scope: "global" as const,
        enabled: getValue(text, ["plugins", name], "enabled") !== "false",
        detail: at > 0 ? name.slice(at + 1) : undefined,
        filePath: file,
      };
    })
    .sort(byName);
}

export function codexExplorer(projectRoot: string | undefined): CodexExplorer {
  const file = codexConfigFile();
  const text = readConfig();
  return {
    agents: { project: [], global: readAgents(text, file), builtin: [] },
    mcp: readMcp(text, file),
    skills: readSkills(),
    plugins: readPlugins(text, file),
    autoAccept: getValue(text, [], "approval_policy") === "never",
  };
}

/* -------------------------------- escritura ------------------------------- */

/** Lee, aplica y escribe solo si el texto cambia. Un config ausente se trata como vacío. */
async function editConfig(apply: (text: string) => string): Promise<void> {
  const file = codexConfigFile();
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    // Sin config.toml: se parte de vacío y lo que decida `apply`.
  }
  const next = apply(text);
  if (next !== text) {
    await writeAtomic(file, next);
  }
}

export async function setCodexItem(
  kind: "mcp" | "skill" | "plugin",
  name: string,
  on: boolean
): Promise<void> {
  if (kind === "skill") {
    throw new Error("Codex no permite activar ni desactivar skills desde la configuración.");
  }
  const table = kind === "mcp" ? ["mcp_servers", name] : ["plugins", name];
  await editConfig((text) => {
    if (!findTable(text, table)) {
      throw new Error(
        kind === "mcp"
          ? "Ese servidor MCP no está en la configuración de Codex."
          : "Ese plugin no está en la configuración de Codex."
      );
    }
    return setValue(text, table, "enabled", on);
  });
}

export async function setCodexAutoAccept(on: boolean): Promise<void> {
  await editConfig((text) => setValue(text, [], "approval_policy", on ? "never" : "on-request"));
}
