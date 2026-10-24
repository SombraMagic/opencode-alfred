import * as vscode from "vscode";
import { Agent, AgentFrontmatter, Scope } from "./agents/types";
import {
  AgentList,
  findAgent,
  listAgents,
  readConfigInfo,
  writeAtomic,
} from "./agents/store";
import {
  DisabledPlugin,
  loadAutoAccept,
  loadMcpServers,
  loadPlugins,
  loadSkills,
  McpServer,
  PluginInfo,
  SkillInfo,
  setAutoAccept,
  setMcpEnabled,
  setPluginEnabled,
  setSkillEnabled,
} from "./agents/catalog";
import { globalOpencodeDir, isSamePath, projectRoot } from "./agents/paths";
import { validateAgentName } from "./agents/validate";
import { EditorPanel } from "./panels/editorPanel";
import {
  ExplorerAction,
  ExplorerAgent,
  ExplorerData,
  ExplorerPanel,
} from "./panels/explorerPanel";
import { ModelEntry, ModelsAction, ModelsData, ModelsPanel } from "./panels/modelsPanel";
import { InstructionsPanel } from "./panels/instructionsPanel";
import { StatsPanel } from "./panels/statsPanel";
import { ContextViewProvider } from "./panels/contextPanel";
import { VozPanel } from "./panels/voicePanel";
import { VozDictado } from "./panels/dictadoPanel";
import { speak, syncSharedConfig } from "./voice/service";
import { installMcp } from "./voice/mcpInstaller";
import { ContextWindowService } from "./stats/contextWindow";
import {
  emptyActivity,
  StatsService,
  StatsSnapshot,
  AgentActivity,
  SessionInfo,
} from "./stats/opencodeStats";
import {
  applyBaseline,
  BaselineMap,
  entryFromActivity,
  loadBaselines,
  saveBaselines,
} from "./stats/baseline";
import * as path from "path";
import { execFile } from "node:child_process";
import { existsSync } from "fs";
import * as fs from "fs/promises";
import {
  claudeAgentFile,
  claudeContext,
  claudeExplorer,
  claudeInstructionsFile,
  claudeModels,
  setClaudeAutoAccept,
  setClaudeItem,
  setClaudeModel,
} from "./providers/claude";
import {
  codexConfigFile,
  codexContext,
  codexExplorer,
  codexInstructionsFile,
  codexModels,
  setCodexAutoAccept,
  setCodexItem,
  setCodexModel,
} from "./providers/codex";
import { findTable, setValue } from "./providers/toml";

let voicePanel: VozPanel | undefined;
let dictado: VozDictado | undefined;

/** CLIs que puede lanzar el botón de sesión, en el orden del selector. */
const SESSION_AGENTS = ["opencode", "claude", "codex"] as const;
type SessionAgent = (typeof SESSION_AGENTS)[number];
const SESSION_AGENT_KEY = "opencodeAgents.sessionAgent";

