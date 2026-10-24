import { Agent } from "./types";
import { saveAgent } from "./store";

/** Fija el `model` del frontmatter del agente (o lo borra con ""). Devuelve la ruta escrita. */
export async function setAgentModel(agent: Agent, model: string): Promise<string> {
  const frontmatter = { ...agent.frontmatter };
  if (model === "") {
    delete frontmatter.model;
  } else {
    frontmatter.model = model;
  }
  return saveAgent(agent.scope, agent.name, frontmatter, agent.prompt, agent.filePath);
}
