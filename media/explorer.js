/* ALFRED // CONTROL — pinta el explorador y manda acciones a la extensión. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    banner: document.getElementById("banner"),
    global: document.getElementById("btn-global"),
    local: document.getElementById("btn-local"),
    session: document.getElementById("btn-session"),
    agentLabel: document.getElementById("agent-label"),
    agentPrev: document.getElementById("agent-prev"),
    agentNext: document.getElementById("agent-next"),
    addPlugin: document.getElementById("btn-add-plugin"),
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
    // Dibujo del proveedor dentro del botón de sesión (path vacío hasta el primer render).
    sessionLogo: document.querySelector("#btn-session svg path"),
  };

  const AGENT_LABELS = { opencode: "OPEN", claude: "CLAUDE", codex: "CODEX" };
  // Nombre legible de la app: el texto visible es un svg, así que el title/aria-label es lo único
  // que identifica el botón; las abreviaturas de AGENT_LABELS no sirven para eso.
  const AGENT_NAMES = { opencode: "opencode", claude: "Claude Code", codex: "Codex" };

  // Dibujo de cada app para el botón de sesión (monócromos, viewBox 0 0 24 24).
  // Fuente: simple-icons (opencode, claude) y lobe-icons (codex). No redibujar aquí.
  const AGENT_LOGOS = {
    opencode: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
    claude:
      "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    codex:
      "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
  };

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

  /** Tarjeta de una línea: icono, nombre, modelo, trabajo, tokens, VER y EDIT. */
  function agentRow(agent) {
    const card = node("div", "agent");
    if (agent.working) card.classList.add("working");
    if (agent.streaming) card.classList.add("streaming");
    if (agent.disabled) card.classList.add("disabled");

    const icon = node("span", "agent-icon mode-" + (agent.mode || "primary"));
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

    // Los dos botones viajan juntos y pegados al borde derecho (margin-left: auto).
    const acciones = node("div", "agent-actions");
    acciones.appendChild(ver);
    if (agent.filePath) {
      const edit = node("button", "mini", "EDIT");
      edit.type = "button";
      edit.title = "Abrir " + agent.filePath;
      edit.addEventListener("click", () =>
        act({ type: "openAgentFile", name: agent.name, scope: agent.scope })
      );
      acciones.appendChild(edit);
    }
    card.appendChild(acciones);

    return card;
  }

  function fillAgents(box, list, emptyText) {
    box.textContent = "";
    if (list.length === 0) {
      box.appendChild(node("div", "empty", emptyText));
      return;
    }
    for (const agent of list) box.appendChild(agentRow(agent));
  }

  function renderAgents(data) {
    const agents = data.agents || {};
    const project = agents.project || [];
    // Los integrados van con los globales: cambia de dónde salen, no su sitio en la lista.
    const global = (agents.global || []).concat(agents.builtin || []);
    el.agentsProjectCount.textContent = String(project.length);
    el.agentsGlobalCount.textContent = String(global.length);
    fillAgents(
      el.agentsProject,
      project,
      data.hasProject ? "Sin agentes de proyecto." : "Sin proyecto abierto."
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
    el.local.disabled = !data.hasProject;
    el.local.title = data.hasProject
      ? "Editar el AGENTS.md del proyecto"
      : "No hay ningún proyecto abierto.";

    // El botón de sesión lleva el dibujo de la app; sin logo conocido, el texto de siempre.
    const nombreSesion = (
      AGENT_LABELS[data.sessionAgent] || String(data.sessionAgent || "")
    ).toUpperCase();
    const logo = AGENT_LOGOS[data.sessionAgent];
    el.sessionLogo.setAttribute("d", logo || "");
    el.agentLabel.hidden = !!logo;
    el.agentLabel.textContent = nombreSesion;
    const etiqueta =
      "Abrir o enfocar la terminal de " +
      (AGENT_NAMES[data.sessionAgent] || nombreSesion || "la sesión");
    el.session.title = etiqueta + "; las flechas cambian de agente";
    el.session.setAttribute("aria-label", etiqueta);
    const cycle = Array.isArray(data.sessionAgents) && data.sessionAgents.length > 1;
    el.agentPrev.disabled = !cycle;
    el.agentNext.disabled = !cycle;

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
