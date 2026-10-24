/* ALFRED // CONTROL — pinta el explorador y manda acciones a la extensión. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    status: document.getElementById("status"),
    banner: document.getElementById("banner"),
    global: document.getElementById("btn-global"),
    local: document.getElementById("btn-local"),
    session: document.getElementById("btn-session"),
    agentLabel: document.getElementById("agent-label"),
    agentPrev: document.getElementById("agent-prev"),
    agentNext: document.getElementById("agent-next"),
    addPlugin: document.getElementById("btn-add-plugin"),
    agents: document.getElementById("agents"),
    agentsTotal: document.getElementById("agents-total"),
    mcpTotal: document.getElementById("mcp-total"),
    skillsTotal: document.getElementById("skills-total"),
    mcpGlobal: document.getElementById("mcp-global"),
    mcpProject: document.getElementById("mcp-project"),
    skillsGlobal: document.getElementById("skills-global"),
    skillsProject: document.getElementById("skills-project"),
    skillsGlobalCount: document.getElementById("skills-global-count"),
    skillsProjectCount: document.getElementById("skills-project-count"),
    pluginsGlobal: document.getElementById("plugins-global"),
    pluginsProject: document.getElementById("plugins-project"),
    autoAcceptBtn: document.getElementById("btn-auto-accept"),
    permState: document.getElementById("perm-state"),
  };

  const AGENT_LABELS = { opencode: "OPEN", claude: "CLAUDE", codex: "CODEX" };

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

  function agentRow(agent) {
    const row = node("div", "agent");
    if (agent.working) row.classList.add("working");
    if (agent.streaming) row.classList.add("streaming");
    if (agent.disabled) row.classList.add("disabled");

    // Modo y modelo ya no van en una línea propia: quedan en el title de la fila.
    const sub = [agent.mode, agent.model].filter(Boolean).join(" · ");
    const open = node("button", "agent-open");
    open.type = "button";
    open.title = "Editar " + agent.name + (sub ? " — " + sub : "");
    open.addEventListener("click", () =>
      act({ type: "editAgent", name: agent.name, scope: agent.scope })
    );

    const icon = node("span", "agent-icon mode-" + (agent.mode || "primary"));
    icon.setAttribute("aria-hidden", "true");
    if (isHex(agent.color)) icon.style.setProperty("--agent-color", agent.color);
    open.appendChild(icon);

    const id = node("span", "agent-id");
    const name = node("span", "agent-name");
    name.appendChild(node("span", "agent-label", agent.name));
    if (agent.disabled) name.appendChild(node("span", "chip off", "OFF"));
    if (agent.shadowed) name.appendChild(node("span", "chip", "SOMBRA"));
    if (agent.overriddenBy && agent.overriddenBy.length > 0) {
      name.appendChild(node("span", "chip", "SOBRESCRITO"));
    }
    id.appendChild(name);
    open.appendChild(id);

    const stats = node("span", "agent-stats");
    stats.appendChild(
      node(
        "span",
        "stat",
        agent.tokens > 0 || agent.workMs > 0
          ? fmtTokens(agent.tokens) + " tok · " + fmtDuration(agent.workMs)
          : "—"
      )
    );
    if (agent.working) {
      const flight = node("span", "flight");
      const bars = node("span", "bars");
      bars.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 3; i++) bars.appendChild(node("i"));
      flight.appendChild(bars);
      flight.appendChild(document.createTextNode("EN VUELO"));
      stats.appendChild(flight);
    }
    open.appendChild(stats);
    row.appendChild(open);

    if (agent.filePath) {
      const md = node("button", "mini", ".md");
      md.type = "button";
      md.title = "Abrir " + agent.filePath;
      md.addEventListener("click", () =>
      act({ type: "openAgentFile", name: agent.name, scope: agent.scope })
    );
      row.appendChild(md);
    }

    return row;
  }

  function renderAgents(data) {
    const groups = [
      ["project", "PROYECTO", data.hasProject ? "Sin agentes de proyecto." : "Sin proyecto abierto."],
      ["global", "GLOBALES", "Sin agentes globales."],
      ["builtin", "INTEGRADOS", "Sin integrados."],
    ];

    el.agents.textContent = "";
    for (const [key, label, emptyText] of groups) {
      const list = (data.agents && data.agents[key]) || [];
      const head = node("div", "group");
      head.appendChild(node("span", "group-name", label));
      head.appendChild(node("span", "count", String(list.length)));
      el.agents.appendChild(head);

      if (list.length === 0) {
        el.agents.appendChild(node("div", "empty", emptyText));
        continue;
      }
      for (const agent of list) {
        el.agents.appendChild(agentRow(agent));
      }
    }
  }

  function catalogEntry(item, toggleType) {
    // Un item que no se alterna (skills de Claude, p. ej.) se pinta igual pero sin mando.
    const locked = item.toggleable === false;
    const row = node(
      "div",
      "entry" + (item.enabled ? "" : " off") + (locked ? " static" : "")
    );
    const main = node("span", "entry-main");
    main.appendChild(node("span", "entry-name", item.name));
    row.appendChild(main);

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

    el.mcpTotal.textContent = countLabel(mcp);
    fillColumn(
      el.mcpGlobal,
      mcp.filter((i) => i.scope === "global"),
      "Sin servidores.",
      "toggleMcp"
    );
    fillColumn(
      el.mcpProject,
      mcp.filter((i) => i.scope === "project"),
      data.hasProject ? "Sin servidores." : noProject,
      "toggleMcp"
    );

    const skillsGlobal = skills.filter((i) => i.scope === "global");
    const skillsProject = skills.filter((i) => i.scope === "project");
    el.skillsTotal.textContent = countLabel(skills);
    el.skillsGlobalCount.textContent = String(skillsGlobal.length);
    el.skillsProjectCount.textContent = String(skillsProject.length);
    fillColumn(el.skillsGlobal, skillsGlobal, "Sin skills.", "toggleSkill");
    fillColumn(
      el.skillsProject,
      skillsProject,
      data.hasProject ? "Sin skills." : noProject,
      "toggleSkill"
    );

    fillColumn(
      el.pluginsGlobal,
      plugins.filter((i) => i.scope === "global"),
      "Sin plugins.",
      "togglePlugin"
    );
    fillColumn(
      el.pluginsProject,
      plugins.filter((i) => i.scope === "project"),
      data.hasProject ? "Sin plugins." : noProject,
      "togglePlugin"
    );
  }

  function render(data) {
    if (!data) return;

    el.banner.hidden = true;
    el.local.disabled = !data.hasProject;
    el.local.title = data.hasProject
      ? "Editar el AGENTS.md del proyecto"
      : "No hay ningún proyecto abierto.";

    el.agentLabel.textContent =
      AGENT_LABELS[data.sessionAgent] || String(data.sessionAgent || "").toUpperCase();
    const cycle = Array.isArray(data.sessionAgents) && data.sessionAgents.length > 1;
    el.agentPrev.disabled = !cycle;
    el.agentNext.disabled = !cycle;

    const working = Number(data.totals && data.totals.working) || 0;
    el.status.textContent = working > 0 ? working + " EN VUELO" : "EN LÍNEA";
    el.status.className = "hud-status" + (working > 0 ? " busy" : "");
    el.status.title =
      fmtTokens(data.totals && data.totals.tokens) +
      " tok · " +
      fmtDuration(data.totals && data.totals.workMs);

    el.agentsTotal.textContent =
      data.totals && (data.totals.tokens > 0 || data.totals.workMs > 0)
        ? "Σ " + fmtTokens(data.totals.tokens) + " tok · " + fmtDuration(data.totals.workMs)
        : "";

    renderPermissions(data);

    renderAgents(data);
    renderCatalog(data);
  }

  /** El estado vive en el DOM: el interruptor y la etiqueta de la cabecera, nada más. */
  function renderPermissions(data) {
    const on = data.autoAccept === true;
    el.autoAcceptBtn.classList.toggle("on", on);
    el.autoAcceptBtn.setAttribute("aria-pressed", on ? "true" : "false");
    el.permState.textContent = on ? "AUTO" : "PREGUNTA";
    el.permState.classList.toggle("on", on);
  }

  el.global.addEventListener("click", () =>
    act({ type: "editInstructions", scope: "global" })
  );
  el.local.addEventListener("click", () =>
    act({ type: "editInstructions", scope: "project" })
  );
  el.session.addEventListener("click", () => act({ type: "openLastSession" }));
  el.agentPrev.addEventListener("click", () => act({ type: "cycleAgent", delta: -1 }));
  el.agentNext.addEventListener("click", () => act({ type: "cycleAgent", delta: 1 }));
  el.addPlugin.addEventListener("click", () => act({ type: "addPlugin" }));
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
