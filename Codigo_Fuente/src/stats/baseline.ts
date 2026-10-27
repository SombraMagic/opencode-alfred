import * as vscode from "vscode";
import { AgentActivity, TokenCounts, emptyTokens } from "./opencodeStats";

export interface BaselineEntry {
  tokens: TokenCounts;
  cost: number;
  workMs: number;
  messages: number;
  sessions: number;
}

export type BaselineMap = Record<string, BaselineEntry>;

const KEY = "opencodeAgents.statsBaseline";

export function loadBaselines(context: vscode.ExtensionContext): BaselineMap {
  return context.globalState.get<BaselineMap>(KEY, {});
}

export async function saveBaselines(
  context: vscode.ExtensionContext,
  map: BaselineMap
): Promise<void> {
  await context.globalState.update(KEY, map);
}

export function entryFromActivity(activity: AgentActivity): BaselineEntry {
  return {
    tokens: { ...activity.tokens },
    cost: activity.cost,
    workMs: activity.workMs,
    messages: activity.messages,
    sessions: activity.sessions,
  };
}

function subtractTokens(current: TokenCounts, base: TokenCounts): TokenCounts {
  return {
    input: Math.max(0, current.input - base.input),
    output: Math.max(0, current.output - base.output),
    reasoning: Math.max(0, current.reasoning - base.reasoning),
    cacheRead: Math.max(0, current.cacheRead - base.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
    total: Math.max(0, current.total - base.total),
  };
}

export function applyBaseline(activity: AgentActivity, base?: BaselineEntry): AgentActivity {
  if (!base) {
    return activity;
  }
  return {
    ...activity,
    tokens: subtractTokens(activity.tokens, base.tokens ?? emptyTokens()),
    cost: Math.max(0, activity.cost - (base.cost ?? 0)),
    workMs: Math.max(0, activity.workMs - (base.workMs ?? 0)),
    messages: Math.max(0, activity.messages - (base.messages ?? 0)),
    sessions: Math.max(0, activity.sessions - (base.sessions ?? 0)),
  };
}
