(function () {
  const vscode = acquireVsCodeApi();

  const TOTAL = 10 * 10;

  const el = {
    title: document.getElementById("title"),
    meta: document.getElementById("meta"),
    banner: document.getElementById("banner"),
    usage: document.getElementById("usage"),
    compact: document.getElementById("compact"),
    cells: document.getElementById("cells"),
    legend: document.getElementById("legend"),
  };

  // Misma escala que media/stats.js.
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
    return (n / 1e9).toFixed(2) + "B";
  }

  // Leyenda común a opencode, Claude Code y Codex: siempre las mismas cuatro filas.
  // Claude y Codex solo mandan `conversation`, así que las demás salen con 0.
  const GROUPS = [
    { id: "sistema", label: "Sistema", match: (key) => key.indexOf("core/") === 0 },
    { id: "conversacion", label: "Conversación", match: (key) => key === "conversation" },
    { id: "sin-atribuir", label: "Sin atribuir", match: (key) => key === "unattributed" },
    { id: "libre", label: "Libre", free: true },
  ];

  function buildGroups(info) {
    const slices = Array.isArray(info.slices) ? info.slices : [];
    const used = Number(info.used) || 0;
    const limit = Number(info.limit) || 0;
    return GROUPS.map((group) => {
      if (group.free) {
        return {
          id: group.id,
          label: group.label,
          tokens: limit > 0 ? Math.max(0, limit - used) : 0,
          estimated: false,
        };
      }
      let tokens = 0;
      let estimated = false;
      slices.forEach((slice) => {
        if (!group.match(String((slice && slice.key) || ""))) return;
        const n = Number(slice.tokens) || 0;
        tokens += n;
        if (n > 0 && slice.estimated) estimated = true;
      });
      return { id: group.id, label: group.label, tokens, estimated };
    });
  }

  // Una celda por fracción del total; mínimo una por grupo con tokens.
  function cellCounts(groups, denom) {
    const counts = groups.map((g) =>
      g.tokens > 0 && denom > 0 ? Math.max(1, Math.round((g.tokens / denom) * TOTAL)) : 0
    );
    let sum = counts.reduce((a, b) => a + b, 0);
    while (sum > TOTAL) {
      let big = 0;
      for (let i = 1; i < counts.length; i++) {
        if (counts[i] > counts[big]) big = i;
      }
      if (counts[big] <= 1) break;
      counts[big]--;
      sum--;
    }
    return counts;
  }

  function cell(title, groupId) {
    const node = document.createElement("div");
    node.className = "cell" + (groupId ? " on g-" + groupId : "");
    node.title = title;
    return node;
  }

  function renderGrid(groups, denom) {
    const filled = groups.filter((g) => g.id !== "libre");
    const counts = cellCounts(filled, denom);
    const frag = document.createDocumentFragment();
    let cells = 0;
    filled.forEach((g, i) => {
      const title =
        g.label + ": " + (g.estimated ? "~" : "") + fmtTokens(g.tokens) + " tokens";
      for (let n = 0; n < counts[i]; n++) {
        frag.appendChild(cell(title, g.id));
        cells++;
      }
    });
    for (let i = cells; i < TOTAL; i++) {
      frag.appendChild(cell("Libre", ""));
    }
    el.cells.replaceChildren(frag);
  }

  function renderLegend(groups, denom) {
    const frag = document.createDocumentFragment();
    groups.forEach((g) => {
      const li = document.createElement("li");
      li.className = "g-" + g.id;
      li.title =
        g.label + ": " + (g.estimated ? "~" : "") + fmtTokens(g.tokens) + " tokens";

      const sw = document.createElement("span");
      sw.className = "sw";

      const name = document.createElement("span");
      name.className = "lg-name";
      name.textContent = g.label;

      const num = document.createElement("span");
      num.className = "lg-num";
      if (g.estimated) {
        const mark = document.createElement("abbr");
        mark.title = "Estimado a partir del texto guardado por opencode";
        mark.textContent = "~";
        num.appendChild(mark);
      }
      const pct = denom > 0 ? Math.round((g.tokens / denom) * 100) : 0;
      num.appendChild(document.createTextNode(fmtTokens(g.tokens) + " · " + pct + " %"));

      li.append(sw, name, num);
      frag.appendChild(li);
    });
    el.legend.replaceChildren(frag);
  }

  // Cabecera: porcentaje, gastado y límite en una sola línea.
  function renderMeta(used, limit, estimated) {
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const pctEl = document.createElement("span");
    pctEl.className = "pct" + (limit > 0 ? (pct >= 90 ? " error" : pct >= 70 ? " busy" : " ok") : "");
    pctEl.textContent = limit > 0 ? pct + " %" : "—";
    if (limit <= 0) {
      pctEl.title = "Límite de contexto desconocido";
    }

    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = " · ";

    const figs = document.createElement("span");
    figs.className = "figs";
    if (used === 0 && limit === 0) {
      figs.textContent = "sin datos";
    } else {
      figs.textContent =
        (estimated && used > 0 ? "~" : "") +
        (limit > 0 ? fmtTokens(used) + " / " + fmtTokens(limit) : fmtTokens(used));
    }
    if (estimated && used > 0) {
      figs.title = "Estimado: todavía no hay una petición medida después de compactar la sesión";
    }

    el.meta.replaceChildren(pctEl, sep, figs);
  }

  function render(info) {
    if (!info) return;

    el.banner.hidden = true;
    if (!info.ok) {
      el.title.textContent = "CONTEXTO";
      el.title.title = "";
      el.meta.replaceChildren();
      el.usage.hidden = true;
      el.banner.hidden = false;
      el.banner.textContent = info.error || "No se pudo leer el contexto.";
      return;
    }

    const used = Number(info.used) || 0;
    const limit = Number(info.limit) || 0;
    const denom = limit || used;
    const label = info.title || "Sesión sin título";

    el.title.textContent = label;
    el.title.title = label;
    el.usage.hidden = false;

    renderMeta(used, limit, !!info.estimated);

    const groups = buildGroups(info);
    renderGrid(groups, denom);
    renderLegend(groups, denom);
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "context") {
      render(message.payload);
    }
  });

  // Sin estado pendiente: el backend no responde, el siguiente sondeo "context" es el acuse.
  el.compact.addEventListener("click", () => {
    vscode.postMessage({ type: "compact" });
  });

  vscode.postMessage({ type: "ready" });
})();
