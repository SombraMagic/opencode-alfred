(function () {
  const vscode = acquireVsCodeApi();

  const TOTAL = 20 * 8;

  const el = {
    title: document.getElementById("title"),
    banner: document.getElementById("banner"),
    usage: document.getElementById("usage"),
    pct: document.getElementById("pct"),
    tokens: document.getElementById("tokens"),
    free: document.getElementById("free"),
    compact: document.getElementById("compact"),
    cells: document.getElementById("cells"),
    legend: document.getElementById("legend"),
  };

  // La leyenda arranca abierta; el plegado se recuerda en el estado del webview.
  const legendBox = document.getElementById("legend-box");
  legendBox.open = !(vscode.getState() || {}).legendCollapsed;
  legendBox.addEventListener("toggle", () => {
    vscode.setState({ legendCollapsed: !legendBox.open });
  });

  // Misma escala que media/stats.js.
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
    return (n / 1e9).toFixed(2) + "B";
  }

  // "core/skill-guidance" -> "k-core-skill-guidance" (context.css mapea el color).
  function keyClass(key) {
    return (
      "k-" +
      String(key || "")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
    );
  }

  // Una celda por fracción del total; mínimo una por slice con tokens.
  function cellCounts(slices, denom) {
    const counts = slices.map((s) =>
      s.tokens > 0 && denom > 0 ? Math.max(1, Math.round((s.tokens / denom) * TOTAL)) : 0
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

  function cell(title, key) {
    const node = document.createElement("div");
    node.className = "cell" + (key ? " on " + keyClass(key) : "");
    node.title = title;
    return node;
  }

  function renderGrid(slices, denom) {
    const frag = document.createDocumentFragment();
    const counts = cellCounts(slices, denom);
    let filled = 0;
    slices.forEach((s, i) => {
      for (let n = 0; n < counts[i]; n++) {
        frag.appendChild(cell(s.label + ": " + fmtTokens(s.tokens), s.key));
        filled++;
      }
    });
    for (let i = filled; i < TOTAL; i++) {
      frag.appendChild(cell("Libre", ""));
    }
    el.cells.replaceChildren(frag);
  }

  function renderLegend(slices, denom) {
    const frag = document.createDocumentFragment();
    slices.forEach((s) => {
      const li = document.createElement("li");
      li.className = keyClass(s.key);
      li.title =
        s.label + ": " + (s.estimated ? "~" : "") + fmtTokens(s.tokens) + " tokens";

      const sw = document.createElement("span");
      sw.className = "sw";

      const name = document.createElement("span");
      name.className = "lg-name";
      name.textContent = s.label;

      const num = document.createElement("span");
      num.className = "lg-num";
      if (s.estimated) {
        const mark = document.createElement("abbr");
        mark.title = "Estimado a partir del texto guardado por opencode";
        mark.textContent = "~";
        num.appendChild(mark);
      }
      const pct = denom > 0 ? Math.round((s.tokens / denom) * 100) : 0;
      num.appendChild(document.createTextNode(fmtTokens(s.tokens) + " · " + pct + "%"));

      li.append(sw, name, num);
      frag.appendChild(li);
    });
    el.legend.replaceChildren(frag);
  }

  function render(info) {
    if (!info) return;

    el.banner.hidden = true;
    if (!info.ok) {
      el.title.textContent = "CONTEXTO";
      el.title.title = "";
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

    // Porcentaje protagonista; sin límite conocido no hay lectura posible.
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    const level = limit > 0 ? (pct >= 90 ? "error" : pct >= 70 ? "busy" : "ok") : "";
    el.pct.textContent = limit > 0 ? pct + "%" : "—";
    if (limit > 0) {
      el.pct.removeAttribute("title");
    } else {
      el.pct.title = "Límite de contexto desconocido";
    }
    el.pct.className = "pct" + (level ? " " + level : "");

    const tokens =
      limit > 0
        ? fmtTokens(used) + " / " + fmtTokens(limit) + " tokens"
        : fmtTokens(used) + " tokens";
    el.tokens.textContent = info.estimated ? "~" + tokens : tokens;
    if (info.estimated) {
      el.tokens.title =
        "Estimado: todavía no hay una petición medida después de compactar la sesión";
    } else {
      el.tokens.removeAttribute("title");
    }

    if (used === 0) {
      el.free.textContent = "Sin datos todavía";
    } else if (limit > 0) {
      el.free.textContent = "Libre: " + fmtTokens(Math.max(0, limit - used)) + " tokens";
    } else {
      el.free.textContent = "límite desconocido";
    }

    const slices = Array.isArray(info.slices) ? info.slices : [];
    renderGrid(slices, denom);
    renderLegend(slices, denom);
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
