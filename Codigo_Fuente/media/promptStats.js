/* Estadísticas de prompts — lista multiselección, agregado, ejes concatenados y barras. */
(function () {
  "use strict";

  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

  /** Ventana mínima del eje concatenado: por debajo no se hace zoom. */
  const MIN_SPAN = 200;
  /** Pasos del eje, de menor a mayor; se elige el que deja unas 6 marcas. */
  const STEPS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000,
    120000, 300000, 600000, 1800000, 3600000,
  ];

  const state = {
    snapshot: null,
    /** Ids marcados en la lista. */
    selection: new Set(),
    /** El usuario ya tocó la selección: el sondeo no vuelve a sembrarla. */
    touched: false,
    /** Ventana visible del eje concatenado; `null` = el conjunto completo. */
    zoom: null,
    /** Ids del último conjunto pintado: si cambian, el zoom deja de valer. */
    selectionKey: "",
    /** Mostrar los huecos reales de tiempo entre prompts en el timeline. */
    showGaps: false,
  };

  const el = {
    gaps: document.getElementById("btn-gaps"),
    monitor: document.getElementById("btn-monitor"),
    chip: document.getElementById("chip-monitor"),
    refresh: document.getElementById("btn-refresh"),
    clear: document.getElementById("btn-clear"),
    subtitle: document.getElementById("subtitle"),
    banner: document.getElementById("banner"),
    notice: document.getElementById("notice"),
    list: document.getElementById("list"),
    listCount: document.getElementById("list-count"),
    selAll: document.getElementById("sel-all"),
    selNone: document.getElementById("sel-none"),
    aggCount: document.getElementById("agg-count"),
    kpis: document.getElementById("kpis"),
    aggText: document.getElementById("agg-text"),
    timeline: document.getElementById("timeline"),
    strip: document.getElementById("strip"),
    lanes: document.getElementById("lanes"),
    axis: document.getElementById("axis"),
    range: document.getElementById("range-label"),
    zoomLabel: document.getElementById("zoom-label"),
    zoomIn: document.getElementById("zoom-in"),
    zoomOut: document.getElementById("zoom-out"),
    zoomFit: document.getElementById("zoom-fit"),
    tokensMax: document.getElementById("tokens-max"),
    costMax: document.getElementById("cost-max"),
    chartTokens: document.getElementById("chart-tokens"),
    chartCost: document.getElementById("chart-cost"),
    empty: document.getElementById("empty"),
  };

  /** Valores iniciales imposibles: el primer render siempre pinta. */
  const NONE = "\u0000";

  /** Firmas del último DOM pintado: si no cambian, no se reescribe. */
  const sig = { head: "", list: NONE, kpis: "", strip: "", lanes: "", axis: "", tokens: "", cost: "" };

  function send(message) {
    if (api) {
      api.postMessage(message);
    }
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Solo se tiñe con hex de 6 dígitos: lo demás cae al cian (misma regla que explorer.js). */
  function safeColor(color) {
    if (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)) {
      return color;
    }
    return "var(--neon)";
  }

  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0";
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + "k";
    if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
    return (n / 1e9).toFixed(2) + "B";
  }

  /** Milisegundos con un decimal por debajo de 10 s. */
  function fmtSeconds(ms) {
    const s = ms / 1000;
    if (s < 10) return (Math.round(s * 10) / 10).toFixed(1);
    return String(Math.round(s));
  }

  /** Desplazamiento respecto al inicio del eje: `0`, `+500ms`, `+30s`, `+1m 30s`. */
  function fmtOffset(ms) {
    const n = Math.round(Number(ms) || 0);
    if (n === 0) return "0";
    const sign = n > 0 ? "+" : "−";
    const abs = Math.abs(n);
    if (abs < 1000) return sign + abs + "ms";
    if (abs < 60000) return sign + fmtSeconds(abs) + "s";
    const m = Math.floor(abs / 60000);
    const s = Math.round((abs % 60000) / 1000);
    if (m < 60) return sign + m + "m" + (s ? " " + s + "s" : "");
    const h = Math.floor(m / 60);
    return sign + h + "h " + (m % 60) + "m";
  }

  /** Duración: `500ms`, `12.4s`, `1m 30s`, `2h 5m`. */
  function fmtDur(ms) {
    const n = Math.max(0, Math.round(Number(ms) || 0));
    if (n < 1000) return n + "ms";
    return fmtOffset(n).replace(/^\+/, "");
  }

  function fmtClock(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  /** Coste: `—` sin tarifa, `≈$…` estimado y `$…` real. */
  function fmtCost(o) {
    if (!o || !o.priced) return "—";
    const c = Number(o.cost) || 0;
    const text = c <= 0 ? "$0" : c < 0.0001 ? "<$0.0001" : c < 1 ? "$" + c.toFixed(4) : "$" + c.toFixed(2);
    return (o.costEstimated ? "≈" : "") + text;
  }

  /** ENTRADA es lo que viajó al modelo: entrada + caché leída + caché escrita. */
  function entryTokens(o) {
    return (Number(o.input) || 0) + (Number(o.cacheRead) || 0) + (Number(o.cacheWrite) || 0);
  }

  /** Número finito: cualquier dato corrupto cae a 0 para no pintar NaN. */
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) {
      node.textContent = text;
    }
  }

  function setHidden(node, hidden) {
    if (node) {
      node.hidden = !!hidden;
    }
  }

  /** Registros del host: se conservan aunque el último escaneo fallara. */
  function promptsOf(s) {
    return (s && s.prompts) || [];
  }

  /**
   * Fin del prompt. En uno cerrado manda su última actividad: el silencio
   * hasta el `idle` no es trabajo y dejaba un tramo vacío al final que se
   * confundía con el hueco entre prompts. Uno vivo sigue creciendo con el
   * `scannedAt` del sondeo.
   */
  function endOf(p, s) {
    const ended = num(p.endedAt);
    const now = num(s && s.scannedAt);
    if (p.live && now > ended) {
      return now;
    }
    let last = 0;
    for (const lane of p.lanes || []) {
      for (const seg of lane.segments || []) {
        const end = num(seg && seg.end);
        if (end > last) {
          last = end;
        }
      }
    }
    return last > 0 && ended > 0 ? Math.min(ended, last) : ended;
  }

  /** Duración del prompt: ya recortada al final de su actividad. */
  function durOf(p, s) {
    if (!p) return 0;
    return Math.max(0, endOf(p, s) - num(p.startedAt));
  }

  /** Prompt sin selección previa: el vivo si lo hay; si no, el más reciente. */
  function defaultId(prompts) {
    if (!prompts.length) {
      return null;
    }
    const live = prompts.find((p) => p && p.live);
    if (live) {
      return live.id;
    }
    return prompts.reduce((a, b) => (num(b.startedAt) > num(a.startedAt) ? b : a)).id;
  }

  function monitorOn() {
    return !!(state.snapshot && state.snapshot.monitor);
  }

  /** Solo datos del sondeo actual: los ids que ya no están salen de la selección. */
  function syncSelection(prompts) {
    const ids = new Set(prompts.map((p) => p && p.id));
    for (const id of Array.from(state.selection)) {
      if (!ids.has(id)) {
        state.selection.delete(id);
      }
    }
    if (!state.touched && state.selection.size === 0 && prompts.length) {
      const id = defaultId(prompts);
      if (id) {
        state.selection.add(id);
      }
    }
  }

  function selectedOf(prompts) {
    return prompts.filter((p) => p && state.selection.has(p.id));
  }

  function saveSelection() {
    if (!api || typeof api.setState !== "function") {
      return;
    }
    try {
      api.setState({ selection: Array.from(state.selection), touched: state.touched });
    } catch (_) {
      /* La memoria de la pestaña es un lujo, no un requisito. */
    }
  }

  function restoreSelection() {
    if (!api || typeof api.getState !== "function") {
      return;
    }
    try {
      const saved = api.getState();
      if (saved && Array.isArray(saved.selection)) {
        state.selection = new Set(saved.selection.filter((id) => typeof id === "string"));
        state.touched = !!saved.touched;
      }
    } catch (_) {
      /* Estado corrupto: se empieza vacío. */
    }
  }

  function emptyText() {
    const s = state.snapshot;
    if (!s || !s.ok) {
      return "Sin datos: revisa el aviso de arriba.";
    }
    if (!s.project) {
      return "Sin proyecto abierto: abre una carpeta para ver sus prompts.";
    }
    if (!s.monitor) {
      return "No hay prompts guardados todavía. Activa MONITORIZAR para empezar a guardarlos.";
    }
    return "No hay prompts registrados todavía en este proyecto.";
  }

  /* ── Lista ───────────────────────────────────────────── */

  function rowHtml(p) {
    const sel = state.selection.has(p.id);
    return (
      '<div class="row' + (sel ? " sel" : "") + '" role="button" tabindex="0" data-id="' + esc(p.id) +
      '" aria-pressed="' + (sel ? "true" : "false") + '">' +
      '<div class="row-top">' +
      '<span class="box' + (sel ? " on" : "") + '" aria-hidden="true"></span>' +
      '<span class="row-time">' + fmtClock(p.startedAt) + "</span>" +
      (p.live ? '<span class="chip live" title="El prompt sigue en curso">LIVE</span>' : "") +
      '<span class="row-dur">' + esc(fmtDur(durOf(p, state.snapshot))) + "</span>" +
      (p.live
        ? ""
        : '<button type="button" class="trash" data-id="' + esc(p.id) +
          '" title="Borrar este prompt del historial" aria-label="Borrar este prompt del historial">✕</button>') +
      "</div>" +
      '<div class="row-line">' +
      '<span class="row-text" title="' + esc(p.prompt) + '">' + esc(p.prompt) + "</span>" +
      '<span class="row-meta" title="' + esc("Tokens y coste del prompt") + '">' + esc(fmtTokens(p.total)) +
      " · " + esc(fmtCost(p)) + "</span>" +
      "</div>" +
      "</div>"
    );
  }

  function renderList(prompts) {
    const key = prompts
      .map((p) =>
        [p.id, num(p.endedAt), Math.round(durOf(p, state.snapshot)), p.live ? 1 : 0, num(p.total),
          num(p.cost), p.costEstimated ? 1 : 0, p.priced ? 1 : 0,
          state.selection.has(p.id) ? 1 : 0].join("~")
      )
      .join("|");
    if (key === sig.list) {
      return;
    }
    sig.list = key;
    if (!el.list) {
      return;
    }
    const top = el.list.scrollTop;
    el.list.innerHTML = prompts.length
      ? prompts.map(rowHtml).join("")
      : '<p class="empty">' + esc(emptyText()) + "</p>";
    el.list.scrollTop = top;
    setText(el.listCount, String(prompts.length));
  }

  /* ── Agregado ────────────────────────────────────────── */

  function aggCost(rows) {
    let cost = 0;
    let priced = false;
    let estimated = false;
    for (const r of rows) {
      if (!r) continue;
      if (r.priced) {
        priced = true;
        cost += num(r.cost);
      }
      if (r.costEstimated) {
        estimated = true;
      }
    }
    return { priced: priced, costEstimated: estimated, cost: cost };
  }

  function agentGroups(items, w) {
    const map = new Map();
    for (const item of items) {
      const p = item.p;
      for (const lane of p.lanes || []) {
        if (!lane || !lane.agent) continue;
        let a = map.get(lane.agent);
        if (!a) {
          a = {
            agent: lane.agent, color: safeColor(lane.color), root: false,
            total: 0, cost: 0, costEstimated: false, priced: false,
            hasSeg: false, segments: [],
          };
          map.set(lane.agent, a);
        }
        if (lane.root && !a.root) {
          a.root = true;
          a.color = safeColor(lane.color);
        }
        a.total += num(lane.total);
        a.cost += num(lane.cost);
        if (lane.priced) a.priced = true;
        if (lane.costEstimated) a.costEstimated = true;
        for (const seg of lane.segments || []) {
          const from = num(seg && seg.start);
          const to = num(seg && seg.end);
          a.hasSeg = true;
          const pos = positionsOf(item, from, to, w);
          if (pos) {
            a.segments.push({
              left: pos.left, width: pos.width, lane: lane, start: from, end: to,
              prompt: p.prompt,
            });
          }
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.root !== b.root) return a.root ? -1 : 1;
      return a.agent.localeCompare(b.agent);
    });
  }

  function positionsOf(item, from, to, w) {
    const start = num(item.p.startedAt);
    const a = item.off + Math.max(0, Math.min(item.dur, from - start));
    const b = item.off + Math.max(0, Math.min(item.dur, to - start));
    if (a >= w.to + 0.5 || b <= w.from - 0.5) {
      return null;
    }
    const span = Math.max(1, w.to - w.from);
    const lo = Math.max(a, w.from);
    const hi = Math.min(Math.max(b, a), w.to);
    return {
      left: Math.max(0, Math.min(100, ((lo - w.from) / span) * 100)),
      width: Math.max(0, Math.min(100, ((hi - lo) / span) * 100)),
    };
  }

  function kpisHtml(selected, agents, s) {
    let work = 0;
    let total = 0;
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    let reasoning = 0;
    for (const p of selected) {
      work += durOf(p, s);
      total += num(p.total);
      input += num(p.input);
      cacheRead += num(p.cacheRead);
      cacheWrite += num(p.cacheWrite);
      output += num(p.output);
      reasoning += num(p.reasoning);
    }
    const cost = aggCost(selected);
    const tip =
      "Entrada (con caché): " + fmtTokens(entryTokens({ input: input, cacheRead: cacheRead, cacheWrite: cacheWrite })) +
      " · Caché leída: " + fmtTokens(cacheRead) +
      " · Caché escrita: " + fmtTokens(cacheWrite) +
      " · Salida: " + fmtTokens(output) +
      " · Razonamiento: " + fmtTokens(reasoning);
    const costTip = cost.priced
      ? "Coste de la selección" + (cost.costEstimated ? " (estimado con las tarifas de la configuración)" : "")
      : "Ninguno de los prompts seleccionados tiene tarifa conocida";
    return (
      kpi("PROMPTS", String(selected.length), "") +
      kpi("TRABAJO", fmtDur(work), "Tiempo de trabajo sumado de los prompts") +
      kpi("TOKENS", fmtTokens(total), tip) +
      kpi("COSTE", fmtCost(cost), costTip) +
      kpi("AGENTES", String(agents.length), "Agentes distintos en la selección")
    );
  }

  function kpi(label, value, title) {
    return (
      '<div class="kpi"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
      '<span class="kpi-label">' + esc(label) + "</span>" +
      '<span class="kpi-value">' + esc(value) + "</span>" +
      "</div>"
    );
  }

  function renderAggregate(selected, agents, s) {
    const key = selected
      .map((p) => [p.id, p.total, durOf(p, s), p.cost, p.priced ? 1 : 0, p.costEstimated ? 1 : 0].join(":"))
      .join("|") + "#" + selected.length + "#" + agents.length + "#" + promptsOf(state.snapshot).length;
    if (key === sig.kpis) {
      return;
    }
    sig.kpis = key;

    setText(el.aggCount, selected.length === 1 ? "1 seleccionado" : selected.length + " seleccionados");

    if (!selected.length) {
      if (el.kpis) el.kpis.innerHTML = "";
      if (el.aggText) {
        el.aggText.hidden = true;
        el.aggText.textContent = "";
      }
      if (promptsOf(state.snapshot).length) {
        setHidden(el.empty, false);
        setText(el.empty, "Marca prompts de la lista para ver el conjunto.");
      } else {
        setHidden(el.empty, true);
        setText(el.empty, "");
      }
      return;
    }

    setHidden(el.empty, true);
    if (el.kpis) {
      el.kpis.innerHTML = kpisHtml(selected, agents, s);
    }
    if (el.aggText) {
      const one = selected.length === 1 ? selected[0] : null;
      el.aggText.hidden = !one;
      const text = one ? String(one.prompt || "") : "";
      if (el.aggText.textContent !== text) {
        el.aggText.textContent = text;
      }
      if (one) {
        el.aggText.title = text;
      } else {
        el.aggText.removeAttribute("title");
      }
    }
  }

  /* ── Eje concatenado ─────────────────────────────────── */

  /**
   * Prompts seleccionados ordenados por inicio, encadenados sin huecos
   * (o con huecos reales entre prompts si showGaps es true):
   * cada uno ocupa `[off, off + dur]` del eje.
   */
  function chainOf(selected, s) {
    const sorted = selected.slice().sort((a, b) => num(a.startedAt) - num(b.startedAt));
    const items = [];
    let off = 0;
    let prevEnd = 0;
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const dur = Math.max(1, durOf(p, s));
      if (state.showGaps && i > 0) {
        const gap = Math.max(0, num(p.startedAt) - prevEnd);
        off += gap;
      }
      items.push({ p: p, off: off, dur: dur });
      off += dur;
      prevEnd = num(p.startedAt) + dur;
    }
    return { items: items, total: Math.max(1, off) };
  }

  function windowOf(chain) {
    const z = state.zoom;
    if (z && num(z.to) > num(z.from)) {
      const from = Math.max(0, Math.min(num(z.from), chain.total - 1));
      const to = Math.min(chain.total, Math.max(num(z.to), from + 1));
      if (to > from) {
        return { from: from, to: to };
      }
    }
    return { from: 0, to: chain.total };
  }

  function stripHtml(items, w) {
    const span = Math.max(1, w.to - w.from);
    const blocks = [];
    items.forEach((item, i) => {
      const a = Math.max(item.off, w.from);
      const b = Math.min(item.off + item.dur, w.to);
      if (b < a || item.off > w.to || item.off + item.dur < w.from) {
        return;
      }
      const left = ((a - w.from) / span) * 100;
      const width = Math.max(0, ((b - a) / span) * 100);
      const tip =
        String(item.p.prompt || "") + " · " + fmtClock(item.p.startedAt) + " · " + fmtDur(item.dur);
      blocks.push(
        '<span class="strip-block' + (i % 2 ? " alt" : "") + (item.p.live ? " live" : "") +
        '" style="left:' + left.toFixed(3) + "%;width:" + width.toFixed(3) +
        '%" title="' + esc(tip) + '">' +
        (width >= 12 ? '<span class="strip-time">' + fmtClock(item.p.startedAt) + "</span>" : "") +
        "</span>"
      );
    });
    return (
      '<div class="strip-row">' +
      '<span class="gutter"><span class="label">PROMPTS</span></span>' +
      '<div class="strip-track">' + blocks.join("") + "</div>" +
      "</div>"
    );
  }

  function lanesHtml(agents, items, w) {
    if (!agents.some((a) => a.hasSeg)) {
      return '<p class="empty">Esta selección no tiene actividad de ningún agente.</p>';
    }
    // Frontera de cada prompt dentro de la pista: sin ella, el tiempo muerto de
    // un prompt se confunde con el hueco entre prompts.
    const span = Math.max(1, w.to - w.from);
    const bounds = items
      .map((item, i) => {
        if (i === 0 || item.off <= w.from || item.off >= w.to) return "";
        const left = ((item.off - w.from) / span) * 100;
        return '<span class="lane-bound" style="left:' + left.toFixed(3) + '%"></span>';
      })
      .join("");
    return agents.map((a) => {
      const segs = a.segments.map((seg) => {
        const tip =
          a.agent + " · " + fmtClock(seg.start) + "–" + fmtClock(seg.end) +
          " · " + fmtDur(seg.end - seg.start) +
          " · " + fmtTokens(seg.lane.total) + " tokens · " + fmtCost(seg.lane) +
          ' · "' + String(seg.prompt || "") + '"';
        return (
          '<span class="seg' + (a.root ? " root" : "") +
          '" style="left:' + seg.left.toFixed(3) + "%;width:" + seg.width.toFixed(3) +
          "%;--c:" + esc(a.color) + '" title="' + esc(tip) + '"></span>'
        );
      }).join("");
      const kind = a.root ? "Principal" : "Subagente";
      return (
        '<div class="lane">' +
        '<div class="lane-info">' +
        '<span class="lane-icon ' + (a.root ? "root" : "sub") + '" style="--c:' + esc(a.color) +
        '" title="' + esc(kind) + '"></span>' +
        '<span class="lane-name" title="' + esc(a.agent) + '">' + esc(a.agent) + "</span>" +
        '<span class="chip" title="Tokens de este agente">' + esc(fmtTokens(a.total)) + "</span>" +
        '<span class="chip" title="Coste de este agente">' + esc(fmtCost(a)) + "</span>" +
        "</div>" +
        '<div class="lane-track">' + bounds + segs + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function tickStep(span) {
    const target = span / 6;
    for (let i = 0; i < STEPS.length; i++) {
      if (STEPS[i] >= target) {
        return STEPS[i];
      }
    }
    return STEPS[STEPS.length - 1];
  }

  function axisHtml(w) {
    const span = Math.max(1, w.to - w.from);
    const step = tickStep(span);
    const marks = [];
    for (let t = Math.ceil(w.from / step) * step; t <= w.to && marks.length < 40; t += step) {
      const left = ((t - w.from) / span) * 100;
      marks.push(
        '<span class="tick" style="left:' + left.toFixed(3) +
        '%"><span class="tick-label">' + esc(fmtOffset(t)) + "</span></span>"
      );
    }
    return (
      '<div class="axis-row">' +
      '<span class="gutter"></span>' +
      '<div class="axis-track">' + marks.join("") + "</div>" +
      "</div>"
    );
  }

  function renderTimeline(chain, agents) {
    const has = chain.items.length > 0;
    if (!has) {
      if (sig.strip !== NONE) {
        sig.strip = NONE;
        if (el.strip) el.strip.innerHTML = "";
      }
      if (sig.lanes !== NONE) {
        sig.lanes = NONE;
        if (el.lanes) el.lanes.innerHTML = "";
      }
      if (sig.axis !== NONE) {
        sig.axis = NONE;
        if (el.axis) el.axis.innerHTML = "";
      }
      setText(el.range, "—");
      setText(el.zoomLabel, "x1.00");
      return;
    }

    const w = windowOf(chain);

    const stripKey = chain.items
      .map((i) => [i.p.id, i.off, i.dur, i.p.live ? 1 : 0].join(":"))
      .join("|") + "#" + w.from + "#" + w.to + "#" + (state.showGaps ? 1 : 0);
    if (stripKey !== sig.strip) {
      sig.strip = stripKey;
      if (el.strip) el.strip.innerHTML = stripHtml(chain.items, w);
    }

    const laneKey = agents
      .map((a) => [a.agent, a.total, a.cost, a.priced ? 1 : 0, a.costEstimated ? 1 : 0,
        a.hasSeg ? 1 : 0, a.segments.length, a.color, a.root ? 1 : 0].join(":") +
        ":" + a.segments.map((s) => s.left.toFixed(1) + "," + s.width.toFixed(1)).join(";"))
      .join("|") + "#" + w.from + "#" + w.to + "#" + agents.map((a) => a.agent).join(",") +
      "#" + (state.showGaps ? 1 : 0);
    if (laneKey !== sig.lanes) {
      sig.lanes = laneKey;
      if (el.lanes) el.lanes.innerHTML = lanesHtml(agents, chain.items, w);
    }

    const axisKey = w.from + "#" + w.to + "#" + (state.showGaps ? 1 : 0);
    if (axisKey !== sig.axis) {
      sig.axis = axisKey;
      if (el.axis) el.axis.innerHTML = axisHtml(w);
    }

    setText(el.range, fmtOffset(w.from) + " → " + fmtOffset(w.to));
    const span = Math.max(1, w.to - w.from);
    setText(el.zoomLabel, "x" + (chain.total / span).toFixed(2));
  }

  /* ── Gráficas ────────────────────────────────────────── */

  function chartRows(agents, mode) {
    const rows = agents.filter((a) =>
      mode === "cost" ? a.hasSeg || a.total > 0 || a.priced : a.total > 0
    );
    rows.sort((a, b) => {
      if (mode === "cost" && a.priced !== b.priced) return a.priced ? -1 : 1;
      return mode === "cost" ? b.cost - a.cost : b.total - a.total;
    });
    return rows;
  }

  function chartHtml(agents, mode, anySelected) {
    const rows = chartRows(agents, mode);
    if (!anySelected) {
      return "";
    }
    if (!agents.length) {
      return '<p class="empty">Sin agentes en la selección.</p>';
    }
    if (!rows.length) {
      return '<p class="empty">Sin datos en la selección.</p>';
    }
    const max = mode === "cost" ? rows.reduce((m, a) => (a.priced ? Math.max(m, a.cost) : m), 0) : rows[0].total;
    return rows.map((a) => {
      const priced = mode !== "cost" || a.priced;
      const value = mode === "cost" ? num(a.cost) : num(a.total);
      const pct = max > 0 && priced ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
      const text = mode === "cost" ? fmtCost(a) : fmtTokens(a.total);
      const title = mode === "cost"
        ? (a.priced ? a.agent + " · " + fmtCost(a) : "Sin tarifa conocida")
        : a.agent + " · " + fmtTokens(a.total) + " tokens";
      return (
        '<div class="chart-row">' +
        '<span class="chart-name" title="' + esc(a.agent) + '">' +
        '<span class="chart-swatch" style="--c:' + esc(a.color) + '"></span>' +
        '<span class="chart-agent">' + esc(a.agent) + "</span>" +
        "</span>" +
        '<span class="chart-track">' +
        '<span class="bar" style="width:' + pct.toFixed(2) + "%;--c:" + esc(a.color) +
        '" title="' + esc(title) + '"></span>' +
        "</span>" +
        '<span class="chart-value' + (priced ? "" : " off") + '">' + esc(text) + "</span>" +
        "</div>"
      );
    }).join("");
  }

  function renderCharts(selected, agents) {
    const anySelected = selected.length > 0;
    const tokensKey = anySelected + "|" + agents
      .map((a) => a.agent + ":" + a.total + ":" + a.color + ":" + (a.root ? 1 : 0))
      .join("|");
    if (tokensKey !== sig.tokens) {
      sig.tokens = tokensKey;
      if (el.chartTokens) el.chartTokens.innerHTML = chartHtml(agents, "tokens", anySelected);
      const rows = chartRows(agents, "tokens");
      setText(el.tokensMax, anySelected && rows.length ? "máx " + fmtTokens(rows[0].total) : "");
    }
    const costKey = anySelected + "|" + agents
      .map((a) => a.agent + ":" + a.cost + ":" + (a.priced ? 1 : 0) + ":" + a.costEstimated +
        ":" + a.color + ":" + (a.root ? 1 : 0))
      .join("|");
    if (costKey !== sig.cost) {
      sig.cost = costKey;
      if (el.chartCost) el.chartCost.innerHTML = chartHtml(agents, "cost", anySelected);
      const rows = chartRows(agents, "cost");
      const priced = rows.filter((a) => a.priced);
      if (!anySelected || !rows.length) {
        setText(el.costMax, "");
      } else if (!priced.length) {
        setText(el.costMax, "máx —");
      } else {
        const max = priced.reduce((m, a) => (a.cost > m.cost ? a : m), priced[0]);
        setText(el.costMax, "máx " + fmtCost(max));
      }
    }
  }

  /* ── Cabecera ────────────────────────────────────────── */

  function paintGaps() {
    if (!el.gaps) {
      return;
    }
    const on = !!state.showGaps;
    el.gaps.classList.toggle("on", on);
    el.gaps.setAttribute("aria-pressed", on ? "true" : "false");
    const tip = on
      ? "Ocultar los huecos de tiempo entre prompts"
      : "Mostrar los huecos de tiempo entre prompts";
    el.gaps.title = tip;
    el.gaps.setAttribute("aria-label", tip);
  }

  function renderHead(s, prompts, selected) {
    const key = [s.monitor, s.project, s.savedCount, s.scannedAt, s.ok, s.error,
      prompts.length, selected.length].join("|");
    if (key === sig.head) {
      return;
    }
    sig.head = key;

    const on = !!s.monitor;
    const selText = selected.length === 1 ? "1 seleccionado" : selected.length + " seleccionados";
    setText(el.subtitle,
      (s.project ? s.project : "Sin proyecto") + " · " + num(s.savedCount) + " guardados · sondeo " +
      fmtClock(s.scannedAt) + " · " + selText);

    if (el.monitor) {
      el.monitor.classList.toggle("on", on);
      el.monitor.setAttribute("aria-pressed", on ? "true" : "false");
    }
    setText(el.chip, on ? "GRABANDO" : "EN PAUSA");
    if (el.chip) {
      el.chip.classList.toggle("on", on);
      el.chip.title = on
        ? "Se están guardando los prompts nuevos"
        : "La monitorización está apagada";
    }
    setHidden(el.notice, on);
    if (!on) {
      setText(el.notice, "La monitorización está apagada: no se escanea ni se guardará ningún prompt.");
    }
    setHidden(el.banner, !!s.ok);
    if (!s.ok) {
      setText(el.banner, s.error || "Error desconocido al leer las estadísticas.");
    }
  }

  /* ── Render completo ─────────────────────────────────── */

  function render() {
    const s = state.snapshot;
    if (!s) {
      return;
    }
    const prompts = promptsOf(s);
    syncSelection(prompts);
    const selected = selectedOf(prompts);

    // Nuevo conjunto de prompts seleccionados: el zoom anterior no significa nada.
    const key = selected.map((p) => p.id).sort().join("|");
    if (key !== state.selectionKey) {
      state.selectionKey = key;
      state.zoom = null;
    }

    const chain = chainOf(selected, s);
    const w = windowOf(chain);
    const agents = agentGroups(chain.items, w);

    renderHead(s, prompts, selected);
    renderList(prompts);
    renderAggregate(selected, agents, s);
    renderTimeline(chain, agents);
    renderCharts(selected, agents);
  }

  /* ── Zoom ────────────────────────────────────────────── */

  function zoomBy(factor) {
    const s = state.snapshot;
    if (!s) {
      return;
    }
    const chain = chainOf(selectedOf(promptsOf(s)), s);
    if (!chain.items.length) {
      return;
    }
    const total = chain.total;
    const w = windowOf(chain);
    const span = Math.max(1, w.to - w.from);
    const center = (w.from + w.to) / 2;
    const next = Math.max(Math.min(MIN_SPAN, total), Math.min(total, span * factor));
    if (next >= total - 0.5) {
      state.zoom = null;
    } else {
      const from = Math.max(0, Math.min(center - next / 2, total - next));
      state.zoom = { from: from, to: from + next };
    }
    render();
  }

  function toggle(id) {
    if (!id) {
      return;
    }
    if (state.selection.has(id)) {
      state.selection.delete(id);
    } else {
      state.selection.add(id);
    }
    state.touched = true;
    saveSelection();
    render();
  }

  /* ── Interacción ─────────────────────────────────────── */

  if (el.list) {
    el.list.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!target || !target.closest) {
        return;
      }
      const trash = target.closest(".trash");
      if (trash) {
        ev.stopPropagation();
        const id = trash.dataset && trash.dataset.id;
        if (id) {
          send({ type: "remove", ids: [id] });
        }
        return;
      }
      const row = target.closest(".row");
      if (row && row.dataset && row.dataset.id) {
        toggle(row.dataset.id);
      }
    });

    el.list.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") {
        return;
      }
      const target = ev.target;
      if (!target || !target.closest || target.closest(".trash")) {
        return;
      }
      const row = target.closest(".row");
      if (!row || !row.dataset) {
        return;
      }
      ev.preventDefault();
      toggle(row.dataset.id);
    });
  }

  if (el.selAll) {
    el.selAll.addEventListener("click", () => {
      state.selection = new Set(promptsOf(state.snapshot).map((p) => p.id));
      state.touched = true;
      saveSelection();
      render();
    });
  }

  if (el.selNone) {
    el.selNone.addEventListener("click", () => {
      state.selection.clear();
      state.touched = true;
      saveSelection();
      render();
    });
  }

  if (el.gaps) {
    el.gaps.addEventListener("click", () => {
      state.showGaps = !state.showGaps;
      state.zoom = null;
      paintGaps();
      render();
      send({ type: "setShowGaps", on: state.showGaps });
    });
  }
  if (el.monitor) {
    el.monitor.addEventListener("click", () => send({ type: "setMonitor", on: !monitorOn() }));
  }
  if (el.refresh) {
    el.refresh.addEventListener("click", () => send({ type: "refresh" }));
  }
  if (el.clear) {
    el.clear.addEventListener("click", () => send({ type: "clear" }));
  }
  if (el.zoomIn) {
    el.zoomIn.addEventListener("click", () => zoomBy(0.8));
  }
  if (el.zoomOut) {
    el.zoomOut.addEventListener("click", () => zoomBy(1.25));
  }
  if (el.zoomFit) {
    el.zoomFit.addEventListener("click", () => {
      state.zoom = null;
      render();
    });
  }

  if (el.timeline) {
    el.timeline.addEventListener(
      "wheel",
      (ev) => {
        if (!ev.ctrlKey) {
          return;
        }
        ev.preventDefault();
        zoomBy(ev.deltaY > 0 ? 1.25 : 0.8);
      },
      { passive: false }
    );
  }

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg) {
      return;
    }
    switch (msg.type) {
      case "promptStats":
        if (msg.payload) {
          state.snapshot = msg.payload;
          render();
        }
        break;
      case "showGaps":
        state.showGaps = msg.on === true;
        paintGaps();
        render();
        break;
    }
  });

  restoreSelection();
  paintGaps();
  // Las firmas arrancan vacías: el primer render tiene que pintar todo.
  sig.head = NONE;
  send({ type: "ready" });
})();
