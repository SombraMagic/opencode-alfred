import { Agent } from "./types";
import { saveAgent } from "./store";
import { configEntryOf, setConfigAgentModel } from "./configAgents";

/** Fija el `model` del frontmatter del agente (o lo borra con ""). Devuelve la ruta escrita. */
export async function setAgentModel(agent: Agent, model: string): Promise<string> {
  // Un agente declarado en `opencode.json(c)` se escribe en su entrada: crear su `.md` lo taparía.
  if (agent.source === "inline") {
    return setConfigAgentModel(configEntryOf(agent), model);
  }
  const frontmatter = { ...agent.frontmatter };
  if (model === "") {
    delete frontmatter.model;
  } else {
    frontmatter.model = model;
  }
  return saveAgent(agent.scope, agent.name, frontmatter, agent.prompt, agent.filePath);
}
