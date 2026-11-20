/* Ventana de contexto dentro del panel ALFRED // PULSO.
   No llama a acquireVsCodeApi(): panel.js lo hace una vez y se lo pasa a `crear`. */
(function () {
  // 20 columnas × 5 filas: ancha y baja.
  const TOTAL = 20 * 5;

  // Token de color del tema por clave de slice; el mismo en la cuadrícula y en la leyenda.
  // Una clave que no esté aquí usa el color de reserva y no se pierde.
  const KEY_COLOR = {
    "core/instructions": "--neon",
    "core/skill-guidance": "--violet",
    "core/codemode": "--green",
    "core/reference-guidance": "--azure",
    "core/environment": "--lime",
    "core/date": "--teal",
    "core/system": "--neon",
    // Claude: ocho colores distintos. El orden evita que queden pegados los pares
    // parecidos de algún tema (neon/ámbar en steampunk, neon/violeta en manoli).
    "core/memory": "--green",
    "core/agents": "--violet",
    "core/skills": "--amber",
    user: "--azure",
    assistant: "--magenta",
    tool_use: "--teal",
    tool_result: "--lime",
    conversation: "--magenta",
    unattributed: "--amber",
  };

  // Qué es cada slice de Claude (tooltip de la leyenda). Sin cifras.
  const KEY_HELP = {
    "core/system": "Sistema: prompt y herramientas internas del CLI, esquemas MCP y agentes o skills de plugins (no se cuentan aparte)",
    "core/memory": "Archivos de memoria: CLAUDE.md y lo que importan, estimado chars/4 con el estado actual de los ficheros",
    "core/agents": "Agentes: nombre y descripción de los de .claude/agents (proyecto y global)",
    "core/skills": "Skills: nombre y descripción de las de .claude/skills (proyecto y global)",
    user: "Usuario: tus mensajes en la conversación",
    assistant: "Asistente: las respuestas de Claude, sin las llamadas a herramientas",
    tool_use: "Llamadas a herramientas: lo que Claude envía al invocar herramientas",
    tool_result: "Resultados de herramientas: lo que devuelven a la conversación",
  };
  const FALLBACK = "--text-soft";

  // Misma escala que media/stats.js.
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
    return (n / 1e9).toFixed(2) + "B";
  }

  // Un grupo por slice y «Libre» al final. Libre no lleva color: es la celda vacía.
  function buildGroups(info) {
    const slices = Array.isArray(info.slices) ? info.slices : [];
    const used = Number(info.used) || 0;
    const limit = Number(info.limit) || 0;
    // Con Claude solo salen los slices con tokens; los demás agentes se pintan como llegan.
    const visibles = info.agent === "claude" ? slices.filter((s) => Number(s && s.tokens) > 0) : slices;
    const groups = visibles.map((s) => {
      const key = String((s && s.key) || "");
      return {
        key,
        label: String((s && s.label) || key || "Otros"),
        tokens: Number(s && s.tokens) || 0,
        estimated: !!(s && s.estimated),
        help: Object.hasOwn(KEY_HELP, key) ? KEY_HELP[key] : "",
        color: Object.hasOwn(KEY_COLOR, key) ? KEY_COLOR[key] : FALLBACK,
      };
    });
    groups.push({
      key: "",
      label: "Libre",
      tokens: limit > 0 ? Math.max(0, limit - used) : 0,
      estimated: false,
      color: "",
    });
    return groups;
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

  function crear(vscode) {
    const $ = (id) => document.getElementById(id);
    const el = {
      title: $("ctx-title"),
      meta: $("ctx-meta"),
      banner: $("ctx-banner"),
      usage: $("ctx-usage"),
      compact: $("ctx-compact"),
      cells: $("ctx-cells"),
      legend: $("ctx-legend"),
      fold: $("ctx-leg"),
    };

    // Estado plegado de la leyenda: sobrevive a recargas de la webview.
    const guardado = vscode.getState() || {};
    if (guardado.ctxLeyenda === false) el.fold.open = false;
    el.fold.addEventListener("toggle", () => {
      vscode.setState({ ...(vscode.getState() || {}), ctxLeyenda: el.fold.open });
    });

    function cell(title, g) {
      const node = document.createElement("div");
      node.className = "cell" + (g ? " on" : "");
      if (g) node.style.setProperty("--k", "var(" + g.color + ")");
      node.title = title;
      return node;
    }

    function textoTokens(g) {
      return g.label + ": " + (g.estimated ? "~" : "") + fmtTokens(g.tokens) + " tokens";
    }

    function renderGrid(groups, denom) {
      const filled = groups.filter((g) => g.key !== "");
      const counts = cellCounts(filled, denom);
      const frag = document.createDocumentFragment();
      let cells = 0;
      filled.forEach((g, i) => {
        const title = textoTokens(g);
        for (let n = 0; n < counts[i]; n++) {
          frag.appendChild(cell(title, g));
          cells++;
        }
      });
      for (let i = cells; i < TOTAL; i++) frag.appendChild(cell("Libre", null));
      el.cells.replaceChildren(frag);
    }

    function renderLegend(groups, denom, info) {
      const frag = document.createDocumentFragment();
      groups.forEach((g) => {
        const li = document.createElement("li");
        li.title = (g.help && info && info.agent === "claude" ? g.help + "\n" : "") + textoTokens(g);

        const sw = document.createElement("span");
        sw.className = "sw" + (g.color ? "" : " libre");
        if (g.color) sw.style.setProperty("--k", "var(" + g.color + ")");

        const name = document.createElement("span");
        name.className = "lg-name";
        name.textContent = g.label;

        const num = document.createElement("span");
        num.className = "lg-num";
        if (g.estimated) {
          const mark = document.createElement("abbr");
          mark.title =
            info && info.agent === "claude"
              ? "Estimado a partir del texto de la sesión (chars/4)"
              : "Estimado a partir del texto guardado por opencode";
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
      if (limit <= 0) pctEl.title = "Límite de contexto desconocido";

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

    // El sondeo repite el mismo payload: sin cambios no se toca el DOM.
    let firma = "";

    function render(info) {
      if (!info) return;
      const f = JSON.stringify(info);
      if (f === firma) return;
      firma = f;

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
      renderLegend(groups, denom, info);
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "context") render(message.payload);
    });

    // Sin estado pendiente: el siguiente sondeo "context" es el acuse.
    el.compact.addEventListener("click", () => {
      vscode.postMessage({ type: "compact" });
    });
  }

  window.AlfredContexto = { crear };
})();
