/* ALFRED // CONTROL — pinta el explorador y manda acciones a la extensión. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    banner: document.getElementById("banner"),
    global: document.getElementById("btn-global"),
    local: document.getElementById("btn-local"),
    addPlugin: document.getElementById("btn-add-plugin"),
    assign: document.getElementById("btn-assign"),
    agentsProject: document.getElementById("agents-project"),
    agentsGlobal: document.getElementById("agents-global"),
    agentsProjectCount: document.getElementById("agents-project-count"),
    agentsGlobalCount: document.getElementById("agents-global-count"),
    agentsTotal: document.getElementById("agents-total"),
    mcpGlobal: document.getElementById("mcp-global"),
    mcpProject: document.getElementById("mcp-project"),
    mcpGlobalCount: document.getElementById("mcp-global-count"),
    mcpProjectCount: document.getElementById("mcp-project-count"),
    skillsGlobal: document.getElementById("skills-global"),
    skillsProject: document.getElementById("skills-project"),
    skillsGlobalCount: document.getElementById("skills-global-count"),
    skillsProjectCount: document.getElementById("skills-project-count"),
    pluginsGlobal: document.getElementById("plugins-global"),
    pluginsProject: document.getElementById("plugins-project"),
    pluginsGlobalCount: document.getElementById("plugins-global-count"),
    pluginsProjectCount: document.getElementById("plugins-project-count"),
    autoAcceptBtn: document.getElementById("btn-auto-accept"),
    permState: document.getElementById("perm-state"),
  };

  // opencode no admite estos integrados como agente de sesión (solo se invocan como
  // subagente): el botón ❯ fallaría siempre, así que no se pinta en sus filas.
  const NO_ACTIVABLES = new Set(["explore", "general"]);

  // Fichero de instrucciones que abre cada botón del mando: opencode y Codex escriben
  // AGENTS.md, Claude CLAUDE.md. Un proveedor desconocido cae al de opencode.
  const AGENT_FILE = { opencode: "AGENTS.md", codex: "AGENTS.md", claude: "CLAUDE.md" };

  // Solo opencode sabe activar un agente en su sesión viva: el botón de activar depende de esto.
  // Lo fija `renderAgents` en cada render, antes de pintar las filas.
  let esOpencode = false;

  function act(action) {
    vscode.postMessage({ type: "action", action });
  }

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // Misma escala que media/stats.js y src/stats/format.ts.
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
    return (n / 1e9).toFixed(2) + "B";
  }

  function fmtDuration(ms) {
    ms = Number(ms) || 0;
    if (ms <= 0) return "0s";
    const t = Math.round(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + s + "s";
    return s + "s";
  }

  /** Solo se tiñe con hex de 6 dígitos: lo demás cae al color del modo. */
  function isHex(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  /** Tarjeta de una línea: icono, nombre, modelo, trabajo, tokens y VER.
   * `extraClass` (opcional) añade la clase del icono según la fila: el integrado con
   * override en el proyecto lleva su marca. No se toca `agent.mode`, que va en el title del VER. */
  function agentRow(agent, extraClass) {
    const card = node("div", "agent");
    if (agent.working) card.classList.add("working");
    if (agent.streaming) card.classList.add("streaming");
    if (agent.disabled) card.classList.add("disabled");

    const extra = extraClass ? extraClass(agent) : "";
    const icon = node(
      "span",
      "agent-icon mode-" + (agent.mode || "primary") + (extra ? " " + extra : "")
    );
    icon.setAttribute("aria-hidden", "true");
    if (isHex(agent.color)) icon.style.setProperty("--agent-color", agent.color);
    card.appendChild(icon);

    const name = node("span", "agent-name");
    name.appendChild(node("span", "agent-label", agent.name));
    if (agent.disabled) name.appendChild(node("span", "chip off", "OFF"));
    if (agent.shadowed) name.appendChild(node("span", "chip", "SOMBRA"));
    if (agent.overriddenBy && agent.overriddenBy.length > 0) {
      name.appendChild(node("span", "chip", "SOBRESCRITO"));
    }
    card.appendChild(name);

    const sub = [agent.mode, agent.model].filter(Boolean).join(" · ");
    if (agent.model) {
      const model = node("span", "agent-model", agent.model);
      model.title = "Modelo: " + agent.model;
      card.appendChild(model);
    }

    // Efecto de trabajo: las barras del HUD mientras trabaja; en reposo no se pinta nada.
    if (agent.working || agent.streaming) {
      const work = node("span", "work");
      work.title = agent.streaming ? "Trabajando (en streaming)" : "Trabajando";
      const bars = node("span", "bars");
      bars.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i++) bars.appendChild(node("i"));
      work.appendChild(bars);
      card.appendChild(work);
    }

    // Contrato nuevo del host: histórico / última sesión. Sin datos todavía se leen como 0.
    const total = Number(agent.tokensTotal) || 0;
    const session = Number(agent.tokensSession) || 0;
    const tokens = node(
      "span",
      "agent-tokens",
      total > 0 || session > 0 ? fmtTokens(total) + "/" + fmtTokens(session) : "—"
    );
    tokens.title = "Tokens históricos / tokens de la última sesión";
    card.appendChild(tokens);

    const ver = node("button", "mini", "VER");
    ver.type = "button";
    ver.title = "Editar " + agent.name + (sub ? " — " + sub : "");
    ver.addEventListener("click", () =>
      act({ type: "editAgent", name: agent.name, scope: agent.scope })
    );

    // VER va pegado al borde derecho: el contenedor es el que lleva `margin-left: auto`.
    const acciones = node("div", "agent-actions");
    // Activar en la sesión viva de opencode (la TUI); va antes de VER y solo con ese proveedor.
    // Un subagente no puede ser el agente de la sesión: sin botón (los integrados subagentes
    // vienen sin `mode` y caen en NO_ACTIVABLES).
    if (esOpencode && agent.mode !== "subagent" && !NO_ACTIVABLES.has(agent.name)) {
      const activar = node("button", "mini", "❯");
      activar.type = "button";
      activar.title = "Activar " + agent.name + " en la sesión de opencode";
      activar.setAttribute("aria-label", activar.title);
      activar.addEventListener("click", () =>
        act({ type: "activateAgent", name: agent.name })
      );
      acciones.appendChild(activar);
    }
    acciones.appendChild(ver);
    card.appendChild(acciones);

    return card;
  }

  function fillAgents(box, list, emptyText, extraClass) {
    box.textContent = "";
    if (list.length === 0) {
      box.appendChild(node("div", "empty", emptyText));
      return;
    }
    for (const agent of list) box.appendChild(agentRow(agent, extraClass));
  }

  function renderAgents(data) {
    // El botón de activar solo tiene sentido con opencode; se fija antes de pintar las filas.
    esOpencode = data.sessionAgent === "opencode";
    const agents = data.agents || {};
    const builtin = agents.builtin || [];

    // Los integrados salen del mismo array en los dos bloques, según dónde tengan su override:
    // con `.md` en el proyecto van con los de proyecto; los demás (override global o ninguno), con los globales.
    const projectBuiltins = builtin.filter((a) => (a.overriddenBy || []).includes("project"));
    const globalBuiltins = builtin.filter((a) => !projectBuiltins.includes(a));
    // El `.md` que sobrescribe un integrado ya sale en su fila INTEGRADO: la fila de fichero no se repite.
    const sinIntegrados = (list, builtins) => {
      const names = new Set(builtins.map((a) => a.name));
      return list.filter((a) => !names.has(a.name));
    };

    // Orden de cada bloque. El host manda las filas de fichero alfabéticas, pero los integrados
    // llegan en su orden fijo: el desempate por nombre los deja alfabéticos dentro de su grupo.
    // Proyecto: integrados sobrescritos, primarios y subagentes.
    // Globales: primarios, integrados (los que no son de proyecto) y subagentes.
    const rankProject = { builtin: 0, primary: 1, subagent: 2 };
    const rankGlobal = { primary: 0, builtin: 1, subagent: 2 };
    const pick = (list, rank) =>
      list.slice().sort((a, b) => {
        const byRank = (rank[a.mode] ?? rank.primary) - (rank[b.mode] ?? rank.primary);
        return byRank || a.name.localeCompare(b.name);
      });
    const project = pick(
      projectBuiltins.concat(sinIntegrados(agents.project || [], projectBuiltins)),
      rankProject
    );
    const global = pick(
      sinIntegrados(agents.global || [], globalBuiltins).concat(globalBuiltins),
      rankGlobal
    );

    el.agentsProjectCount.textContent = String(project.length);
    el.agentsGlobalCount.textContent = String(global.length);
    fillAgents(
      el.agentsProject,
      project,
      data.hasProject ? "Sin agentes de proyecto." : "Sin proyecto abierto.",
      // Solo el integrado del bloque de proyecto lleva la marca ámbar de override propio.
      (a) => (a.mode === "builtin" ? "mode-builtin-project" : "")
    );
    fillAgents(el.agentsGlobal, global, "Sin agentes globales.");
  }

  function catalogEntry(item, toggleType) {
    // Un item que no se alterna (skills de Claude, p. ej.) se pinta igual pero sin mando.
    const locked = item.toggleable === false;
    const row = node(
      "div",
      "entry" + (item.enabled ? "" : " off") + (locked ? " static" : "") +
        (toggleType === "toggleSkill" ? " skill" : "")
    );
    // Sin alternado no hay botón: un <span> no recibe foco ni se anuncia como pulsable.
    const sw = node(locked ? "span" : "button", "switch" + (item.enabled ? " on" : ""));
    if (!locked) {
      sw.type = "button";
      sw.setAttribute("aria-pressed", item.enabled ? "true" : "false");
      sw.setAttribute("aria-label", (item.enabled ? "Desactivar " : "Activar ") + item.name);
      // El tipo de MCP o la descripción de la skill no se pinta: va en el title del interruptor.
      sw.title =
        (item.enabled ? "Desactivar " : "Activar ") +
        item.name +
        (item.detail ? " — " + item.detail : "");
      sw.addEventListener("click", () =>
        act({ type: toggleType, name: item.name, scope: item.scope })
      );
    }
    const track = node("span", "switch-track");
    track.appendChild(node("span", "switch-thumb"));
    sw.appendChild(track);
    row.appendChild(sw);

    const main = node("span", "entry-main");
    const entryName = node("span", "entry-name", item.name);
    entryName.title = item.name + (item.detail ? " — " + item.detail : "");
    main.appendChild(entryName);
    row.appendChild(main);

    return row;
  }

  function fillColumn(box, items, emptyText, toggleType) {
    box.textContent = "";
    if (items.length === 0) {
      box.appendChild(node("div", "empty", emptyText));
      return;
    }
    for (const item of items) box.appendChild(catalogEntry(item, toggleType));
  }

  function countLabel(items) {
    const active = items.filter((i) => i.enabled).length;
    return active === items.length ? String(items.length) : active + "/" + items.length;
  }

  function renderCatalog(data) {
    const mcp = data.mcp || [];
    const skills = data.skills || [];
    const plugins = data.plugins || [];
    const noProject = "Sin proyecto abierto.";

    const mcpGlobal = mcp.filter((i) => i.scope === "global");
    const mcpProject = mcp.filter((i) => i.scope === "project");
    el.mcpGlobalCount.textContent = countLabel(mcpGlobal);
    el.mcpProjectCount.textContent = countLabel(mcpProject);
    fillColumn(el.mcpGlobal, mcpGlobal, "Sin servidores.", "toggleMcp");
    fillColumn(
      el.mcpProject,
      mcpProject,
      data.hasProject ? "Sin servidores." : noProject,
      "toggleMcp"
    );

    const pluginsGlobal = plugins.filter((i) => i.scope === "global");
    const pluginsProject = plugins.filter((i) => i.scope === "project");
    el.pluginsGlobalCount.textContent = countLabel(pluginsGlobal);
    el.pluginsProjectCount.textContent = countLabel(pluginsProject);
    fillColumn(el.pluginsGlobal, pluginsGlobal, "Sin plugins.", "togglePlugin");
    fillColumn(
      el.pluginsProject,
      pluginsProject,
      data.hasProject ? "Sin plugins." : noProject,
      "togglePlugin"
    );

    const skillsGlobal = skills.filter((i) => i.scope === "global");
    const skillsProject = skills.filter((i) => i.scope === "project");
    el.skillsGlobalCount.textContent = String(skillsGlobal.length);
    el.skillsProjectCount.textContent = String(skillsProject.length);
    fillColumn(el.skillsGlobal, skillsGlobal, "Sin skills.", "toggleSkill");
    fillColumn(
      el.skillsProject,
      skillsProject,
      data.hasProject ? "Sin skills." : noProject,
      "toggleSkill"
    );
  }

  function render(data) {
    if (!data) return;

    el.banner.hidden = true;
    // Los dos botones nombran el fichero que de verdad abren con el proveedor activo.
    const fichero = AGENT_FILE[data.sessionAgent] || "AGENTS.md";
    el.global.title = "Editar el " + fichero + " global";
    el.global.setAttribute("aria-label", el.global.title);
    el.local.disabled = !data.hasProject;
    el.local.title = data.hasProject
      ? "Editar el " + fichero + " del proyecto"
      : "No hay ningún proyecto abierto: no hay " + fichero + " del proyecto.";
    el.local.setAttribute("aria-label", el.local.title);

    // ASIGNAR AGENTES solo vale con opencode: el tablero escribe el modelo en los .md de opencode.
    const opencode = data.sessionAgent === "opencode";
    el.assign.disabled = !opencode;
    el.assign.title = opencode ? "Asignar agentes a modelos" : "Solo con opencode";

    const working = Number(data.totals && data.totals.working) || 0;
    // La cabecera del explorador lleva lo que antes eran dos chips: sumas y agentes en vuelo.
    const sums = [];
    if (data.totals && (data.totals.tokens > 0 || data.totals.workMs > 0)) {
      sums.push("Σ " + fmtTokens(data.totals.tokens) + " tok · " + fmtDuration(data.totals.workMs));
    }
    if (working > 0) sums.push(working + " EN VUELO");
    el.agentsTotal.textContent = sums.join(" · ");
    el.agentsTotal.classList.toggle("busy", working > 0);

    renderPermissions(data);

    renderAgents(data);
    renderCatalog(data);
  }

  /** El estado vive en el DOM: el interruptor y su chip, nada más. */
  function renderPermissions(data) {
    const on = data.autoAccept === true;
    el.autoAcceptBtn.classList.toggle("on", on);
    el.autoAcceptBtn.setAttribute("aria-pressed", on ? "true" : "false");
    // El chip solo aparece con el auto-aceptar puesto: apagado, el interruptor ya lo dice.
    el.permState.hidden = !on;
    el.permState.textContent = on ? "AUTO" : "";
  }

  el.global.addEventListener("click", () =>
    act({ type: "editInstructions", scope: "global" })
  );
  el.local.addEventListener("click", () =>
    act({ type: "editInstructions", scope: "project" })
  );
  el.addPlugin.addEventListener("click", () => act({ type: "addPlugin" }));
  el.assign.addEventListener("click", () => act({ type: "openAssign" }));
  // Se engancha una sola vez: el HTML es estático y solo cambia de clase.
  el.autoAcceptBtn.addEventListener("click", () => {
    const on = el.autoAcceptBtn.classList.contains("on");
    act({ type: "setAutoAccept", on: !on });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "data") {
      render(message.payload);
      return;
    }
    if (message.type === "error") {
      el.banner.hidden = false;
      el.banner.textContent = message.message || "No se pudo leer la configuración.";
    }
  });

  vscode.postMessage({ type: "ready" });
})();
