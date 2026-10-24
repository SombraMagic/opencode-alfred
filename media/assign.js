/* Asignación — conecta agentes con modelos favoritos: arrastrar, soltar y líneas. */
(function () {
  const vscode = acquireVsCodeApi();
  const SVG = "http://www.w3.org/2000/svg";

  const el = {
    sub: document.getElementById("sub"),
    search: document.getElementById("search"),
    providers: document.getElementById("providers"),
    close: document.getElementById("close"),
    agents: document.getElementById("agents"),
    agentsCount: document.getElementById("agents-count"),
    favorites: document.getElementById("favorites"),
    favCount: document.getElementById("fav-count"),
    models: document.getElementById("models"),
    modelsCount: document.getElementById("models-count"),
    board: document.querySelector(".board"),
    wires: document.getElementById("wires"),
  };

  const SCOPE = { project: "PROY", global: "GLOBAL", builtin: "INTEGRADO" };

  // El buscador es HTML estático: su valor no se reconstruye al repintar.
  let query = "";
  // Conectores apagados del filtro; solo viven en esta webview.
  const off = new Set();
  let lastData = null;
  let lastKey = "";
  let favIds = new Set();
  let drag = null;
  let agentEls = new Map();
  let favEls = new Map();
  let raf = 0;

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function post(action) {
    vscode.postMessage({ type: "action", action });
  }

  /** El nombre legible del modelo; si el catálogo ya no lo trae, el id. */
  function modelLabel(models, id) {
    const found = models.find((m) => m.id === id);
    return found ? found.name : id;
  }

  function agentKey(agent) {
    return agent.scope + "\u0000" + agent.name;
  }

  function empty(text) {
    return node("div", "empty", text);
  }

  /** «1 agente», «3 agentes»: el subtítulo se lee en español. */
  function plural(count, one, many) {
    return count + " " + (count === 1 ? one : many);
  }

  // ── Arrastre ────────────────────────────────────────────
  function startDrag(event, payload) {
    drag = payload;
    event.dataTransfer.setData("text/plain", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "link";
    // Un agente a la caza de destino: todos los favoritos se marcan.
    if (payload.kind === "agent") markTargets(true);
  }

  function endDrag() {
    drag = null;
    clearDrop();
  }

  function markTargets(on) {
    for (const card of el.favorites.children) card.classList.toggle("target", on);
  }

  function clearDrop() {
    el.favorites.classList.remove("drop");
    el.models.classList.remove("drop");
    for (const card of el.favorites.children) card.classList.remove("drop", "target");
    for (const card of el.models.children) card.classList.remove("drop");
  }

  // ── Filtro de conectores ────────────────────────────────
  function providerCounts(models) {
    const counts = new Map();
    for (const model of models) counts.set(model.provider, (counts.get(model.provider) || 0) + 1);
    return counts;
  }

  function renderProviders(models) {
    el.providers.textContent = "";
    for (const [provider, count] of providerCounts(models)) {
      const chip = node("button", "chip" + (off.has(provider) ? " off" : ""), provider);
      chip.type = "button";
      chip.title = count + (count === 1 ? " modelo" : " modelos");
      chip.setAttribute("aria-pressed", String(!off.has(provider)));
      chip.appendChild(node("span", "prov-count", String(count)));
      chip.addEventListener("click", () => {
        if (off.has(provider)) off.delete(provider);
        else off.add(provider);
        repaint();
      });
      el.providers.appendChild(chip);
    }
  }

  // ── Columna AGENTES ─────────────────────────────────────
  function renderAgents(agents, models) {
    el.agents.textContent = "";
    agentEls = new Map();
    el.agentsCount.textContent = agents.length ? String(agents.length) : "";
    if (agents.length === 0) {
      el.agents.appendChild(empty("Sin agentes."));
      return;
    }

    for (const agent of agents) {
      const card = node("div", "card agent");
      card.draggable = true;
      card.title = agent.name;

      const line = node("div", "card-line");
      line.appendChild(node("span", "card-name", agent.name));
      line.appendChild(
        node("span", "chip scope scope-" + agent.scope, SCOPE[agent.scope] || agent.scope)
      );
      card.appendChild(line);

      if (agent.model) {
        const row = node("div", "card-model-row");
        const label = node("span", "card-model", modelLabel(models, agent.model));
        label.title = agent.model;
        row.appendChild(label);
        const clear = node("button", "card-x", "×");
        clear.type = "button";
        clear.title = "Quitar modelo";
        clear.setAttribute("aria-label", "Quitar el modelo de " + agent.name);
        clear.addEventListener("click", () =>
          post({ type: "clear", agent: agent.name, scope: agent.scope })
        );
        row.appendChild(clear);
        card.appendChild(row);
      }

      if (agent.detail) card.appendChild(node("div", "card-detail", agent.detail));

      card.addEventListener("dragstart", (event) =>
        startDrag(event, { kind: "agent", agent: agent.name, scope: agent.scope })
      );
      card.addEventListener("dragend", endDrag);

      agentEls.set(agentKey(agent), card);
      el.agents.appendChild(card);
    }
  }

  // ── Columna FAVORITOS ───────────────────────────────────
  function renderFavorites(models) {
    el.favorites.textContent = "";
    favEls = new Map();
    const list = [...favIds]
      .map((id) => models.find((m) => m.id === id))
      .filter(Boolean);
    el.favCount.textContent = list.length ? String(list.length) : "";

    if (list.length === 0) {
      el.favorites.appendChild(empty("Arrastra aquí tus modelos."));
      return;
    }

    for (const model of list) {
      const card = node("div", "card fav");
      card.draggable = true;
      card.title = model.id;
      card.appendChild(node("div", "card-line")).appendChild(node("span", "card-name", model.name));
      card.appendChild(node("div", "card-provider", model.provider));

      // Un agente soltado sobre este favorito queda conectado a él.
      card.addEventListener("dragover", (event) => {
        if (!drag || drag.kind !== "agent") return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "link";
        card.classList.add("drop");
        card.classList.add("target");
      });
      card.addEventListener("dragleave", (event) => {
        if (card.contains(event.relatedTarget)) return;
        card.classList.remove("drop");
      });
      card.addEventListener("drop", (event) => {
        if (!drag || drag.kind !== "agent") return;
        event.preventDefault();
        const { agent, scope } = drag;
        drag = null;
        clearDrop();
        post({ type: "assign", agent, scope, model: model.id });
      });
      card.addEventListener("dragstart", (event) =>
        startDrag(event, { kind: "model", id: model.id })
      );
      card.addEventListener("dragend", endDrag);

      favEls.set(model.id, card);
      el.favorites.appendChild(card);
    }
  }

  // ── Columna MODELOS ─────────────────────────────────────
  function renderModelsColumn(models) {
    const hidden = new Set([...off]);
    const matches = models.filter(
      (m) =>
        !hidden.has(m.provider) &&
        (!query || (m.provider + " " + m.name + " " + m.id).toLowerCase().includes(query))
    );

    el.modelsCount.textContent =
      query || off.size ? matches.length + "/" + models.length : String(models.length);
    el.models.textContent = "";

    if (matches.length === 0) {
      el.models.appendChild(
        empty(models.length === 0 ? "Sin modelos." : "Sin coincidencias.")
      );
      return;
    }

    for (const model of matches) {
      const isFav = favIds.has(model.id);
      const card = node("div", "card model-card" + (isFav ? " is-fav" : ""));
      card.draggable = true;
      card.title = model.id;

      const line = node("div", "card-line");
      line.appendChild(node("span", "card-name", model.name));
      if (isFav) line.appendChild(node("span", "card-star", "★"));
      card.appendChild(line);

      const meta = node("div", "card-meta");
      meta.appendChild(node("span", "card-provider", model.provider));
      if (model.free) {
        meta.appendChild(node("span", "chip free", "FREE"));
        card.classList.add("free");
      }
      card.appendChild(meta);

      if (model.hint) card.appendChild(node("div", "card-detail", model.hint));

      card.addEventListener("dragstart", (event) =>
        startDrag(event, { kind: "model", id: model.id })
      );
      card.addEventListener("dragend", endDrag);
      el.models.appendChild(card);
    }
  }

  // ── Zonas de drop de columna ────────────────────────────
  el.favorites.addEventListener("dragover", (event) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "link";
    el.favorites.classList.add("drop");
  });
  el.favorites.addEventListener("dragleave", (event) => {
    if (el.favorites.contains(event.relatedTarget)) return;
    el.favorites.classList.remove("drop");
  });
  el.favorites.addEventListener("drop", (event) => {
    if (!drag) return;
    event.preventDefault();
    // El agente lo recoge la tarjeta de favorito; aquí solo caen modelos.
    if (drag.kind === "model") {
      const id = drag.id;
      drag = null;
      clearDrop();
      post({ type: "toggleFavorite", id, on: true });
    }
  });

  // La columna MODELOS es la papelera de favoritos: soltar un favorito lo desmarca.
  el.models.addEventListener("dragover", (event) => {
    if (!drag || drag.kind !== "model" || !favIds.has(drag.id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "link";
    el.models.classList.add("drop");
  });
  el.models.addEventListener("dragleave", (event) => {
    if (el.models.contains(event.relatedTarget)) return;
    el.models.classList.remove("drop");
  });
  el.models.addEventListener("drop", (event) => {
    if (!drag || drag.kind !== "model" || !favIds.has(drag.id)) return;
    event.preventDefault();
    const id = drag.id;
    drag = null;
    clearDrop();
    post({ type: "toggleFavorite", id, on: false });
  });

  // Sin dragend (drop fuera de la vista) las marcas se quedarían pegadas.
  window.addEventListener("drop", () => {
    if (drag) endDrag();
  });
  window.addEventListener("dragend", endDrag);

  // ── Líneas ──────────────────────────────────────────────
  function visibleIn(rect, list) {
    const box = list.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  function drawWires() {
    const svg = el.wires;
    const box = svg.getBoundingClientRect();
    svg.textContent = "";
    if (!lastData || box.width < 1 || box.height < 1) return;

    for (const agent of lastData.agents || []) {
      if (!agent.model || !favIds.has(agent.model)) continue;
      const from = agentEls.get(agentKey(agent));
      const to = favEls.get(agent.model);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      if (!visibleIn(a, el.agents) || !visibleIn(b, el.favorites)) continue;

      const x1 = round(a.right - box.left);
      const y1 = round(a.top + a.height / 2 - box.top);
      const x2 = round(b.left - box.left);
      const y2 = round(b.top + b.height / 2 - box.top);
      const dx = round(Math.max(18, (x2 - x1) / 2));

      const path = document.createElementNS(SVG, "path");
      path.setAttribute(
        "d",
        "M" + x1 + " " + y1 + " C" + round(x1 + dx) + " " + y1 + " " + round(x2 - dx) + " " + y2 + " " + x2 + " " + y2
      );
      svg.appendChild(path);
    }
  }

  // scroll y resize llegan a rachas: un solo repintado por fotograma.
  function scheduleWires() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      drawWires();
    });
  }

  // ── Repintado ───────────────────────────────────────────
  function renderAssign(data) {
    if (!data) return;
    lastData = data;
    const agents = data.agents || [];
    const models = data.models || [];
    const favorites = data.favorites || [];

    // El sondeo puede repetir los mismos datos: sin esta clave, el scroll y el foco saltan.
    const key = JSON.stringify([agents, models, favorites, query, [...off].sort()]);
    if (key === lastKey) return;
    lastKey = key;

    favIds = new Set(favorites);
    el.sub.textContent =
      plural(agents.length, "agente", "agentes") +
      " · " +
      plural(models.length, "modelo", "modelos") +
      " · " +
      plural(favorites.length, "favorito", "favoritos");

    renderProviders(models);
    renderAgents(agents, models);
    renderFavorites(models);
    renderModelsColumn(models);
    scheduleWires();
  }

  function repaint() {
    lastKey = "";
    if (lastData) renderAssign(lastData);
  }

  // ── Eventos fijos ───────────────────────────────────────
  el.search.addEventListener("input", () => {
    query = el.search.value.trim().toLowerCase();
    repaint();
  });

  el.close.addEventListener("click", () => post({ type: "close" }));

  for (const list of [el.board, el.agents, el.favorites, el.models]) {
    list.addEventListener("scroll", scheduleWires, { passive: true });
  }
  window.addEventListener("resize", scheduleWires);
  new ResizeObserver(scheduleWires).observe(el.board);

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "assign") renderAssign(message.payload);
  });

  vscode.postMessage({ type: "ready" });
})();
