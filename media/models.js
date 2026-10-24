/* Modelos — conmutador del modelo de la sesión en marcha. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    head: document.getElementById("head"),
    title: document.getElementById("title"),
    tags: document.getElementById("tags"),
    tMain: document.getElementById("t-main"),
    tSub: document.getElementById("t-sub"),
    search: document.getElementById("search"),
    clear: document.getElementById("clear"),
    assign: document.getElementById("assign"),
    now: document.getElementById("now"),
    note: document.getElementById("note"),
    groups: document.getElementById("groups"),
    recentGroup: document.getElementById("recent-group"),
    recent: document.getElementById("recent"),
    allGroup: document.getElementById("all-group"),
    total: document.getElementById("total"),
    all: document.getElementById("all"),
  };

  // El buscador es HTML estático: su valor vive aquí y manda al repintar.
  let modelQuery = "";
  let lastData = null;
  let modelsKey = "";
  // PRINCIPAL o SUBAGENTES; no se guarda entre sesiones.
  let target = "main";

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** Con subagentes manda el chip; sin ellos, siempre el principal. */
  function activeMode(data) {
    return target === "sub" && data.subagent ? "sub" : "main";
  }

  function subNote(source) {
    if (source === "principal") return "SUBAGENTES · hereda del principal";
    if (source === "entorno") return "SUBAGENTES · variable de entorno";
    if (source === "settings") return "SUBAGENTES · settings.json";
    return "SUBAGENTES";
  }

  function filterModels(models, query) {
    if (!query) return models;
    return models.filter((m) =>
      (m.provider + " " + m.name + " " + m.id).toLowerCase().includes(query)
    );
  }

  function modelRow(model, current, mode) {
    const row = node("button", "model");
    row.type = "button";
    row.title = model.id;
    if (model.id === current) row.classList.add("on");
    row.appendChild(node("span", "model-provider", model.provider));
    row.appendChild(node("span", "model-name", model.name));
    // Gratis = todas las tarifas a cero; se marca para verlo de un vistazo.
    if (model.free) {
      row.classList.add("free");
      row.appendChild(node("span", "chip on", "FREE"));
    }
    if (model.hint) row.appendChild(node("span", "model-hint", model.hint));
    row.addEventListener("click", () =>
      vscode.postMessage({
        type: "action",
        action:
          mode === "sub"
            ? { type: "setSubagentModel", id: model.id }
            : { type: "setModel", id: model.id },
      })
    );
    return row;
  }

  function renderModels(data) {
    if (!data) return;
    lastData = data;
    const models = data.models || [];
    const recent = data.recentModels || [];
    const groups = data.groups || [];
    const mode = activeMode(data);
    const sub = mode === "sub" ? data.subagent : undefined;
    // El subagente se compara con el prefijo del conector, igual que el principal.
    const current = sub ? (sub.model ? "claude/" + sub.model : "") : data.currentModel || "";

    // El sondeo llega cada pocos segundos: sin esta clave, buscar perdería el foco.
    const key = JSON.stringify([
      mode,
      modelQuery,
      current,
      recent.join(","),
      data.title || "",
      data.note || "",
      !!data.clearable,
      !!data.canAssign,
      data.subagent || null,
      models.map((m) => m.id),
      groups.map((g) => [g.name, g.models.map((m) => [m.id, m.name, m.hint || ""])]),
    ]);
    if (key === modelsKey) return;
    modelsKey = key;

    el.head.hidden = !data.title && !data.subagent;
    el.title.hidden = !data.title;
    el.title.textContent = "";
    if (data.title) {
      const [agent, ...rest] = data.title.split(" · ");
      el.title.appendChild(node("span", "title-agent", agent));
      if (rest.length) el.title.appendChild(node("span", null, " · " + rest.join(" · ")));
    }
    el.tags.hidden = !data.subagent;
    el.tMain.classList.toggle("on", mode === "main");
    el.tSub.classList.toggle("on", mode === "sub");
    el.tMain.setAttribute("aria-pressed", String(mode === "main"));
    el.tSub.setAttribute("aria-pressed", String(mode === "sub"));

    const note = sub ? subNote(sub.source) : data.note || "";
    el.note.hidden = !note;
    el.note.textContent = note;

    el.clear.hidden = sub ? !sub.clearable : !data.clearable;
    // «Heredar» prometería más de lo que se puede: el entorno del sistema también fija.
    el.clear.textContent = "SIN FIJAR";

    // La apertura del tablero de asignación no existe en todos los proveedores.
    if (el.assign) el.assign.hidden = !data.canAssign;

    const now = models.find((m) => m.id === current);

    el.now.textContent = "";
    if (!current) {
      el.now.appendChild(
        node("div", "empty", data.title ? "Sin modelo fijado." : "Sin sesión en marcha.")
      );
    } else if (now) {
      el.now.appendChild(modelRow(now, current, mode));
    } else {
      // El modelo en uso puede no estar en ningún grupo (una variante de ventana, por
      // ejemplo): se enseña sin el prefijo del conector, como el resto de filas.
      const row = node("div", "model on");
      const cut = current.startsWith("claude/") ? "claude/".length : 0;
      if (cut) row.appendChild(node("span", "model-provider", "claude"));
      row.appendChild(node("span", "model-name", current.slice(cut)));
      el.now.appendChild(row);
    }

    const grouped = groups.length > 0;
    el.groups.textContent = "";
    el.groups.hidden = !grouped;
    el.recentGroup.hidden = grouped;
    el.recent.hidden = grouped;
    el.allGroup.hidden = grouped;
    el.total.hidden = grouped;
    el.all.hidden = grouped;

    if (grouped) {
      let shown = 0;
      for (const group of groups) {
        const rows = filterModels(group.models || [], modelQuery);
        // El buscador esconde los grupos que se quedan sin filas.
        if (rows.length === 0) continue;
        shown += rows.length;
        const block = node("div", "group-block");
        const head = node("div", "group");
        head.appendChild(node("span", "group-name", group.name));
        block.appendChild(head);
        const list = node("div", "list");
        for (const model of rows) list.appendChild(modelRow(model, current, mode));
        block.appendChild(list);
        el.groups.appendChild(block);
      }
      if (shown === 0) {
        el.groups.appendChild(
          node("div", "empty", modelQuery ? "Sin coincidencias." : "Sin modelos.")
        );
      }
      return;
    }

    el.recent.textContent = "";
    const recentModels = recent
      .map((id) => models.find((m) => m.id === id))
      .filter(Boolean);
    if (recentModels.length === 0) {
      el.recent.appendChild(node("div", "empty", "Todavía no has cambiado de modelo."));
    } else {
      for (const model of recentModels) {
        el.recent.appendChild(modelRow(model, current, mode));
      }
    }

    const matches = filterModels(models, modelQuery);
    el.total.textContent = modelQuery
      ? matches.length + "/" + models.length
      : String(models.length);

    el.all.textContent = "";
    if (matches.length === 0) {
      el.all.appendChild(
        node("div", "empty", models.length === 0 ? "Sin modelos." : "Sin coincidencias.")
      );
    } else {
      for (const model of matches) el.all.appendChild(modelRow(model, current, mode));
    }
  }

  function switchTarget(next) {
    if (target === next) return;
    target = next;
    modelsKey = "";
    if (lastData) renderModels(lastData);
  }

  el.tMain.addEventListener("click", () => switchTarget("main"));
  el.tSub.addEventListener("click", () => switchTarget("sub"));

  el.clear.addEventListener("click", () => {
    if (!lastData) return;
    const action =
      activeMode(lastData) === "sub" ? { type: "clearSubagentModel" } : { type: "clearModel" };
    vscode.postMessage({ type: "action", action });
  });

  // Tablero de asignación: lo abre un panel aparte.
  if (el.assign) {
    el.assign.addEventListener("click", () =>
      vscode.postMessage({ type: "action", action: { type: "openAssign" } })
    );
  }

  el.search.addEventListener("input", () => {
    modelQuery = el.search.value.trim().toLowerCase();
    modelsKey = "";
    if (lastData) renderModels(lastData);
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "models") renderModels(message.payload);
  });

  vscode.postMessage({ type: "ready" });
})();