export function activate(context: vscode.ExtensionContext): void {
  const explorer = new ExplorerPanel(context.extensionUri, {
    onAction: (action) => handleAction(action),
    onReady: () => refresh(),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerPanel.viewType, explorer, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // opencode has no "enabled" flag for plugins, so disabling removes the entry from
  // the config; remember it here so the switch can add it back.
  const DISABLED_PLUGINS = "opencodeAgents.disabledPlugins";
  const RECENT_MODELS = "opencodeAgents.recentModels";

  // La detección espera procesos del sistema: se lanza sin bloquear el arranque y, cuando
  // termina, repinta el panel. Hasta entonces el selector muestra solo opencode.
  const availableAgents: SessionAgent[] = [];
  let sessionAgent: SessionAgent = "opencode";
  void detectAgents();

  let disabledPlugins: DisabledPlugin[] = context.globalState.get<DisabledPlugin[]>(DISABLED_PLUGINS, []);
  async function setPluginDisabled(
    spec: string,
    scope: Scope,
    disabled: boolean,
    filePath: string
  ): Promise<void> {
    disabledPlugins = disabledPlugins.filter((d) => !(d.spec === spec && d.scope === scope));
    if (disabled) {
      disabledPlugins.push({ spec, scope, filePath });
    }
    await context.globalState.update(DISABLED_PLUGINS, disabledPlugins);
  }

  // Una terminal integrada por sesión, reutilizada al volver a pulsar la misma.
  const sessionTerminals = new Map<string, vscode.Terminal>();
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [key, term] of sessionTerminals) {
        if (term === closed) {
          sessionTerminals.delete(key);
        }
      }
    })
  );

  /** Cierra la bienvenida y los editores sin título vacíos que quedan al arrancar. */
  async function closeStarterTabs(): Promise<void> {
    const starter: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (tab.isDirty) {
          continue;
        }
        if (
          (input instanceof vscode.TabInputWebview || input instanceof vscode.TabInputCustom) &&
          /welcome|gettingStarted/i.test(input.viewType)
        ) {
          starter.push(tab);
        } else if (/^(welcome|bienvenida)$/i.test(tab.label)) {
          // En algunas builds la bienvenida no expone viewType reconocible.
          starter.push(tab);
        } else if (input instanceof vscode.TabInputText && input.uri.scheme === "untitled") {
          const document = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === input.uri.toString()
          );
          // Sin documento cargado se asume vacío; con contenido no se toca.
          if (!document || document.getText().trim() === "") {
            starter.push(tab);
          }
        }
      }
    }
    // Una a una y sin preservar el foco: así VS Code aplica su ajuste `closeEmptyGroups`.
    for (const tab of starter) {
      await vscode.window.tabGroups.close(tab, false);
    }
  }

  /**
   * Elimina los grupos de editor que quedaron sin pestañas.
   * VS Code no cierra solo el grupo vacío si el foco no estaba en él: hay que enfocarlo primero.
   */
  async function pruneEmptyGroups(): Promise<void> {
    // Tope de vueltas: si el foco no se mueve, no se insiste en bucle.
    for (let intento = 0; intento < 8; intento++) {
      const all = vscode.window.tabGroups.all;
      if (all.length <= 1) {
        return;
      }
      const target = all.find((group) => group.tabs.length === 0);
      if (!target) {
        return;
      }
      const steps = all.indexOf(target) - all.indexOf(vscode.window.tabGroups.activeTabGroup);
      // Los grupos van en orden de izquierda a derecha.
      const command =
        steps < 0 ? "workbench.action.focusLeftGroup" : "workbench.action.focusRightGroup";
      for (let i = 0; i < Math.abs(steps); i++) {
        await vscode.commands.executeCommand(command);
      }
      // Nunca cerrar un grupo con pestañas: si el foco no llegó, se abandona.
      if (vscode.window.tabGroups.activeTabGroup.tabs.length !== 0) {
        return;
      }
      try {
        await vscode.commands.executeCommand("workbench.action.closeEditorsAndGroup");
      } catch {
        // Builds sin el comando: se deja el grupo como esté antes que cerrar otra cosa.
        return;
      }
    }
  }

  /** Abre (o enfoca) la terminal de un agente. Una por agente: nunca duplica la que ya vive. */
  function openTerminal(key: string, name: string, cwd: string | undefined, command: string): void {
    const existing = sessionTerminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    // Pestaña en el área de editor; se puede arrastrar al panel o a otro grupo.
    // Si el área quedó vacía, 'Beside' crearía un grupo de más: se abre en el activo.
    const empty = vscode.window.tabGroups.all.every((g) => g.tabs.length === 0);
    const location = {
      viewColumn: empty ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
    };
    const terminal = vscode.window.createTerminal(
      cwd ? { name, cwd, location } : { name, location }
    );
    terminal.show();
    terminal.sendText(command);
    sessionTerminals.set(key, terminal);
  }

  /** Terminal viva con el nombre del agente: también las abiertas a mano o antes de recargar. */
  function runningTerminal(id: SessionAgent): vscode.Terminal | undefined {
    return vscode.window.terminals.find(
      (t) => t.exitStatus === undefined && t.name.toLowerCase() === id
    );
  }

  // shortcut: la detección es al activar; instalar un CLI después exige recargar la ventana.
  async function detectAgents(): Promise<void> {
    for (const id of SESSION_AGENTS) {
      if (await commandExists(id)) {
        availableAgents.push(id);
      }
    }
    if (availableAgents.length === 0) {
      availableAgents.push("opencode");
    }
    const stored = context.globalState.get<SessionAgent>(SESSION_AGENT_KEY, "opencode");
    sessionAgent = availableAgents.includes(stored) ? stored : availableAgents[0];
    refresh();
  }

  /** Rota el selector de sesión entre los agentes instalados y lo guarda. */
  async function cycleAgent(delta: 1 | -1): Promise<void> {
    if (availableAgents.length < 2) {
      return;
    }
    const index = availableAgents.indexOf(sessionAgent);
    sessionAgent = availableAgents[(index + delta + availableAgents.length) % availableAgents.length];
    await context.globalState.update(SESSION_AGENT_KEY, sessionAgent);
    refresh();
  }

  const statsService = new StatsService();
  const contextService = new ContextWindowService();
  const contextView = new ContextViewProvider(
    context.extensionUri,
    () => void refreshStats(true),
    () => void compactSession()
  );
  const modelsView = new ModelsPanel(context.extensionUri, {
    onAction: (action) => handleAction(action),
    onReady: () => void refreshModels(),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ModelsPanel.viewType, modelsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(ContextViewProvider.viewType, contextView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  let baselines: BaselineMap = loadBaselines(context);
  let display: StatsSnapshot | undefined;
  let lastKey = "";
  let lastRaw: StatsSnapshot | undefined;
  let agentList: AgentList = { global: [], project: [], builtins: [] };
  let catalogData: { mcp: McpServer[]; skills: SkillInfo[]; plugins: PluginInfo[] } = {
    mcp: [],
    skills: [],
    plugins: [],
  };
  let autoAccept = false;
  let models: ModelEntry[] = [];
  let recentModels: string[] = context.globalState.get<string[]>(RECENT_MODELS, []);

  const refresh = () => {
    void refreshAgents();
    void refreshCatalog();
    void refreshModels();
    void refreshStats(true);
    explorer.update(buildExplorerData());
  };

  /** Agente en la forma que pinta el explorador, con su actividad en vivo. */
  function explorerAgent(agent: Agent): ExplorerAgent {
    const act = display?.agents.find((a) => a.agent === agent.name);
    const mode = agent.frontmatter.mode;
    // Sin mode, el explorador solo distingue integrado o primary; "all" se pinta como primary.
    const fallback: ExplorerAgent["mode"] = agent.source === "builtin" ? "builtin" : "primary";
    return {
      name: agent.name,
      mode: mode === "subagent" ? "subagent" : mode === "primary" ? "primary" : fallback,
      scope: agent.source === "builtin" ? "builtin" : agent.scope,
      description: agent.frontmatter.description,
      model: agent.frontmatter.model,
      color: agent.frontmatter.color,
      disabled: agent.frontmatter.disable === true,
      shadowed: agent.shadowed,
      overriddenBy: agent.overriddenBy,
      filePath: agent.filePath,
      working: act?.working === true,
      streaming: act?.streaming === true,
      tokens: act?.tokens.total ?? 0,
      workMs: act?.workMs ?? 0,
      cost: act?.cost ?? 0,
    };
  }

  /** Última sesión del proyecto abierto; sin carpeta abierta, ninguna. */
  function pickSession(snapshot: StatsSnapshot): SessionInfo | undefined {
    const root = projectRoot();
    return (snapshot.sessions ?? [])
      .filter((s) => !s.parentId && !!root && isSamePath(s.directory, root))
      .sort((a, b) => b.updated - a.updated)[0];
  }

  /** Compacta la conversación de la sesión medida en el panel: el equivalente a `/compact` del TUI. */
  async function compactSession(): Promise<void> {
    if (sessionAgent !== "opencode") {
      // En Claude y Codex `/compact` es un comando del TUI y no hay API local: se escribe en su terminal.
      const label = sessionAgent === "claude" ? "Claude" : "Codex";
      const terminal = runningTerminal(sessionAgent);
      if (!terminal) {
        void vscode.window.showWarningMessage(
          `No hay ninguna terminal de ${label} abierta que compactar.`
        );
        return;
      }
      terminal.sendText("/compact");
      void vscode.window.setStatusBarMessage(`opencode: compactación pedida a ${label}.`, 4000);
      return;
    }
    const id = contextView.currentSessionId();
    if (!id) {
      void vscode.window.showWarningMessage(
        "opencode: todavía no hay una sesión medida que compactar."
      );
      return;
    }
    try {
      // El endpoint exige cuerpo JSON: sin `-d` el CLI no lo manda y el servidor responde 400.
      await opencodeApi("POST", `/api/session/${id}/compact`, {});
      void vscode.window.setStatusBarMessage("opencode: compactación pedida a la sesión.", 4000);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo compactar: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Recientes guardados; en el primer arranque se siembran con las últimas sesiones. */
  function recentModelIds(): string[] {
    if (recentModels.length > 0) {
      return recentModels;
    }
    const snapshot = display ?? lastRaw;
    if (!snapshot) {
      return [];
    }
    const seen: string[] = [];
    for (const s of [...(snapshot.sessions ?? [])].sort((a, b) => b.updated - a.updated)) {
      if (s.model && !seen.includes(s.model)) {
        seen.push(s.model);
      }
    }
    return seen.slice(0, 5);
  }

  function modelsData(): ModelsData {
    if (sessionAgent === "claude") {
      // Claude no tiene "recientes" guardados: solo el configurado y lo visto en sesiones.
      return { ...claudeModels(projectRoot()), recentModels: [] };
    }
    if (sessionAgent === "codex") {
      return { ...codexModels(), recentModels: [] };
    }
    const snapshot = display ?? lastRaw;
    return {
      models,
      currentModel: snapshot ? (pickSession(snapshot)?.model ?? "") : "",
      recentModels: recentModelIds(),
    };
  }

  function buildExplorerData(): ExplorerData {
    if (sessionAgent === "claude") {
      const claude = claudeExplorer(projectRoot());
      return {
        hasProject: !!projectRoot(),
        agents: claude.agents,
        mcp: claude.mcp,
        skills: claude.skills,
        plugins: claude.plugins,
        // Claude no tiene histórico de actividad aquí: los totales se quedan a cero.
        totals: { tokens: 0, workMs: 0, cost: 0, working: 0 },
        autoAccept: claude.autoAccept,
        sessionAgent,
        sessionAgents: availableAgents,
      };
    }
    if (sessionAgent === "codex") {
      const codex = codexExplorer(projectRoot());
      return {
        hasProject: !!projectRoot(),
        agents: codex.agents,
        mcp: codex.mcp,
        skills: codex.skills,
        plugins: codex.plugins,
        // Codex tampoco tiene histórico de actividad aquí: los totales se quedan a cero.
        totals: { tokens: 0, workMs: 0, cost: 0, working: 0 },
        autoAccept: codex.autoAccept,
        sessionAgent,
        sessionAgents: availableAgents,
      };
    }
    const totals = display?.totals;
    return {
      hasProject: !!projectRoot(),
      agents: {
        project: agentList.project.map(explorerAgent),
        global: agentList.global.map(explorerAgent),
        builtin: agentList.builtins.map(explorerAgent),
      },
      mcp: catalogData.mcp.map((s) => ({
        name: s.name,
        scope: s.scope,
        enabled: s.enabled,
        detail: s.type === "remote" ? "remote" : "local",
        filePath: s.filePath,
      })),
      skills: catalogData.skills.map((s) => ({
        name: s.name,
        scope: s.scope,
        enabled: s.enabled,
        detail: s.description,
        filePath: s.filePath,
      })),
      plugins: catalogData.plugins.map((p) => ({
        name: p.name,
        scope: p.scope,
        enabled: p.enabled,
        filePath: p.filePath,
      })),
      totals: {
        tokens: totals?.tokens.total ?? 0,
        workMs: totals?.workMs ?? 0,
        cost: totals?.cost ?? 0,
        working: display?.agents.filter((a) => a.working).length ?? 0,
      },
      autoAccept,
      sessionAgent,
      sessionAgents: availableAgents,
    };
  }

  /** Lista viva de opencode: `readConfigInfo` incluiría modelos vetados o deshabilitados. */
  async function refreshModels(): Promise<void> {
    if (sessionAgent !== "opencode") {
      // Claude y Codex no tienen API local de modelos: se pinta su catálogo y ya.
      modelsView.update(modelsData());
      return;
    }
    try {
      const raw = await opencodeApi("GET", "/api/model");
      const parsed = JSON.parse(raw) as { data?: ApiModel[] };
      if (!Array.isArray(parsed.data)) {
        throw new Error("respuesta sin lista de modelos");
      }
      models = parsed.data
        .filter(
          (m): m is ApiModel & { modelID: string; providerID: string } =>
            m.enabled !== false && !!m.providerID && !!m.modelID
        )
        .map((m) => ({
          id: `${m.providerID}/${m.modelID}`,
          provider: m.providerID,
          model: m.modelID,
          name: m.name || m.modelID,
          // Gratis de verdad: la tarifa que publica opencode está a cero en todos los tramos.
          free: (m.cost ?? []).length > 0 && m.cost!.every((c) => c.input === 0 && c.output === 0),
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
      modelsView.update(modelsData());
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo leer la lista de modelos de opencode: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function refreshAgents(): Promise<void> {
    const showBuiltins = vscode.workspace
      .getConfiguration("opencodeAgents")
      .get<boolean>("showBuiltins", true);
    agentList = await listAgents(showBuiltins);
    explorer.update(buildExplorerData());
  }

  async function refreshCatalog(): Promise<void> {
    const [mcp, skills, plugins, accept] = await Promise.all([
      loadMcpServers(),
      loadSkills(),
      loadPlugins(disabledPlugins),
      loadAutoAccept(),
    ]);
    catalogData = { mcp, skills, plugins };
    autoAccept = accept;
    explorer.update(buildExplorerData());
  }

  function recomputeTotals(agents: AgentActivity[]): AgentActivity {
    const totals = emptyActivity("(total)");
    for (const a of agents) {
      totals.tokens.input += a.tokens.input;
      totals.tokens.output += a.tokens.output;
      totals.tokens.reasoning += a.tokens.reasoning;
      totals.tokens.cacheRead += a.tokens.cacheRead;
      totals.tokens.cacheWrite += a.tokens.cacheWrite;
      totals.tokens.total += a.tokens.total;
      totals.cost += a.cost;
      totals.workMs += a.workMs;
      totals.messages += a.messages;
      totals.sessions += a.sessions;
      totals.lastActive = Math.max(totals.lastActive, a.lastActive);
      totals.working = totals.working || a.working;
      totals.workingSessions += a.workingSessions;
    }
    return totals;
  }

  function toDisplay(snapshot: StatsSnapshot): StatsSnapshot {
    const agents = snapshot.agents.map((a) => applyBaseline(a, baselines[a.agent]));
    return { ...snapshot, agents, totals: recomputeTotals(agents) };
  }

  function keyOf(snapshot: StatsSnapshot): string {
    // El modelo entra en la clave: si se cambia desde el TUI, el bloque tiene que seguirlo.
    const session = pickSession(snapshot);
    const head = `${snapshot.ok}|${snapshot.error ?? ""}|${snapshot.dbs.length}|${session?.id ?? ""}|${session?.model ?? ""}`;
    const body = snapshot.agents
      .map(
        (a) =>
          `${a.agent}:${a.tokens.total}:${a.workMs}:${a.messages}:${a.working ? 1 : 0}:${a.streaming ? 1 : 0}:${a.sessions}`
      )
      .join(";");
    return `${head}|${body}`;
  }

  async function refreshStats(force = false): Promise<void> {
    if (sessionAgent !== "opencode") {
      // La BD que mide StatsService es la de opencode: con otro agente no se paga ese escaneo.
      contextView.update(
        sessionAgent === "claude" ? claudeContext(projectRoot()) : codexContext(projectRoot())
      );
      explorer.update(buildExplorerData());
      // Las tarjetas de voz son de opencode: con otro agente no hay «en vuelo» que seguir.
      voicePanel?.updateAgents([]);
      return;
    }
    const raw = await statsService.collect();
    lastRaw = raw;
    const disp = toDisplay(raw);
    const info = await contextService.collect();
    contextView.update(info);
    // El panel de voz sigue a los agentes en vuelo aunque el snapshot no haya cambiado:
    // el `key` solo corta el resto de la actualización.
    voicePanel?.updateAgents(
      disp.agents.filter((a) => a.working).map((a) => ({ name: a.agent, streaming: a.streaming }))
    );
    const key = keyOf(disp);
    if (!force && key === lastKey) {
      return;
    }
    lastKey = key;
    display = disp;
    StatsPanel.current?.update(disp);
    explorer.update(buildExplorerData());
    // El modelo de Claude y Codex no sale de las estadísticas: bastan refresh() y setModel.
    if (sessionAgent === "opencode") {
      modelsView.update(modelsData());
    }
  }

  async function resetAgent(agent: string): Promise<void> {
    const raw = lastRaw ?? (await statsService.collect());
    const act = raw.agents.find((a) => a.agent === agent);
    if (act) {
      baselines[agent] = entryFromActivity(act);
      await saveBaselines(context, baselines);
    }
    await refreshStats(true);
    void vscode.window.setStatusBarMessage(`opencode: contadores de "${agent}" reiniciados.`, 4000);
  }

  async function clearAgent(agent: string): Promise<void> {
    if (baselines[agent]) {
      delete baselines[agent];
      await saveBaselines(context, baselines);
    }
    await refreshStats(true);
    void vscode.window.setStatusBarMessage(
      `opencode: contadores de "${agent}" vuelven a mostrar el histórico completo.`,
      4000
    );
  }

  async function resetAllAgents(): Promise<void> {
    const raw = lastRaw ?? (await statsService.collect());
    for (const a of raw.agents) {
      baselines[a.agent] = entryFromActivity(a);
    }
    await saveBaselines(context, baselines);
    await refreshStats(true);
    void vscode.window.setStatusBarMessage("opencode: contadores de todos los agentes reiniciados.", 4000);
  }

  async function clearAllAgents(): Promise<void> {
    baselines = {};
    await saveBaselines(context, baselines);
    await refreshStats(true);
    void vscode.window.setStatusBarMessage("opencode: histórico completo restaurado.", 4000);
  }

  function openStatsPanel(): void {
    StatsPanel.open(context, {
      reset: async (agent?: string) => (agent ? resetAgent(agent) : resetAllAgents()),
      clear: async (agent?: string) => (agent ? clearAgent(agent) : clearAllAgents()),
      refresh: async () => refreshStats(true),
    });
    if (display) {
      StatsPanel.current?.update(display);
    }
    void refreshStats(true);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  function restartPolling(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    const cfg = vscode.workspace.getConfiguration("opencodeAgents");
    if (!cfg.get<boolean>("watchLive", true)) {
      return;
    }
    const interval = Math.max(500, cfg.get<number>("liveIntervalMs", 2000));
    timer = setInterval(() => void refreshStats(), interval);
  }
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("opencodeAgents.refresh", refresh),

    vscode.commands.registerCommand("opencodeAgents.editInstructions", () =>
      openInstructions("global")
    ),

    vscode.commands.registerCommand("opencodeAgents.editProjectInstructions", () =>
      openInstructions("project")
    ),

    vscode.commands.registerCommand("opencodeAgents.createAgent", () =>
      sessionAgent !== "opencode"
        ? void handleAction({ type: "createAgent", mode: "primary" })
        : createAgent(context, "primary", refresh)
    ),

    vscode.commands.registerCommand("opencodeAgents.createSubagent", () =>
      sessionAgent !== "opencode"
        ? void handleAction({ type: "createAgent", mode: "subagent" })
        : createAgent(context, "subagent", refresh)
    ),

    vscode.commands.registerCommand("opencodeAgents.showStats", () => openStatsPanel()),

    vscode.commands.registerCommand("opencodeAgents.resetAllStats", () => resetAllAgents()),

    vscode.commands.registerCommand("opencodeAgents.clearAllStats", () => clearAllAgents()),

    vscode.commands.registerCommand("opencodeAgents.addPlugin", () =>
      sessionAgent !== "opencode" ? void handleAction({ type: "addPlugin" }) : addPlugin()
    ),

    vscode.commands.registerCommand("opencodeAgents.newSession", () => {
      openTerminal("__new__", "opencode", projectRoot(), "opencode");
    })
  );

  async function openInstructions(scope: Scope): Promise<void> {
    // Claude y Codex no comparten el editor de AGENTS.md de opencode: se abre su fichero.
    if (sessionAgent !== "opencode") {
      await handleAction({ type: "editInstructions", scope });
      return;
    }
    if (scope === "project" && !projectRoot()) {
      void vscode.window.showWarningMessage("Abre una carpeta de proyecto para editar su AGENTS.md.");
      return;
    }
    await InstructionsPanel.open(context, scope, { onSaved: refresh });
  }

  async function openFile(file: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo abrir ${file}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Agente de la última carga; sin scope busca primero en el proyecto y luego en el global. */
  function findLoadedAgent(name: string, scope?: Scope | "builtin"): Agent | undefined {
    if (scope === "builtin") {
      return agentList.builtins.find((a) => a.name === name);
    }
    const groups =
      scope === "global"
        ? [agentList.global]
        : scope === "project"
          ? [agentList.project]
          : [agentList.project, agentList.global];
    return groups.map((g) => g.find((a) => a.name === name)).find(Boolean);
  }

  async function addPlugin(): Promise<void> {
    const input = await vscode.window.showInputBox({
      prompt: "Paquete npm o ruta de carpeta del plugin",
      placeHolder: "@usuario/paquete o ./.opencode/plugins",
      validateInput: (v) => (v.trim() ? undefined : "Escribe un paquete o una ruta"),
    });
    const spec = input?.trim();
    if (!spec) {
      return;
    }
    const scope = await pickScope("¿Dónde añadir el plugin?");
    if (!scope) {
      return;
    }
    try {
      const file = await setPluginEnabled(spec, scope, true);
      await setPluginDisabled(spec, scope, false, file);
      await refreshCatalog();
      void vscode.window.setStatusBarMessage(
        `opencode: plugin "${spec}" añadido. Reinicia opencode para aplicarlo.`,
        5000
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo añadir el plugin: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Aplica un cambio de catálogo y recuerda que opencode no lo recarga en caliente. */
  async function catalogEdit(run: () => Promise<void>, what: string): Promise<void> {
    try {
      await run();
      await refreshCatalog();
      void vscode.window.setStatusBarMessage(
        `opencode: ${what}. Reinicia opencode para aplicarlo.`,
        5000
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo actualizar: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Acciones del Explorador cuando el proveedor elegido es Claude. Devuelve true si la
   * acción era suya; las que no lo son siguen el camino de opencode.
   */
  async function handleClaudeAction(action: ExplorerAction | ModelsAction): Promise<boolean> {
    switch (action.type) {
      case "editAgent":
      case "openAgentFile": {
        const file =
          action.scope === "builtin"
            ? undefined
            : claudeAgentFile(action.name, action.scope, projectRoot());
        if (file && existsSync(file)) {
          await openFile(file);
        } else {
          void vscode.window.showWarningMessage(
            "No encuentro el fichero de ese agente de Claude."
          );
        }
        return true;
      }

      case "createAgent": {
        const name = await vscode.window.showInputBox({
          prompt: "Nombre del agente de Claude",
          placeHolder: "mi-agente",
          validateInput: (v) =>
            /^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "Minúsculas, números y guiones",
        });
        if (!name) {
          return true;
        }
        // Los agentes de Claude se crean siempre en el scope global.
        const file = claudeAgentFile(name, "global", projectRoot());
        if (!file) {
          return true;
        }
        if (existsSync(file)) {
          void vscode.window.showWarningMessage(`Ya existe un agente "${name}" en ese scope.`);
          await openFile(file);
          return true;
        }
        try {
          await fs.mkdir(path.dirname(file), { recursive: true });
          // Frontmatter mínimo: el cuerpo vacío es el prompt que se escribe luego.
          await writeAtomic(file, `---\nname: ${name}\ndescription: \n---\n\n`);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo crear el agente: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        }
        await openFile(file);
        refresh();
        return true;
      }

      case "toggleMcp":
      case "togglePlugin": {
        const isMcp = action.type === "toggleMcp";
        const root = projectRoot();
        const claude = claudeExplorer(root);
        const item = (isMcp ? claude.mcp : claude.plugins).find(
          (i) => i.name === action.name && i.scope === action.scope
        );
        if (!item) {
          void vscode.window.showWarningMessage(
            `No encuentro ese ${isMcp ? "servidor MCP" : "plugin"} en la configuración de Claude.`
          );
          return true;
        }
        try {
          await setClaudeItem(
            isMcp ? "mcp" : "plugin",
            action.name,
            action.scope,
            !item.enabled,
            root
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo actualizar: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        refresh();
        return true;
      }

      case "toggleSkill":
        // Claude no deja apagarlas: lo que lance setClaudeItem es lo que se avisa.
        try {
          await setClaudeItem("skill", action.name, action.scope, false, projectRoot());
        } catch (err) {
          void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
        }
        return true;

      case "addPlugin":
        // Los plugins de Claude se gestionan con su propio CLI, no con un campo de config.
        void vscode.window.showWarningMessage(
          "Los plugins de Claude se instalan con «claude plugin» en su terminal, no desde aquí."
        );
        return true;

      case "setModel":
        // Lo resuelve el switch común, que escribe en la config del proveedor activo.
        return false;

      case "setAutoAccept":
        try {
          await setClaudeAutoAccept(action.on);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar los permisos: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        }
        refresh();
        return true;

      case "editInstructions": {
        if (action.scope === "project" && !projectRoot()) {
          void vscode.window.showWarningMessage(
            "Abre una carpeta de proyecto para editar su CLAUDE.md."
          );
          return true;
        }
        // El editor de AGENTS.md es de opencode: aquí se abre el fichero tal cual.
        const file = claudeInstructionsFile(action.scope, projectRoot());
        if (!existsSync(file)) {
          try {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await writeAtomic(file, "");
          } catch (err) {
            void vscode.window.showErrorMessage(
              `No se pudo crear ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`
            );
            return true;
          }
        }
        await openFile(file);
        return true;
      }

      default:
        return false;
    }
  }

  /**
   * Acciones del Explorador cuando el proveedor elegido es Codex. Devuelve true si la
   * acción era suya; las que no lo son siguen el camino de opencode.
   */
  async function handleCodexAction(action: ExplorerAction | ModelsAction): Promise<boolean> {
    const config = codexConfigFile();
    switch (action.type) {
      case "editAgent":
      case "openAgentFile":
        // Los agentes de Codex son tablas del config.toml, no ficheros sueltos.
        if (existsSync(config)) {
          await openFile(config);
        } else {
          void vscode.window.showWarningMessage("No encuentro la configuración de Codex.");
        }
        return true;

      case "createAgent": {
        const name = await vscode.window.showInputBox({
          prompt: "Nombre del agente de Codex",
          placeHolder: "mi-agente",
          validateInput: (v) =>
            /^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "Minúsculas, números y guiones",
        });
        if (!name) {
          return true;
        }
        let text = "";
        try {
          text = await fs.readFile(config, "utf8");
        } catch {
          // Sin config.toml todavía: se crea con la tabla del agente.
        }
        if (findTable(text, ["agents", name])) {
          void vscode.window.showWarningMessage(`Ya existe un agente "${name}" en ese scope.`);
          await openFile(config);
          return true;
        }
        try {
          await writeAtomic(config, setValue(text, ["agents", name], "description", ""));
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo crear el agente: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        }
        await openFile(config);
        refresh();
        return true;
      }

      case "toggleMcp":
      case "togglePlugin": {
        const isMcp = action.type === "toggleMcp";
        const codex = codexExplorer(projectRoot());
        const item = (isMcp ? codex.mcp : codex.plugins).find((i) => i.name === action.name);
        if (!item) {
          void vscode.window.showWarningMessage(
            `No encuentro ese ${isMcp ? "servidor MCP" : "plugin"} en la configuración de Codex.`
          );
          return true;
        }
        try {
          await setCodexItem(isMcp ? "mcp" : "plugin", action.name, !item.enabled);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo actualizar: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        refresh();
        return true;
      }

      case "toggleSkill":
        try {
          await setCodexItem("skill", action.name, false);
        } catch (err) {
          void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
        }
        return true;

      case "addPlugin":
        // Los plugins de Codex se declaran en el TOML; aquí no se inventan.
        void vscode.window.showWarningMessage(
          'Los plugins de Codex se añaden en config.toml (sección [plugins."nombre@marketplace"]).'
        );
        return true;

      case "setModel":
        // Lo resuelve el switch común, que escribe en la config del proveedor activo.
        return false;

      case "setAutoAccept":
        try {
          await setCodexAutoAccept(action.on);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar los permisos: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        }
        refresh();
        return true;

      case "editInstructions": {
        if (action.scope === "project" && !projectRoot()) {
          void vscode.window.showWarningMessage(
            "Abre una carpeta de proyecto para editar su AGENTS.md."
          );
          return true;
        }
        // El editor de AGENTS.md es de opencode: aquí se abre el fichero tal cual.
        const file = codexInstructionsFile(action.scope, projectRoot());
        if (!existsSync(file)) {
          try {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await writeAtomic(file, "");
          } catch (err) {
            void vscode.window.showErrorMessage(
              `No se pudo crear ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`
            );
            return true;
          }
        }
        await openFile(file);
        return true;
      }

      default:
        return false;
    }
  }

  async function handleAction(action: ExplorerAction | ModelsAction): Promise<void> {
    if (sessionAgent !== "opencode") {
      const handled =
        sessionAgent === "claude"
          ? await handleClaudeAction(action)
          : await handleCodexAction(action);
      if (handled) {
        return;
      }
    }
    switch (action.type) {
      case "editInstructions":
        return openInstructions(action.scope);

      case "openLastSession": {
        await closeStarterTabs();
        await pruneEmptyGroups();
        // Si la terminal de ese agente ya vive, es en la que el usuario trabaja: se enfoca.
        const live = runningTerminal(sessionAgent);
        if (live) {
          live.show();
          return;
        }
        const root = projectRoot();
        if (sessionAgent === "opencode") {
          const snapshot = lastRaw ?? (await statsService.collect());
          const last = pickSession(snapshot);
          // Sin sesión que case, `-c` retoma la última del propio opencode en vez de crear una nueva.
          if (last) {
            openTerminal("opencode", "opencode", last.directory, `opencode -s ${last.id}`);
          } else {
            openTerminal("opencode", "opencode", root, "opencode -c");
          }
          return;
        }
        // Continuar la última conversación del agente. Sin historial, el CLI avisa y se cierra.
        openTerminal(
          sessionAgent,
          sessionAgent,
          root,
          sessionAgent === "claude" ? "claude --continue" : "codex resume --last"
        );
        return;
      }

      case "createAgent":
        return createAgent(context, action.mode, refresh);

      case "editAgent": {
        const agent = findLoadedAgent(action.name, action.scope);
        if (!agent) {
          return;
        }
        return EditorPanel.open(context, agent, {
          mode: agent.source === "builtin" ? "create" : "edit",
          onSaved: refresh,
        });
      }

      case "openAgentFile": {
        const file = findLoadedAgent(action.name, action.scope)?.filePath;
        if (file) {
          await openFile(file);
        }
        return;
      }

      case "toggleMcp": {
        const server = catalogData.mcp.find(
          (s) => s.name === action.name && s.scope === action.scope
        );
        if (!server) {
          return;
        }
        return catalogEdit(
          () => setMcpEnabled(server, !server.enabled),
          `MCP "${server.name}" ${server.enabled ? "desactivado" : "activado"}`
        );
      }

      case "toggleSkill": {
        const skill = catalogData.skills.find(
          (s) => s.name === action.name && s.scope === action.scope
        );
        if (!skill) {
          return;
        }
        return catalogEdit(
          () => setSkillEnabled(skill, !skill.enabled),
          `skill "${skill.name}" ${skill.enabled ? "desactivada" : "activada"}`
        );
      }

      case "togglePlugin": {
        const plugin = catalogData.plugins.find(
          (p) => p.name === action.name && p.scope === action.scope
        );
        if (!plugin) {
          return;
        }
        return catalogEdit(async () => {
          const file = await setPluginEnabled(
            plugin.spec,
            plugin.scope,
            !plugin.enabled,
            plugin.filePath
          );
          await setPluginDisabled(plugin.spec, plugin.scope, plugin.enabled, file);
        }, `plugin "${plugin.name}" ${plugin.enabled ? "desactivado" : "activado"}`);
      }

      case "addPlugin":
        return addPlugin();

      case "cycleAgent": {
        if (action.delta !== 1 && action.delta !== -1) {
          return;
        }
        return cycleAgent(action.delta);
      }

      case "setAutoAccept": {
        try {
          await setAutoAccept(action.on);
          autoAccept = action.on;
          explorer.update(buildExplorerData());
          void vscode.window.setStatusBarMessage(
            action.on
              ? "opencode: permisos automáticos activados. Se aplica sin reiniciar."
              : "opencode: permisos con pregunta. Se aplica sin reiniciar.",
            5000
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar los permisos: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      case "setModel": {
        if (sessionAgent !== "opencode") {
          const isClaude = sessionAgent === "claude";
          const name = action.id.slice(action.id.indexOf("/") + 1);
          try {
            await (isClaude ? setClaudeModel(action.id) : setCodexModel(action.id));
            refresh();
            void vscode.window.setStatusBarMessage(
              `${isClaude ? "Claude" : "Codex"}: modelo «${name}» guardado; se aplica a las sesiones nuevas (en la actual, /model).`,
              4000
            );
          } catch (err) {
            void vscode.window.showErrorMessage(
              `No se pudo cambiar el modelo: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          return;
        }
        const model = models.find((m) => m.id === action.id);
        if (!model) {
          return;
        }
        const snapshot = lastRaw ?? (await statsService.collect());
        const session = pickSession(snapshot);
        if (!session) {
          void vscode.window.showWarningMessage(
            "opencode: no hay ninguna sesión en marcha a la que cambiar el modelo."
          );
          return;
        }
        if (session.model === model.id) {
          return; // ya está en uso: no se toca
        }
        try {
          await opencodeApi("POST", `/api/session/${session.id}/model`, {
            model: { id: model.model, providerID: model.provider },
          });
          recentModels = [model.id, ...recentModels.filter((id) => id !== model.id)].slice(0, 5);
          await context.globalState.update(RECENT_MODELS, recentModels);
          await refreshStats(true);
          void vscode.window.setStatusBarMessage(
            `opencode: modelo «${model.name}» en uso.`,
            4000
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar el modelo: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("opencodeAgents")) {
        restartPolling();
        refresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const name = doc.fileName.toLowerCase();
      if (
        name.endsWith(".md") ||
        name.endsWith("opencode.json") ||
        name.endsWith("opencode.jsonc") ||
        doc.fileName.includes(`${path.sep}.opencode${path.sep}`)
      ) {
        refresh();
      }
    })
  );

  // Los configs cambian también fuera de VS Code (script, otro editor, git checkout),
  // así que además de al guardar se escucha el sistema de ficheros.
  const configWatchers = [
    vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(globalOpencodeDir()), "opencode.json*")
    ),
  ];
  const root = projectRoot();
  if (root) {
    configWatchers.push(
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(root), "**/opencode.json*")
      )
    );
  }
  for (const watcher of configWatchers) {
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(refresh),
      watcher.onDidCreate(refresh),
      watcher.onDidDelete(refresh)
    );
  }

  restartPolling();
  void refreshAgents();
  void refreshModels();
  void refreshStats(true);
  void refreshCatalog();

  // ── Voz ──────────────────────────────────────────────────────────────────
  const voiceProvider: vscode.WebviewViewProvider = {
    resolveWebviewView: async (view) => {
      voicePanel = new VozPanel(view, context);
      await voicePanel.init();
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VozPanel.viewId, voiceProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Panel inferior: dictado (voz a texto).
  const dictadoProvider: vscode.WebviewViewProvider = {
    resolveWebviewView: async (view) => {
      dictado = new VozDictado(view, context);
      await dictado.init();
    },
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VozDictado.viewId, dictadoProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("voz.dictado", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.vozDictado");
      await vscode.commands.executeCommand("workbench.action.focusView", VozDictado.viewId);
    }),

    // secondarySidebar no es un contenedor de vistas por defecto: hay que
    // revelarlo una vez para que el usuario vea el panel.
    vscode.commands.registerCommand("voz.focus", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.vozPanel");
      await vscode.commands.executeCommand("workbench.action.focusView", VozPanel.viewId);
    }),

    vscode.commands.registerCommand("voz.reveal", async () => {
      await vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
      await vscode.commands.executeCommand("workbench.view.extension.vozPanel");
      await vscode.commands.executeCommand("workbench.action.focusView", VozPanel.viewId);
    }),

    vscode.commands.registerCommand("voz.speak", async () => {
      const editor = vscode.window.activeTextEditor;
      const text = editor?.document.getText(editor.selection).trim();
      if (!text) {
        vscode.window.showWarningMessage("VOZ: selecciona el texto que quieres leer.");
        return;
      }
      await speak(text, vscode.workspace.getConfiguration("voz").get("engine", "sapi"));
    }),

    vscode.commands.registerCommand("voz.installMcp", async () => {
      await installMcp();
    })
  );

  // El MCP es otro proceso: necesita los ajustes en un fichero compartido.
  void syncSharedConfig();

  // Si los ajustes cambian fuera del panel (Settings o settings.json), el
  // fichero compartido y la interfaz deben seguirlos.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("voz")) return;
      void syncSharedConfig();
      voicePanel?.refresh();
    })
  );
}

export function deactivate(): void {
  voicePanel?.dispose();
  dictado?.dispose();
}

/** Habla con el servidor de opencode a través de su propio CLI: descubre la URL y la auth solo. */
function opencodeApi(method: string, route: string, body?: unknown): Promise<string> {
  const args = ["api", method, route];
  if (body !== undefined) {
    args.push("-d", JSON.stringify(body));
  }
  return new Promise((resolve, reject) => {
    execFile("opencode", args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        // El CLI cuenta el motivo por stderr; stdout queda vacío cuando falla.
        const detail = (stderr || stdout || err.message).trim();
        reject(new Error(detail.slice(0, 400) || "opencode no respondió"));
        return;
      }
      resolve(stdout);
    });
  });
}

/** ¿Existe el ejecutable en el PATH del host? `where` en Windows, `which` en el resto. */
function commandExists(bin: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(finder, [bin], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

/** Un modelo tal y como lo devuelve `GET /api/model`. */
interface ApiModel {
  modelID?: string;
  providerID?: string;
  name?: string;
  enabled?: boolean;
  cost?: Array<{ input?: number; output?: number }>;
}

async function pickScope(placeHolder: string): Promise<Scope | undefined> {
  const hasProject = !!projectRoot();
  const items: Array<vscode.QuickPickItem & { scope: Scope }> = [
    {
      label: "Proyecto",
      description: ".opencode/agent (solo este proyecto)",
      scope: "project",
      picked: hasProject,
    },
    {
      label: "Usuario",
      description: "~/.config/opencode/agent (global)",
      scope: "global",
      picked: !hasProject,
    },
  ];
  if (!hasProject) {
    items[0].description += " — sin proyecto abierto";
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder, title: "Scope" });
  return picked?.scope;
}

async function createAgent(
  context: vscode.ExtensionContext,
  defaultMode: AgentFrontmatter["mode"],
  onSaved: () => void
): Promise<void> {
  const config = await readConfigInfo();
  const name = await vscode.window.showInputBox({
    prompt: "Nombre del agente (se usará como nombre de fichero .md)",
    placeHolder: "mi-agente",
    validateInput: (v) => {
      if (!v.trim()) {
        return "El nombre es obligatorio";
      }
      const issues = validateAgentName(v.trim());
      const err = issues.find((i) => i.level === "error");
      return err ? err.message : undefined;
    },
  });
  if (!name) {
    return;
  }
  const trimmed = name.trim();
  const scope = await pickScope("¿Dónde crear el agente?");
  if (!scope) {
    return;
  }

  const existing = await findAgent(trimmed, scope);
  if (existing) {
    const choice = await vscode.window.showWarningMessage(
      `Ya existe un agente "${trimmed}" en ese scope. ¿Editarlo?`,
      { modal: true },
      "Editar"
    );
    if (choice === "Editar") {
      await EditorPanel.open(context, existing, { mode: "edit", onSaved });
    }
    return;
  }

  const fm: AgentFrontmatter = {};
  if (defaultMode) {
    fm.mode = defaultMode;
  }
  if (config.defaultModel) {
    fm.model = config.defaultModel;
  }
  if (defaultMode === "subagent") {
    fm.description = "";
  }

  const agent: Agent = {
    name: trimmed,
    scope,
    source: "file",
    frontmatter: fm,
    prompt: defaultMode === "subagent" ? "Eres un subagente especializado en..." : "",
  };

  await EditorPanel.open(context, agent, { mode: "create", onSaved });
}
