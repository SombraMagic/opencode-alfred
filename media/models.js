/* Modelos — conmutador del modelo de la sesión en marcha. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    search: document.getElementById("search"),
    now: document.getElementById("now"),
    recent: document.getElementById("recent"),
    total: document.getElementById("total"),
    all: document.getElementById("all"),
  };

  // El buscador es HTML estático: su valor vive aquí y manda al repintar.
  let modelQuery = "";
  let lastData = null;
  let modelsKey = "";

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function modelRow(model, current) {
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
    row.addEventListener("click", () =>
      vscode.postMessage({ type: "action", action: { type: "setModel", id: model.id } })
    );
    return row;
  }

  function renderModels(data) {
    if (!data) return;
    lastData = data;
    const models = data.models || [];
    const current = data.currentModel || "";
    const recent = data.recentModels || [];

    // El sondeo llega cada pocos segundos: sin esta clave, buscar perdería el foco.
    const key =
      models.map((m) => m.id).join(",") +
      "|" +
      current +
      "|" +
      recent.join(",") +
      "|" +
      modelQuery;
    if (key === modelsKey) return;
    modelsKey = key;

    const now = models.find((m) => m.id === current);

    el.now.textContent = "";
    if (!current) {
      el.now.appendChild(node("div", "empty", "Sin sesión en marcha."));
    } else if (now) {
      el.now.appendChild(modelRow(now, current));
    } else {
      // El modelo en uso ya no está en el catálogo: se enseña el id tal cual.
      const row = node("div", "model on");
      row.appendChild(node("span", "model-name", current));
      el.now.appendChild(row);
    }

    el.recent.textContent = "";
    const recentModels = recent
      .map((id) => models.find((m) => m.id === id))
      .filter(Boolean);
    if (recentModels.length === 0) {
      el.recent.appendChild(node("div", "empty", "Todavía no has cambiado de modelo."));
    } else {
      for (const model of recentModels) {
        el.recent.appendChild(modelRow(model, current));
      }
    }

    const matches = modelQuery
      ? models.filter((m) =>
          (m.provider + " " + m.name + " " + m.id)
            .toLowerCase()
            .includes(modelQuery)
        )
      : models;
    el.total.textContent = modelQuery
      ? matches.length + "/" + models.length
      : String(models.length);

    el.all.textContent = "";
    if (matches.length === 0) {
      el.all.appendChild(
        node("div", "empty", models.length === 0 ? "Sin modelos." : "Sin coincidencias.")
      );
    } else {
      for (const model of matches) el.all.appendChild(modelRow(model, current));
    }
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
