import * as vscode from "vscode";
import { Agent, AgentFrontmatter, BUILTIN_AGENTS, Scope } from "./agents/types";
import {
  AgentList,
  findAgent,
  listAgents,
  readConfigInfo,
  saveAgent,
  writeAtomic,
} from "./agents/store";
import { setAgentModel } from "./agents/assign";
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
import { AssignAction, AssignAgent, AssignData, AssignPanel } from "./panels/assignPanel";
import { ConnectorsPanel, ConnectorAction } from "./panels/connectorsPanel";
import {
  ConnectorAttempt,
  ConnectorService,
  ConnectorsData,
} from "./agents/connectors";
import { InstructionsPanel } from "./panels/instructionsPanel";
import { ClaudeAgentPanel } from "./panels/claudeAgentPanel";
import { StatsPanel } from "./panels/statsPanel";
import { ContextViewProvider } from "./panels/contextPanel";
import { VozPanel } from "./panels/voicePanel";
import { VozDictado } from "./panels/dictadoPanel";
import { speak, syncSharedConfig } from "./voice/service";
import { installMcp } from "./voice/mcpInstaller";
import { ContextWindowService } from "./stats/contextWindow";
import {
  emptyActivity,
  latestSessionTokens,
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
  claudeActivity,
  claudeAgentFile,
  claudeContext,
  claudeExplorer,
  claudeInstructionsFile,
  claudeLiveSessions,
  claudeModePresses,
  claudeModels,
  claudePermissionMode,
  claudeProviderCatalog,
  claudeSessionMode,
  clearClaudeModel,
  globalStateFile,
  refreshClaudeProvider,
  setClaudeAutoAccept,
  setClaudeItem,
  setClaudeModel,
  setClaudeSubagentModel,
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
  const FAVORITE_MODELS = "opencodeAgents.favoriteModels";
  const ASSIGN_SEARCH = "opencodeAgents.assignSearch";
  const ASSIGN_PROVIDERS_OFF = "opencodeAgents.assignProvidersOff";
  const CONNECTORS_SEARCH = "opencodeAgents.connectorsSearch";
  const CONNECTORS_SELECTED = "opencodeAgents.connectorsSelected";

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
    }),
    // El selector sigue a la pestaña activa: si el usuario se va a la de opencode, el panel
    // deja de mostrar Claude. Sin `show()` aquí: el evento rebotaría.
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      const agent = terminal ? agentOfTerminal(terminal) : undefined;
      if (!agent || agent === sessionAgent || !availableAgents.includes(agent)) {
        return;
      }
      sessionAgent = agent;
      void context.globalState.update(SESSION_AGENT_KEY, agent);
      refresh();
    })
  );

  /** Agente al que pertenece una terminal: por el mapa (incluida la `__new__` de opencode) o por nombre. */
  function agentOfTerminal(terminal: vscode.Terminal): SessionAgent | undefined {
    for (const [key, known] of sessionTerminals) {
      if (known === terminal) {
        return key === "__new__" ? "opencode" : (key as SessionAgent);
      }
    }
    const name = terminal.name.toLowerCase();
    if (name === "opencode") {
      return "opencode";
    }
    if (name === "codex") {
      return "codex";
    }
    if (
      name === "claude" ||
      claudeLiveSessions(projectRoot()).some((s) => s.name?.toLowerCase() === name)
    ) {
      return "claude";
    }
    return undefined;
  }

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

  /**
   * Abre (o enfoca) la terminal de un agente. Una por agente, pestaña del grupo activo:
   * se cambia con la pestaña de arriba, sin abrir un grupo al lado.
   */
  function openTerminal(key: string, name: string, cwd: string | undefined, command: string): void {
    let known: vscode.Terminal | undefined = sessionTerminals.get(key);
    try {
      if (known && known.exitStatus === undefined) {
        known.show();
        return;
      }
    } catch {
      // Terminal destruida sin pasar por `onDidCloseTerminal`: la entrada del mapa está muerta.
      known = undefined;
    }
    if (known) {
      // Proceso terminado pero la pestaña sigue: se cierra para no dejar una muerta al lado.
      known.dispose();
    }
    sessionTerminals.delete(key);
    // Terminal viva de antes (abierta a mano o antes de recargar el host): se adopta.
    const live = name === "claude" ? claudeTerminal() : runningTerminal(name);
    if (live) {
      sessionTerminals.set(key, live);
      live.show();
      return;
    }
    const location = { viewColumn: vscode.ViewColumn.Active };
    const terminal = vscode.window.createTerminal(
      cwd ? { name, cwd, location } : { name, location }
    );
    terminal.show();
    terminal.sendText(command);
    sessionTerminals.set(key, terminal);
  }

  /** Terminal viva con alguno de esos nombres: también las abiertas a mano o antes de recargar. */
  function runningTerminal(...ids: string[]): vscode.Terminal | undefined {
    const names = ids.map((id) => id.toLowerCase());
    return vscode.window.terminals.find(
      (t) => t.exitStatus === undefined && names.includes(t.name.toLowerCase())
    );
  }

  /**
   * Último modo que dejamos en la terminal de Claude. Vale solo mientras el transcript
   * siga en la misma posición: en cuanto el CLI anota otro turno, manda el transcript.
   */
  let claudeModeMemo:
    | { sessionId: string; mode: string; offset: number | undefined }
    | undefined;

  /**
   * Terminal de la sesión viva de Claude. Claude pone a la terminal el `name` de su sesión,
   * así que el nombre "claude" se pierde: hay que probar también esos títulos.
   */
  function claudeTerminal(
    live = claudeLiveSessions(projectRoot())
  ): vscode.Terminal | undefined {
    const titles = live.map((session) => session.name).filter((name): name is string => !!name);
    return runningTerminal("claude", ...titles);
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
  const connectorsService = new ConnectorService(opencodeApi);
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
  let favoriteModels: string[] = context.globalState.get<string[]>(FAVORITE_MODELS, []);
  // Vista del tablero de asignación: el buscador y los conectores apagados sobreviven al cierre.
  let assignSearch: string = context.globalState.get<string>(ASSIGN_SEARCH, "");
  let assignProvidersOff: string[] = context.globalState.get<string[]>(ASSIGN_PROVIDERS_OFF, []);
  // Vista del panel de conectores: selección y buscador sobreviven al cierre.
  let connectorsSearch: string = context.globalState.get<string>(CONNECTORS_SEARCH, "");
  let connectorsSelected: string = context.globalState.get<string>(CONNECTORS_SELECTED, "");
  let connectorsData: ConnectorsData | undefined;
  let connectorAttempt:
    | { id: string; attemptID: string; kind: "oauth" | "command"; timer?: ReturnType<typeof setTimeout> }
    | undefined;

  const refresh = () => {
    if (sessionAgent !== "opencode") {
      AssignPanel.close();
      ConnectorsPanel.close();
    }
    void refreshAgents();
    void refreshCatalog();
    void refreshModels();
    void refreshStats(true);
    explorer.update(buildExplorerData());
  };

  /** Agente en la forma que pinta el explorador, con su actividad en vivo. */
  function explorerAgent(agent: Agent, sessionTokens: Map<string, number>): ExplorerAgent {
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
      // El histórico es el total (ya con el reinicio de contadores aplicado); la sesión, la
      // última suya en la BD, que no pasa por el reinicio. Sin dato, 0.
      tokensTotal: act?.tokens.total ?? 0,
      tokensSession: sessionTokens.get(agent.name) ?? 0,
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
      const terminal = sessionAgent === "claude" ? claudeTerminal() : runningTerminal(sessionAgent);
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
      return { ...claudeModels(projectRoot()), recentModels: [], canAssign: false };
    }
    if (sessionAgent === "codex") {
      return { ...codexModels(), recentModels: [], canAssign: false };
    }
    const snapshot = display ?? lastRaw;
    return {
      models,
      currentModel: snapshot ? (pickSession(snapshot)?.model ?? "") : "",
      recentModels: recentModelIds(),
      canAssign: sessionAgent === "opencode",
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
        // Claude no guarda coste ni duración de trabajo: solo entran sus tokens.
        totals: { tokens: claude.tokens.total, workMs: 0, cost: 0, working: claude.activity.length },
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
        // Codex tampoco: sus rollouts solo traen tokens.
        totals: { tokens: codex.tokens.total, workMs: 0, cost: 0, working: 0 },
        autoAccept: codex.autoAccept,
        sessionAgent,
        sessionAgents: availableAgents,
      };
    }
    const totals = display?.totals;
    const root = projectRoot();
    // Mismo criterio que `pickSession`: la sesión de otro proyecto no cuenta en estas tarjetas.
    const sessionTokens = latestSessionTokens(
      (display?.sessions ?? []).filter((s) => !!root && isSamePath(s.directory, root))
    );
    return {
      hasProject: !!projectRoot(),
      agents: {
        project: agentList.project.map((a) => explorerAgent(a, sessionTokens)),
        global: agentList.global.map((a) => explorerAgent(a, sessionTokens)),
        builtin: agentList.builtins.map((a) => explorerAgent(a, sessionTokens)),
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

  /** Catálogo del proveedor de Claude: se pide en segundo plano y solo repinta si cambió. */
  let claudeCatalogKey = "";
  function refreshClaudeCatalog(): void {
    if (sessionAgent !== "claude") {
      return;
    }
    void refreshClaudeProvider().then(() => {
      const key = JSON.stringify(claudeProviderCatalog() ?? null);
      if (sessionAgent !== "claude" || key === claudeCatalogKey) {
        return;
      }
      claudeCatalogKey = key;
      modelsView.update(modelsData());
    });
  }

  /** Lista viva de opencode: `readConfigInfo` incluiría modelos vetados o deshabilitados. */
  async function refreshModels(): Promise<void> {
    if (sessionAgent !== "opencode") {
      // Claude y Codex no tienen API local de modelos: se pinta su catálogo y ya.
      modelsView.update(modelsData());
      // El del proveedor se consulta aparte; sin red no cambia nada.
      refreshClaudeCatalog();
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
    AssignPanel.current?.update(assignData());
  }

  /** Scope donde vive el override del integrado, si existe (project > global). */
  function builtinOverrideScope(name: string): Scope | undefined {
    if (agentList.project.some((a) => a.name === name)) {
      return "project";
    }
    return agentList.global.some((a) => a.name === name) ? "global" : undefined;
  }

  /** Agentes con su modelo y el catálogo vivo, en la forma que pinta el panel de asignación. */
  function assignData(): AssignData {
    const row = (agent: Agent, scope: "project" | "global"): AssignAgent => {
      const description = (agent.frontmatter.description ?? "").trim();
      const label = scope === "project" ? "proyecto" : "global";
      return {
        name: agent.name,
        scope,
        model: agent.frontmatter.model ?? "",
        detail:
          description ||
          (agent.shadowed ? `${label} · sombreado por proyecto` : label),
      };
    };
    // El `.md` que sobrescribe un integrado ya sale en su fila INTEGRADO: no se repite.
    const builtinNames = new Set<string>(BUILTIN_AGENTS);
    const agents: AssignAgent[] = [
      ...agentList.project.filter((a) => !builtinNames.has(a.name)).map((a) => row(a, "project")),
      ...agentList.global.filter((a) => !builtinNames.has(a.name)).map((a) => row(a, "global")),
    ];
    // Los cuatro integrados siempre salen: el override se resuelve sin `agentList.builtins`.
    for (const name of BUILTIN_AGENTS) {
      const overrideScope = builtinOverrideScope(name);
      const override = overrideScope
        ? (overrideScope === "project" ? agentList.project : agentList.global).find(
            (a) => a.name === name
          )
        : undefined;
      agents.push({
        name,
        scope: "builtin",
        model: override?.frontmatter.model ?? "",
        detail:
          overrideScope === "project"
            ? "sobrescrito por proyecto"
            : overrideScope === "global"
              ? "sobrescrito por global"
              : "integrado",
      });
    }
    return {
      agents,
      models,
      favorites: favoriteModels.filter((id) => models.some((m) => m.id === id)),
      search: assignSearch,
      disabledProviders: assignProvidersOff,
    };
  }

  async function openAssignPanel(): Promise<void> {
    if (sessionAgent !== "opencode") {
      void vscode.window.showWarningMessage(
        "La asignación de agentes a modelos es solo de opencode."
      );
      return;
    }
    if (models.length === 0) {
      await refreshModels();
    }
    // Los modelos que ya tienen los agentes entran en favoritos: así el tablero dibuja su
    // línea al abrir y quitarlos es arrastrarlos, sin buscarlos antes.
    const assigned = new Set(assignData().agents.map((a) => a.model));
    const added = [...assigned].filter(
      (id) => id && models.some((m) => m.id === id) && !favoriteModels.includes(id)
    );
    if (added.length > 0) {
      favoriteModels = [...favoriteModels, ...added];
      await context.globalState.update(FAVORITE_MODELS, favoriteModels);
    }
    AssignPanel.open(context, assignData(), {
      onAction: handleAssignAction,
      onReady: () => AssignPanel.current?.update(assignData()),
    });
  }

  async function handleAssignAction(action: AssignAction): Promise<void> {
    if (action.type === "toggleFavorite") {
      favoriteModels = action.on
        ? [...favoriteModels.filter((id) => id !== action.id), action.id]
        : favoriteModels.filter((id) => id !== action.id);
      await context.globalState.update(FAVORITE_MODELS, favoriteModels);
      AssignPanel.current?.update(assignData());
      return;
    }
    if (action.type === "persistView") {
      if (
        typeof action.search !== "string" ||
        !Array.isArray(action.disabledProviders) ||
        action.disabledProviders.some((p) => typeof p !== "string")
      ) {
        return;
      }
      const offKey = action.disabledProviders.join("\u0000");
      if (action.search !== assignSearch) {
        assignSearch = action.search;
        await context.globalState.update(ASSIGN_SEARCH, assignSearch);
      }
      if (offKey !== assignProvidersOff.join("\u0000")) {
        assignProvidersOff = [...action.disabledProviders];
        await context.globalState.update(ASSIGN_PROVIDERS_OFF, assignProvidersOff);
      }
      // Sin repintar: el usuario está escribiendo en el buscador.
      return;
    }
    if (action.type !== "assign" && action.type !== "clear") {
      return;
    }
    const model = action.type === "assign" ? action.model : "";
    if (action.scope === "builtin" && !(BUILTIN_AGENTS as readonly string[]).includes(action.agent)) {
      return;
    }
    if (model !== "" && !models.some((m) => m.id === model)) {
      return;
    }
    const modelLabel = models.find((m) => m.id === model)?.name ?? model;
    try {
      const target =
        action.scope === "builtin" ? builtinOverrideScope(action.agent) : action.scope;
      let notice: string;
      if (!target) {
        // Integrado sin override: no hay modelo que borrar.
        if (!model) {
          return;
        }
        const scope = await pickScope("¿Dónde crear el override del integrado?");
        if (!scope) {
          return;
        }
        await saveAgent(scope, action.agent, { model }, "", undefined);
        notice = `opencode: «${action.agent}.md» sobrescribe al integrado con «${modelLabel}»; opencode lo recarga al guardar.`;
      } else {
        const agent = await findAgent(action.agent, target);
        if (!agent) {
          void vscode.window.showWarningMessage(
            `No hay ningún agente "${action.agent}" en ese scope.`
          );
          return;
        }
        await setAgentModel(agent, model);
        notice = model
          ? `opencode: «${agent.name}» usará «${modelLabel}».`
          : `opencode: «${agent.name}» sin modelo fijado.`;
      }
      await refreshAgents();
      void vscode.window.setStatusBarMessage(notice, 6000);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo asignar el modelo: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Último catálogo de conectores, con la selección y la búsqueda recordadas. */
  async function collectConnectors(refresh: boolean): Promise<ConnectorsData> {
    const data = await connectorsService.collect({
      selected: connectorsSelected,
      search: connectorsSearch,
      refresh,
    });
    if (data.selected !== connectorsSelected) {
      connectorsSelected = data.selected;
      await context.globalState.update(CONNECTORS_SELECTED, connectorsSelected);
    }
    connectorsData = data;
    return data;
  }

  async function openConnectorsPanel(): Promise<void> {
    if (sessionAgent !== "opencode") {
      void vscode.window.showWarningMessage("Los conectores son solo de opencode.");
      return;
    }
    let data: ConnectorsData;
    try {
      data = await collectConnectors(true);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudieron leer los conectores: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    ConnectorsPanel.open(context, data, {
      onAction: handleConnectorAction,
      // Al abrir ya se leyó el catálogo; solo se refresca si el panel se montó sin datos.
      onReady: () => {
        if (!connectorsData) void refreshConnectorsPanel();
      },
      onClosed: () => clearConnectorAttempt(),
    });
  }

  async function refreshConnectorsPanel(): Promise<void> {
    const panel = ConnectorsPanel.current;
    if (!panel) {
      return;
    }
    try {
      panel.update(await collectConnectors(true));
    } catch (err) {
      panel.postNotice(
        "error",
        `No se pudieron leer los conectores: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleConnectorAction(action: ConnectorAction): Promise<void> {
    const panel = ConnectorsPanel.current;
    const notice = (level: "info" | "error", text: string): void => panel?.postNotice(level, text);
    const fail = (err: unknown): void =>
      notice("error", err instanceof Error ? err.message : String(err));

    switch (action.type) {
      case "select": {
        connectorsSelected = action.id;
        try {
          const data = await collectConnectors(false);
          await context.globalState.update(CONNECTORS_SELECTED, connectorsSelected);
          panel?.update(data);
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "persistView":
        if (action.search !== connectorsSearch) {
          connectorsSearch = action.search;
          await context.globalState.update(CONNECTORS_SEARCH, connectorsSearch);
        }
        return;

      case "refresh":
        await refreshConnectorsPanel();
        return;

      case "toggle": {
        try {
          await connectorsService.toggle(action.id, action.on);
          const data = await collectConnectors(true);
          panel?.update(data);
          const name = data.connectors.find((c) => c.id === action.id)?.name ?? action.id;
          notice(
            "info",
            action.on
              ? `«${name}» activado.`
              : `«${name}» desactivado: opencode deja de ofrecerlo; credenciales y configuración se conservan.`
          );
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "remove": {
        const entry = connectorsData?.connectors.find((c) => c.id === action.id);
        if (!entry) {
          return;
        }
        const credentials = entry.connections.filter((c) => c.type === "credential").length;
        const envs = entry.connections
          .filter((c) => c.type === "env")
          .map((c) => c.label)
          .filter((label) => !!label);
        const files = entry.configFiles.map((file) => path.basename(file));
        if (credentials === 0 && files.length === 0) {
          // Sin credenciales ni config no hay nada que borrar desde aquí.
          notice(
            "info",
            envs.length > 0
              ? `«${entry.name}» solo tiene variables de entorno (${envs.join(", ")}): se quitan en el servidor de opencode.`
              : `«${entry.name}» no tiene credenciales ni configuración que eliminar.`
          );
          return;
        }
        const detail = [
          credentials > 0 ? `${credentials} credencial(es)` : "",
          files.length > 0 ? `configuración en ${files.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" y ");
        const kept =
          envs.length > 0
            ? ` Las variables de entorno (${envs.join(", ")}) no se pueden borrar desde aquí.`
            : "";
        const choice = await vscode.window.showWarningMessage(
          `¿Eliminar «${entry.name}»? Se borran ${detail}.${kept}`,
          { modal: true },
          "Eliminar"
        );
        if (choice !== "Eliminar") {
          return;
        }
        try {
          const result = await connectorsService.remove(action.id);
          panel?.update(await collectConnectors(true));
          const done: string[] = [];
          if (result.credentialsRemoved > 0) {
            done.push(`${result.credentialsRemoved} credencial(es)`);
          }
          if (result.configFilesChanged.length > 0) {
            done.push(
              `configuración de ${result.configFilesChanged.map((f) => path.basename(f)).join(", ")}`
            );
          }
          if (result.envKept.length > 0) {
            done.push(`variables de entorno sin tocar (${result.envKept.join(", ")})`);
          }
          const head =
            done.length > 0
              ? `«${entry.name}»: eliminado ${done.join("; ")}.`
              : `«${entry.name}»: no se borró nada.`;
          notice(result.errors.length > 0 ? "error" : "info", [head, ...result.errors].join(" "));
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "connectKey":
      case "connectExternal": {
        try {
          if (action.type === "connectKey") {
            await connectorsService.connectKey(action.id, action.key, action.answer);
          } else {
            await connectorsService.connectExternal(action.id, action.methodID, action.answer);
          }
          const data = await collectConnectors(true);
          panel?.update(data);
          notice("info", "Conector añadido.");
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "startOauth": {
        try {
          trackConnectorAttempt(
            await connectorsService.startOauth(action.id, action.methodID, action.answer)
          );
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "completeOauth": {
        try {
          await connectorsService.completeOauth(action.id, action.attemptID, action.code);
          clearConnectorAttempt();
          panel?.postAttempt({
            id: action.id,
            attemptID: action.attemptID,
            kind: "oauth",
            status: "complete",
          });
          await refreshConnectorsPanel();
          notice("info", "Autorización completada.");
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "cancelAttempt": {
        try {
          // El intento pudo nacer de un comando: se usa su clase para llamar al endpoint correcto.
          const kind =
            action.kind ??
            (connectorAttempt?.attemptID === action.attemptID ? connectorAttempt.kind : "oauth");
          await (kind === "command"
            ? connectorsService.cancelCommand(action.id, action.attemptID)
            : connectorsService.cancelOauth(action.id, action.attemptID));
          clearConnectorAttempt();
          panel?.postAttempt({
            id: action.id,
            attemptID: action.attemptID,
            kind,
            status: "cancelled",
          });
          notice("info", "Intento cancelado.");
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "startCommand": {
        try {
          trackConnectorAttempt(await connectorsService.startCommand(action.id, action.methodID));
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "openUrl": {
        if (!/^https?:\/\//.test(action.url)) {
          return;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.parse(action.url));
        } catch (err) {
          fail(err);
        }
        return;
      }

      case "close":
        // Lo cierra el panel; aquí no llega.
        return;
    }
  }

  /** Sondeos de autorización hasta 5 min: 150 vueltas cada 2 s. */
  const ATTEMPT_POLL_MS = 2000;
  const ATTEMPT_POLL_TRIES = 150;

  function trackConnectorAttempt(attempt: ConnectorAttempt): void {
    clearConnectorAttempt();
    // Sin panel nadie vería el intento: cerrar mientras se iniciaba corta el sondeo.
    if (!ConnectorsPanel.current) {
      return;
    }
    connectorAttempt = { id: attempt.id, attemptID: attempt.attemptID, kind: attempt.kind };
    ConnectorsPanel.current?.postAttempt(attempt);
    // El modo `code` espera a que el usuario pegue el código: sondear repintaría el campo.
    if (attempt.status !== "pending" || attempt.mode === "code") {
      return;
    }
    const { id, attemptID, kind } = attempt;
    connectorAttempt.timer = setTimeout(() => void pollConnectorAttempt(kind, id, attemptID, 0), 1000);
  }

  async function pollConnectorAttempt(
    kind: "oauth" | "command",
    id: string,
    attemptID: string,
    tries: number
  ): Promise<void> {
    if (connectorAttempt?.attemptID !== attemptID) {
      return; // cancelado o sustituido por otro intento
    }
    let attempt: ConnectorAttempt;
    try {
      attempt =
        kind === "oauth"
          ? await connectorsService.oauthStatus(id, attemptID)
          : await connectorsService.commandStatus(id, attemptID);
    } catch (err) {
      // Un fallo de red repetido sería un bucle infinito: se corta y se avisa.
      clearConnectorAttempt();
      ConnectorsPanel.current?.postNotice(
        "error",
        err instanceof Error ? err.message : String(err)
      );
      return;
    }
    if (connectorAttempt?.attemptID !== attemptID) {
      return;
    }
    ConnectorsPanel.current?.postAttempt(attempt);
    if (attempt.status === "pending") {
      if (tries >= ATTEMPT_POLL_TRIES) {
        clearConnectorAttempt();
        ConnectorsPanel.current?.postAttempt({
          id,
          attemptID,
          kind,
          status: "expired",
          message: "La autorización caducó sin respuesta. Vuelve a iniciarla.",
        });
        return;
      }
      connectorAttempt.timer = setTimeout(
        () => void pollConnectorAttempt(kind, id, attemptID, tries + 1),
        ATTEMPT_POLL_MS
      );
      return;
    }
    clearConnectorAttempt();
    if (attempt.status === "complete") {
      await refreshConnectorsPanel();
      ConnectorsPanel.current?.postNotice("info", "Conector añadido.");
      return;
    }
    ConnectorsPanel.current?.postNotice(
      "error",
      attempt.message || "No se pudo completar la autorización."
    );
  }

  function clearConnectorAttempt(): void {
    if (connectorAttempt?.timer) {
      clearTimeout(connectorAttempt.timer);
    }
    connectorAttempt = undefined;
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
      // Codex no publica agentes en vuelo; Claude los saca de su registro de sesiones.
      voicePanel?.updateAgents(
        sessionAgent === "claude"
          ? claudeActivity(projectRoot()).map((a) => ({ name: a.agent, streaming: a.streaming }))
          : []
      );
      // El catálogo del proveedor va por su caché: el sondeo no dispara red cada vez.
      refreshClaudeCatalog();
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

    vscode.commands.registerCommand("opencodeAgents.assignModels", () =>
      void openAssignPanel()
    ),

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
   * Abre las instrucciones de Claude del scope pedido. En proyecto, si no hay ni CLAUDE.md
   * ni AGENTS.md (Claude Code no tiene nada que cargar) se ofrece crearlo; no se escribe
   * a la fuerza. En global se mantiene la creación silenciosa de siempre.
   */
  async function openClaudeInstructions(scope: Scope): Promise<void> {
    if (scope === "project" && !projectRoot()) {
      void vscode.window.showWarningMessage(
        "Abre una carpeta de proyecto para editar su CLAUDE.md."
      );
      return;
    }
    const file = claudeInstructionsFile(scope, projectRoot());
    if (existsSync(file)) {
      await openFile(file);
      return;
    }
    if (scope === "project") {
      const crear = "Crear CLAUDE.md";
      const choice = await vscode.window.showInformationMessage(
        "El proyecto no tiene CLAUDE.md ni AGENTS.md.",
        crear
      );
      if (choice !== crear) {
        return;
      }
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeAtomic(file, "");
    } catch (err) {
      void vscode.window.showErrorMessage(
        `No se pudo crear ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    await openFile(file);
  }

  /**
   * Acciones del Explorador cuando el proveedor elegido es Claude. Devuelve true si la
   * acción era suya; las que no lo son siguen el camino de opencode.
   */
  async function handleClaudeAction(action: ExplorerAction | ModelsAction): Promise<boolean> {
    switch (action.type) {
      case "editAgent":
      case "openAgentFile": {
        if (action.scope === "builtin") {
          // La fila CLAUDE es la sesión principal: su fichero son las instrucciones.
          await openClaudeInstructions(projectRoot() ? "project" : "global");
          return true;
        }
        const file = claudeAgentFile(action.name, action.scope, projectRoot());
        if (file && existsSync(file)) {
          if (action.type === "editAgent") {
            // El editor rico de opencode no sirve aquí: los campos de un subagente de
            // Claude (tools, permissionMode, effort…) no existen en opencode.
            await ClaudeAgentPanel.open(context, {
              mode: "edit",
              name: action.name,
              scope: action.scope,
              filePath: file,
              projectRoot: projectRoot(),
              onSaved: refresh,
            });
          } else {
            await openFile(file);
          }
        } else {
          void vscode.window.showWarningMessage(
            "No encuentro el fichero de ese agente de Claude."
          );
        }
        return true;
      }

      case "createAgent": {
        // El nombre se pide dentro del formulario, no en un input box.
        await ClaudeAgentPanel.open(context, {
          mode: "create",
          scope: projectRoot() ? "project" : "global",
          projectRoot: projectRoot(),
          onSaved: refresh,
        });
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
        if (isMcp && item.filePath && isSamePath(item.filePath, globalStateFile())) {
          // Usuarios y locales no tienen interruptor en settings: se le pide a la sesión
          // viva (`/mcp disable|enable`), que lo guarda por proyecto. ~/.claude.json no
          // se escribe a mano (guarda la cuenta).
          const live = claudeLiveSessions(projectRoot());
          const terminal = claudeTerminal(live);
          if (!terminal) {
            void vscode.window.showWarningMessage(
              "Abre una sesión de Claude de este proyecto para activar o desactivar sus MCP."
            );
            return true;
          }
          const session =
            live.find((s) => s.name && s.name.toLowerCase() === terminal.name.toLowerCase()) ??
            live[0];
          // Con un diálogo abierto, el texto y el Enter caerían en él: no se inyecta.
          if (session?.status === "waiting") {
            void vscode.window.setStatusBarMessage(
              "Claude tiene un diálogo abierto: respóndelo y vuelve a alternar el MCP.",
              5000
            );
            return true;
          }
          terminal.sendText(`/mcp ${item.enabled ? "disable" : "enable"} ${item.name}`);
          void vscode.window.setStatusBarMessage(
            `Claude: ${item.enabled ? "desactivación" : "activación"} de "${item.name}" pedida a la sesión.`,
            4000
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

      case "setAutoAccept": {
        const root = projectRoot();
        const live = claudeLiveSessions(root);
        const terminal = claudeTerminal(live);
        const session =
          live.find((s) => s.name && s.name.toLowerCase() === terminal?.name.toLowerCase()) ??
          live[0];
        // Con un diálogo abierto, Shift+Tab cicla sus opciones en vez del modo: no se toca.
        if (terminal && session?.status === "waiting") {
          void vscode.window.setStatusBarMessage(
            "Claude tiene un diálogo abierto: respóndelo y vuelve a alternar los permisos.",
            5000
          );
          return true;
        }
        // El modo vivo se lee del transcript; si aún no hay evento, del ajuste guardado.
        // El memo cubre lo que el transcript tarda un turno en reflejar.
        const liveMode = session ? claudeSessionMode(root, session.sessionId) : undefined;
        const previous =
          session &&
          claudeModeMemo?.sessionId === session.sessionId &&
          claudeModeMemo.offset === liveMode?.offset
            ? claudeModeMemo.mode
            : liveMode?.mode ?? claudePermissionMode();
        try {
          await setClaudeAutoAccept(action.on);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar los permisos: ${err instanceof Error ? err.message : String(err)}`
          );
          return true;
        }
        refresh();
        // Claude no expone el modo por API: se pulsa Shift+Tab en su terminal, el mismo
        // ciclo del CLI (`auto → default → acceptEdits → plan → auto`).
        if (terminal && session) {
          const target = action.on ? "auto" : "default";
          const presses = previous ? claudeModePresses(previous, target) : undefined;
          if (presses !== undefined) {
            for (let i = 0; i < presses; i++) {
              terminal.sendText("\x1b[Z", false);
              await new Promise((resolve) => setTimeout(resolve, 120));
            }
            claudeModeMemo = {
              sessionId: session.sessionId,
              mode: target,
              offset: liveMode?.offset,
            };
            void vscode.window.setStatusBarMessage(
              presses === 0
                ? `Claude ya estaba en modo ${action.on ? "automático" : "manual"}.`
                : `Claude: permisos en modo ${action.on ? "automático" : "manual"}.`,
              4000
            );
          } else {
            // Sin saber el modo vivo no se cicla a ciegas: queda para la próxima sesión.
            void vscode.window.setStatusBarMessage(
              "Claude aplicará el modo al abrir una sesión nueva.",
              4000
            );
          }
        }
        return true;
      }

      case "editInstructions": {
        await openClaudeInstructions(action.scope);
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
        const root = projectRoot();
        // Si la terminal de ese agente ya vive, es en la que el usuario trabaja: se enfoca.
        // Claude renombra la suya con el título de la sesión, así que se buscan ambos.
        const live = sessionAgent === "claude" ? claudeLiveSessions(root) : [];
        const terminal = sessionAgent === "claude" ? claudeTerminal(live) : runningTerminal(sessionAgent);
        if (terminal) {
          terminal.show();
          return;
        }
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
        if (sessionAgent === "claude") {
          // `--continue` abre la conversación más reciente del directorio; solo el id de la
          // sesión viva garantiza abrir exactamente la que el usuario tiene delante.
          const id = live[0]?.sessionId;
          openTerminal("claude", "claude", root, id ? `claude --resume ${id}` : "claude --continue");
          return;
        }
        const codexId = codexContext(root).sessionId;
        openTerminal(
          "codex",
          "codex",
          root,
          codexId ? `codex resume ${codexId}` : "codex resume --last"
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

      case "openAssign":
        await openAssignPanel();
        return;

      case "openConnectors":
        await openConnectorsPanel();
        return;

      case "setModel": {
        if (typeof action.id !== "string") {
          return;
        }
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

      // Los tres solo existen con Claude: opencode y Codex no tienen modelo «sin fijar».
      case "clearModel": {
        if (sessionAgent !== "claude") {
          return;
        }
        try {
          await clearClaudeModel();
          refresh();
          // Sin el `env` del fichero puede seguir mandando el del sistema: la nota lo dice.
          void vscode.window.setStatusBarMessage(
            "Claude: modelo sin fijar en settings.json.",
            4000
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar el modelo: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      case "setSubagentModel": {
        if (sessionAgent !== "claude" || typeof action.id !== "string") {
          return;
        }
        const name = action.id.slice(action.id.indexOf("/") + 1);
        try {
          await setClaudeSubagentModel(action.id);
          refresh();
          void vscode.window.setStatusBarMessage(
            `Claude: subagentes con «${name}»; se aplica a las sesiones nuevas.`,
            4000
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar el modelo de los subagentes: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      case "clearSubagentModel": {
        if (sessionAgent !== "claude") {
          return;
        }
        try {
          await setClaudeSubagentModel(undefined);
          refresh();
          void vscode.window.setStatusBarMessage(
            "Claude: modelo de subagentes sin fijar en settings.json.",
            4000
          );
        } catch (err) {
          void vscode.window.showErrorMessage(
            `No se pudo cambiar el modelo de los subagentes: ${err instanceof Error ? err.message : String(err)}`
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
