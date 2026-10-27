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
    groups: document.getElementById("groups"),
    models: document.getElementById("models"),
    modelsCount: document.getElementById("models-count"),
    board: document.querySelector(".board"),
    wires: document.getElementById("wires"),
    modal: document.getElementById("modal"),
    modalText: document.getElementById("modal-text"),
    modalOk: document.getElementById("modal-ok"),
    modalCancel: document.getElementById("modal-cancel"),
  };

  const SCOPE = { project: "PROY", global: "GLOBAL", builtin: "INTEGRADO" };

  // El buscador es HTML estático: su valor no se reconstruye al repintar.
  let query = "";
  // Conectores apagados del filtro; se restauran de la vista guardada al arrancar.
  const off = new Set();
  // Solo el primer assign siembra query/off: los siguientes son repintados de la extensión.
  let inited = false;
  let saveTimer = 0;
  let lastData = null;
  let lastKey = "";
  let favIds = new Set();
  // Grupos de favoritos (pestañas) y el índice activo: los resuelve el host en cada assign.
  let favoriteGroups = [];
  let activeGroup = 0;
  // Pestaña que se está renombrando en línea; mientras exista, la barra no se repinta.
  let editing = null;
  // Grupo pendiente de borrar con el modal abierto, o -1.
  let askDeleteGroup = -1;
  // Temporizador del clic en una pestaña: espera por si llega el doble clic del renombrado.
  let tabTimer = 0;
  // Elemento que abrió el modal: el foco vuelve a él al cerrar.
  let modalReturn = null;
  // Ids del catálogo vivo: los grupos pueden traer ids que el host ya no sirve.
  let catalogIds = new Set();
  // Nombres previos a un createGroup: el siguiente repintado salta a la pestaña nueva.
  let pendingNames = null;
  let drag = null;
  // Fila/tarjeta seleccionada ({ kind, id }): resalta su cable. Solo visual: no se persiste ni se envía al host.
  let sel = null;
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

  // Una sola escritura por ráfaga: el filtro y el repintado siguen siendo inmediatos.
  function persistView() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      post({ type: "persistView", search: el.search.value, disabledProviders: [...off] });
    }, 300);
  }

  /** El nombre legible del modelo; si el catálogo ya no lo trae, el id. */
  function modelLabel(models, id) {
    const found = models.find((m) => m.id === id);
    return found ? found.name : id;
  }

  /** Menos de un dólar lleva hasta tres decimales; el resto, dos. */
  function money(value) {
    return "$" + (value < 1 ? String(Number(value.toFixed(3))) : value.toFixed(2));
  }

  /** Tarifa por millón de tokens: `$1.25 in · $5.00 out`; sin datos o gratis, cadena vacía. */
  function costText(cost) {
    if (!cost) return "";
    if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return "";
    // Gratis ya lo dice el chip FREE: `$0 in · $0 out` solo hace ruido.
    if (cost.input === 0 && cost.output === 0) return "";
    return money(cost.input) + " in · " + money(cost.output) + " out";
  }

  /** Favoritos del grupo que el catálogo vivo conoce: los ids muertos no cuentan. */
  function liveCount(ids) {
    return ids.filter((id) => catalogIds.has(id)).length;
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
        persistView();
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
      // La marca sobrevive a los repintados del sondeo: se deriva de sel al construir.
      if (sel && sel.kind === "agente" && sel.id === agentKey(agent)) card.classList.add("sel");

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
      // Tras un drag real el navegador no dispara click, así que no interfiere con el arrastre.
      // El botón «×» ya tiene su propio clic: no lo convertimos también en selección.
      card.addEventListener("click", (event) => {
        if (event.target.closest(".card-x")) return;
        toggleSel("agente", agentKey(agent));
      });

      agentEls.set(agentKey(agent), card);
      el.agents.appendChild(card);
    }
  }

  // ── Pestañas de grupos de favoritos ─────────────────────
  function renderGroups() {
    // Renombrar en línea: un repintado a media edición borraría el campo.
    if (editing !== null) return;
    el.groups.textContent = "";

    favoriteGroups.forEach((group, index) => {
      const tab = node("div", "group-tab" + (index === activeGroup ? " on" : ""));
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === activeGroup));
      tab.tabIndex = 0;
      tab.addEventListener("keydown", (event) => {
        if (event.target !== tab || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        tab.click();
      });
      const name = node("span", "group-tab-name", group.name);
      tab.appendChild(name);
      tab.title = group.name;
      tab.addEventListener("click", () => {
        if (editing !== null || index === activeGroup) return;
        // El repintado del host sustituye la pestaña, así que el clic deja un turno al doble
        // clic: si llega, se cancela el cambio de pestaña y se renombra en línea.
        if (tabTimer) clearTimeout(tabTimer);
        tabTimer = setTimeout(() => {
          tabTimer = 0;
          post({ type: "selectGroup", group: index });
        }, 250);
      });
      name.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (tabTimer) {
          clearTimeout(tabTimer);
          tabTimer = 0;
        }
        startRename(index, name);
      });

      // La × solo en la pestaña activa, y nunca si es el único grupo.
      if (index === activeGroup && favoriteGroups.length > 1) {
        const del = node("button", "group-x", "×");
        del.type = "button";
        del.title = "Borrar grupo";
        del.setAttribute("aria-label", "Borrar el grupo " + group.name);
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          askDelete(index);
        });
        tab.appendChild(del);
      }
      el.groups.appendChild(tab);
    });

    const add = node("button", "group-add", "+");
    add.type = "button";
    add.title = "Crear grupo";
    add.setAttribute("aria-label", "Crear un grupo de favoritos");
    add.addEventListener("click", () => {
      // El nombre lo pone el host («Grupo N»); el salto se resuelve con los nombres previos.
      pendingNames = new Set(favoriteGroups.map((g) => g.name));
      post({ type: "createGroup" });
    });
    el.groups.appendChild(add);
  }

  /** Renombrado en línea: Enter confirma, Esc o vacío cancelan. */
  function startRename(index, nameEl) {
    const group = favoriteGroups[index];
    if (editing !== null || !group) return;
    editing = index;

    const input = node("input", "group-rename");
    input.type = "text";
    input.maxLength = 60;
    input.value = group.name;
    input.setAttribute("aria-label", "Nombre del grupo");
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = null;
      const value = input.value.trim();
      if (commit && value && value !== group.name) {
        post({ type: "renameGroup", group: index, name: value });
      }
      renderGroups();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
  }

  /** Confirmación de borrado dentro de la webview: `window.confirm` no existe aquí. */
  function askDelete(index) {
    const group = favoriteGroups[index];
    if (!group || favoriteGroups.length <= 1) return;
    askDeleteGroup = index;
    // Se anuncia lo que de verdad se borra: los ids muertos no cuentan.
    el.modalText.textContent =
      "Se borrará el grupo \"" +
      group.name +
      "\" y sus " +
      plural(liveCount(group.ids || []), "favorito", "favoritos") +
      ". Los modelos siguen en MODELOS.";
    modalReturn = document.activeElement;
    el.modal.hidden = false;
    el.modalOk.focus();
  }

  function closeModal() {
    askDeleteGroup = -1;
    el.modal.hidden = true;
    // El foco vuelve a quien abrió el modal; si el repintado ya se lo llevó, no se fuerza.
    if (modalReturn && modalReturn.isConnected) modalReturn.focus();
    modalReturn = null;
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
      if (sel && sel.kind === "modelo" && sel.id === model.id) card.classList.add("sel");
      card.appendChild(node("div", "card-line")).appendChild(node("span", "card-name", model.name));
      card.appendChild(node("div", "card-provider", model.provider));
      const cost = costText(model.cost);
      if (cost) {
        const row = node("div", "card-cost", cost);
        row.title = "USD por millón de tokens";
        card.appendChild(row);
      }

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
        startDrag(event, { kind: "model", id: model.id, group: activeGroup })
      );
      card.addEventListener("dragend", endDrag);
      card.addEventListener("click", () => toggleSel("modelo", model.id));

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

      const cost = costText(model.cost);
      if (cost) {
        const row = node("div", "card-cost", cost);
        row.title = "USD por millón de tokens";
        card.appendChild(row);
      }

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
      post({ type: "toggleFavorite", id, on: true, group: activeGroup });
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
    const group = drag.group === undefined ? activeGroup : drag.group;
    drag = null;
    clearDrop();
    post({ type: "toggleFavorite", id, on: false, group });
  });

  // Sin dragend (drop fuera de la vista) las marcas se quedarían pegadas.
  window.addEventListener("drop", () => {
    if (drag) endDrag();
  });
  window.addEventListener("dragend", endDrag);

  // ── Selección ───────────────────────────────────────────
  // Clic en un agente o en un favorito: resalta el cable que los une. Clic en lo ya seleccionado: deselecciona.
  function toggleSel(kind, id) {
    sel = sel && sel.kind === kind && sel.id === id ? null : { kind, id };
    markSel();
    drawWires();
  }

  function markSel() {
    for (const [key, card] of agentEls)
      card.classList.toggle("sel", !!sel && sel.kind === "agente" && sel.id === key);
    for (const [id, card] of favEls)
      card.classList.toggle("sel", !!sel && sel.kind === "modelo" && sel.id === id);
  }

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
      const key = agentKey(agent);
      const from = agentEls.get(key);
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
      // El resaltado se deriva de sel aquí, porque el SVG se repinta entero en cada fotograma.
      const hot =
        (sel && sel.kind === "agente" && sel.id === key) ||
        (sel && sel.kind === "modelo" && sel.id === agent.model);
      if (hot) path.classList.add("hot");
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
    if (!inited) {
      inited = true;
      // El filtro compara en minúsculas; el buscador conserva lo que escribió el usuario.
      query = (data.search || "").trim().toLowerCase();
      el.search.value = data.search || "";
      for (const provider of data.disabledProviders || []) off.add(provider);
    }
    lastData = data;
    const agents = data.agents || [];
    const models = data.models || [];
    // El host ya no filtra los grupos por catálogo: los ids muertos se quedan fuera de las cuentas.
    catalogIds = new Set(models.map((m) => m.id));
    // El host garantiza al menos un grupo; si llega vacío, se pinta uno vacío igualmente.
    const groups =
      Array.isArray(data.favoriteGroups) && data.favoriteGroups.length > 0
        ? data.favoriteGroups
        : [{ name: "Favoritos", ids: [] }];
    const active = Math.min(Math.max(0, Number(data.activeGroup) || 0), groups.length - 1);
    // «N favoritos» cuenta ids únicos de todos los grupos que el catálogo vivo conoce.
    const total = new Set(groups.flatMap((g) => g.ids || []).filter((id) => catalogIds.has(id)))
      .size;

    // El sondeo puede repetir los mismos datos: sin esta clave, el scroll y el foco saltan.
    const key = JSON.stringify([agents, models, groups, active, query, [...off].sort()]);
    if (key === lastKey) return;
    lastKey = key;

    favoriteGroups = groups;
    activeGroup = active;
    favIds = new Set(groups[active].ids || []);
    el.sub.textContent =
      plural(agents.length, "agente", "agentes") +
      " · " +
      plural(models.length, "modelo", "modelos") +
      " · " +
      plural(total, "favorito", "favoritos");

    // Tras crear, se salta al grupo nuevo: el que no estaba antes en la barra.
    if (pendingNames) {
      const before = pendingNames;
      pendingNames = null;
      const index = groups.findIndex((g) => !before.has(g.name));
      if (index >= 0 && index !== activeGroup) post({ type: "selectGroup", group: index });
    }

    renderProviders(models);
    renderAgents(agents, models);
    renderGroups();
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
    persistView();
  });

  el.close.addEventListener("click", () => post({ type: "close" }));

  // ── Modal de borrado de grupo ───────────────────────────
  el.modalOk.addEventListener("click", () => {
    const index = askDeleteGroup;
    closeModal();
    if (index >= 0) post({ type: "deleteGroup", group: index });
  });
  el.modalCancel.addEventListener("click", closeModal);
  el.modal.addEventListener("click", (event) => {
    if (event.target === el.modal) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (el.modal.hidden) return;
    if (event.key === "Escape") {
      closeModal();
      return;
    }
    // Trampa de foco: Tab cicla entre CANCELAR y BORRAR y no escapa al tablero de detrás.
    if (event.key !== "Tab") return;
    event.preventDefault();
    (document.activeElement === el.modalOk ? el.modalCancel : el.modalOk).focus();
  });

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
