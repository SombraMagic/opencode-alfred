/* Estadísticas de prompts — lista de prompts y línea de tiempo del seleccionado. */
(function () {
  "use strict";

  const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

  /** Ventana mínima de la línea de tiempo: por debajo no se hace zoom. */
  const MIN_SPAN = 200;
  /** Un prompt recién lanzado dura 0 s: se le da al menos 1 s de pista. */
  const MIN_FIT_SPAN = 1000;
  /** Pasos del eje, de menor a mayor; se elige el que deja unas 6 marcas. */
  const STEPS = [
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000,
    120000, 300000, 600000, 1800000, 3600000,
  ];

  const state = {
    snapshot: null,
    selectedId: null,
    /** Ventana visible cuando el usuario hizo zoom; `null` = ajustado al prompt. */
    zoom: null,
  };

  const el = {
    monitor: document.getElementById("btn-monitor"),
    chip: document.getElementById("chip-monitor"),
    refresh: document.getElementById("btn-refresh"),
    clear: document.getElementById("btn-clear"),
    subtitle: document.getElementById("subtitle"),
    banner: document.getElementById("banner"),
    notice: document.getElementById("notice"),
    list: document.getElementById("list"),
    listCount: document.getElementById("list-count"),
    detail: document.getElementById("detail"),
    detailEmpty: document.getElementById("detail-empty"),
    title: document.getElementById("p-title"),
    meta: document.getElementById("p-meta"),
    timeline: document.getElementById("timeline"),
    lanes: document.getElementById("lanes"),
    axis: document.getElementById("axis"),
    range: document.getElementById("range-label"),
    zoomLabel: document.getElementById("zoom-label"),
    zoomIn: document.getElementById("zoom-in"),
    zoomOut: document.getElementById("zoom-out"),
    zoomFit: document.getElementById("zoom-fit"),
  };

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

  /** Desplazamiento respecto al inicio del prompt: `0`, `+500ms`, `+30s`, `+1m 30s`. */
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

  function fitRange(p) {
    const from = num(p && p.startedAt);
    return { from: from, to: Math.max(num(p && p.endedAt), from + MIN_FIT_SPAN) };
  }

  /** Zoom del usuario si sigue siendo válido; si no, ajuste al prompt. */
  function windowOf(p) {
    const z = state.zoom;
    if (z && num(z.to) > num(z.from)) {
      return { from: num(z.from), to: num(z.to) };
    }
    return fitRange(p);
  }

  function monitorOn() {
    return !!(state.snapshot && state.snapshot.monitor);
  }

  function setSelection(id) {
    state.selectedId = id;
    // Prompt nuevo: siempre ajustado; el zoom es cosa de la vista actual.
    state.zoom = null;
  }

  /** Registros del host: se conservan aunque el último escaneo fallara. */
  function promptsOf(s) {
    return (s && s.prompts) || [];
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

  function currentPrompt() {
    return promptsOf(state.snapshot).find((p) => p.id === state.selectedId);
  }

  function zoomBy(factor) {
    const p = currentPrompt();
    if (!p) {
      return;
    }
    const fit = fitRange(p);
    const fitSpan = fit.to - fit.from;
    const w = windowOf(p);
    const span = w.to - w.from;
    const center = (w.from + w.to) / 2;
    const lo = Math.min(MIN_SPAN, fitSpan);
    const next = Math.min(fitSpan, Math.max(lo, span * factor));
    if (next >= fitSpan) {
      state.zoom = null;
    } else {
      const from = Math.min(Math.max(center - next / 2, fit.from), fit.to - next);
      state.zoom = { from: from, to: from + next };
    }
    render();
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

  function rowHtml(p) {
    const sel = p.id === state.selectedId;
    const agents = (p.lanes || []).map((l) => l.agent).join(", ");
    return (
      '<button type="button" class="row' + (sel ? " sel" : "") + '" data-id="' + esc(p.id) + '"' +
      (sel ? ' aria-current="true"' : "") + ">" +
      '<span class="row-top">' +
      '<span class="row-time">' + fmtClock(p.startedAt) + "</span>" +
      (p.live ? '<span class="chip live" title="El prompt sigue en curso">LIVE</span>' : "") +
      '<span class="row-dur">' + fmtDur(p.endedAt - p.startedAt) + "</span>" +
      "</span>" +
      '<span class="row-text" title="' + esc(p.prompt) + '">' + esc(p.prompt) + "</span>" +
      '<span class="row-foot">' +
      '<span class="row-agents" title="' + esc(agents || "Sin agentes") + '">' + esc(agents || "—") + "</span>" +
      '<span class="row-io" title="ENT incluye entrada y caché">ENT ' + fmtTokens(entryTokens(p)) +
      " · SAL " + fmtTokens(p.output) + "</span>" +
      '<span class="row-cost" title="Lo que costó el prompt">' + fmtCost(p) + "</span>" +
      "</span>" +
      "</button>"
    );
  }

  function segHtml(lane, seg, w) {
    const span = Math.max(1, w.to - w.from);
    const left = Math.max(0, Math.min(100, ((num(seg.start) - w.from) / span) * 100));
    const right = Math.max(0, Math.min(100, ((num(seg.end) - w.from) / span) * 100));
    // Un tramo instantáneo no puede quedar invisible.
    const width = Math.max(0.5, right - left);
    const tip =
      lane.agent + " · " + fmtClock(seg.start) + "–" + fmtClock(seg.end) +
      " · " + fmtDur(seg.end - seg.start) +
      " · " + fmtTokens(lane.total) + " tokens · " + fmtCost(lane);
    return (
      '<span class="seg' + (lane.root ? " root" : "") +
      '" style="left:' + left.toFixed(3) + "%;width:" + width.toFixed(3) +
      "%;--c:" + esc(safeColor(lane.color)) + '" title="' + esc(tip) + '"></span>'
    );
  }

  function laneHtml(lane, w) {
    const kind = lane.root ? "Principal" : "Subagente";
    return (
      '<div class="lane">' +
      '<div class="lane-info">' +
      '<span class="lane-icon ' + (lane.root ? "root" : "sub") +
      '" style="--c:' + esc(safeColor(lane.color)) + '" title="' + esc(kind) + '"></span>' +
      '<span class="lane-name" title="' + esc(lane.agent) + '">' + esc(lane.agent) + "</span>" +
      '<span class="chip" title="Tokens de esta fila">' + fmtTokens(lane.total) + "</span>" +
      '<span class="chip" title="Coste de esta fila">' + fmtCost(lane) + "</span>" +
      "</div>" +
      '<div class="lane-track">' + lane.segments.map((s) => segHtml(lane, s, w)).join("") + "</div>" +
      "</div>"
    );
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

  function axisHtml(p, w) {
    const span = Math.max(1, w.to - w.from);
    const step = tickStep(span);
    const marks = [];
    for (let t = Math.ceil(w.from / step) * step; t <= w.to && marks.length < 40; t += step) {
      const left = ((t - w.from) / span) * 100;
      marks.push(
        '<span class="tick" style="left:' + left.toFixed(3) +
        '%"><span class="tick-label">' + esc(fmtOffset(t - p.startedAt)) + "</span></span>"
      );
    }
    return '<div class="axis-row"><span class="axis-gutter"></span><span class="axis-track">' +
      marks.join("") + "</span></div>";
  }

  function renderHead(s) {
    if (!s) {
      return;
    }
    const on = !!s.monitor;
    el.subtitle.textContent =
      (s.project ? s.project : "Sin proyecto") + " · " + s.savedCount + " guardados del proyecto · sondeo " +
      fmtClock(s.scannedAt);
    el.monitor.classList.toggle("on", on);
    el.monitor.setAttribute("aria-pressed", on ? "true" : "false");
    el.chip.textContent = on ? "GRABANDO" : "EN PAUSA";
    el.chip.classList.toggle("on", on);
    el.chip.title = on
      ? "Se están guardando los prompts nuevos"
      : "La monitorización está apagada";
    el.notice.hidden = on;
    el.notice.textContent = on
      ? ""
      : "La monitorización está apagada: no se escanea ni se guardará ningún prompt.";
    el.banner.hidden = !!s.ok;
    el.banner.textContent = s.ok ? "" : s.error || "Error desconocido al leer las estadísticas.";
  }

  function renderList(prompts) {
    el.listCount.textContent = String(prompts.length);
    if (prompts.length === 0) {
      el.list.innerHTML = '<p class="empty">' + esc(emptyText()) + "</p>";
      return;
    }
    el.list.innerHTML = prompts.map(rowHtml).join("");
  }

  function renderDetail(prompt) {
    if (!prompt) {
      el.detail.hidden = true;
      el.detailEmpty.hidden = false;
      el.detailEmpty.textContent = emptyText();
      // Sin selección la línea de tiempo se vacía: nada residual ni NaN.
      el.title.textContent = "";
      el.meta.textContent = "";
      el.range.textContent = "—";
      el.zoomLabel.textContent = "x1.00";
      el.lanes.innerHTML = "";
      el.axis.innerHTML = "";
      return;
    }
    el.detail.hidden = false;
    el.detailEmpty.hidden = true;

    const w = windowOf(prompt);
    const fit = fitRange(prompt);
    const span = Math.max(1, w.to - w.from);

    el.title.textContent = prompt.prompt;
    el.title.title = prompt.prompt;
    el.meta.textContent =
      fmtClock(prompt.startedAt) + " → " + (prompt.live ? "en curso" : fmtClock(prompt.endedAt)) +
      " · " + fmtDur(prompt.endedAt - prompt.startedAt) +
      " · " + fmtTokens(prompt.total) + " tokens · " + fmtCost(prompt);
    el.meta.title =
      "Entrada (con caché): " + fmtTokens(entryTokens(prompt)) +
      " · Caché leída: " + fmtTokens(prompt.cacheRead) +
      " · Caché escrita: " + fmtTokens(prompt.cacheWrite) +
      " · Salida: " + fmtTokens(prompt.output) +
      " · Razonamiento: " + fmtTokens(prompt.reasoning);
    el.range.textContent = fmtOffset(w.from - prompt.startedAt) + " → " + fmtOffset(w.to - prompt.startedAt);
    el.zoomLabel.textContent = "x" + (span > 0 ? (fit.to - fit.from) / span : 1).toFixed(2);

    el.lanes.innerHTML = (prompt.lanes || []).length
      ? (prompt.lanes || []).map((l) => laneHtml(l, w)).join("")
      : '<p class="empty">Este prompt todavía no tiene actividad de ningún agente.</p>';
    el.axis.innerHTML = axisHtml(prompt, w);
  }

  function render() {
    const s = state.snapshot;
    if (!s) {
      return;
    }
    renderHead(s);
    // El host conserva los registros aunque el último escaneo fallara: se pintan igual.
    const prompts = promptsOf(s);
    // Solo se cambia la selección si el prompt elegido desapareció: uno nuevo no la roba.
    if (!prompts.some((p) => p.id === state.selectedId)) {
      setSelection(defaultId(prompts));
    }
    renderList(prompts);
    renderDetail(currentPrompt());
  }

  /* ── Interacción ─────────────────────────────────────── */
  el.list.addEventListener("click", (ev) => {
    const row = ev.target && ev.target.closest ? ev.target.closest(".row") : null;
    if (!row || !row.dataset) {
      return;
    }
    const id = row.dataset.id;
    if (id && id !== state.selectedId) {
      setSelection(id);
      render();
    }
  });

  el.monitor.addEventListener("click", () => send({ type: "setMonitor", on: !monitorOn() }));
  el.refresh.addEventListener("click", () => send({ type: "refresh" }));
  el.clear.addEventListener("click", () => send({ type: "clear" }));
  el.zoomIn.addEventListener("click", () => zoomBy(0.8));
  el.zoomOut.addEventListener("click", () => zoomBy(1.25));
  el.zoomFit.addEventListener("click", () => {
    state.zoom = null;
    render();
  });

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

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg && msg.type === "promptStats") {
      state.snapshot = msg.payload;
      render();
    }
  });

  send({ type: "ready" });
})();