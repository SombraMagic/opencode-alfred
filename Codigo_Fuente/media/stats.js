(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    snapshot: null,
    sortKey: "total",
    sortDir: "desc",
    filter: "",
  };

  const el = {
    subtitle: document.getElementById("subtitle"),
    banner: document.getElementById("banner"),
    totals: document.getElementById("totals"),
    tbody: document.getElementById("tbody"),
    search: document.getElementById("search"),
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

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

  function fmtCost(c) {
    c = Number(c) || 0;
    if (c <= 0) return "$0";
    if (c < 0.0001) return "<$0.0001";
    if (c < 1) return "$" + c.toFixed(4);
    return "$" + c.toFixed(2);
  }

  function fmtRelative(ts) {
    if (!ts) return "—";
    const d = Date.now() - ts;
    if (d < 0) return "ahora";
    const s = Math.floor(d / 1000);
    if (s < 5) return "ahora";
    if (s < 60) return "hace " + s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return "hace " + m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return "hace " + h + "h";
    return "hace " + Math.floor(h / 24) + "d";
  }

  function valueFor(a, key) {
    switch (key) {
      case "agent":
        return a.agent.toLowerCase();
      case "state":
        return a.working ? 1 : 0;
      case "total":
        return a.tokens.total;
      case "input":
        return a.tokens.input;
      case "output":
        return a.tokens.output;
      case "reasoning":
        return a.tokens.reasoning;
      case "cache":
        return a.tokens.cacheRead;
      case "cost":
        return a.cost;
      case "workMs":
        return a.workMs;
      case "sessions":
        return a.sessions;
      case "messages":
        return a.messages;
      case "lastActive":
        return a.lastActive;
      default:
        return 0;
    }
  }

  function renderSubtitle() {
    const s = state.snapshot;
    if (!s) {
      return;
    }
    const stamp = new Date(s.scannedAt).toLocaleTimeString();
    const base = s.agents.length + " agentes · " + s.dbs.length + " BD · " + s.dataDir;
    el.subtitle.textContent = base + " · actualizado " + stamp;
  }

  function renderBanner() {
    const s = state.snapshot;
    if (s && !s.ok && s.error) {
      el.banner.hidden = false;
      el.banner.textContent = s.error;
    } else {
      el.banner.hidden = true;
    }
  }

  function statCard(k, v) {
    return '<div class="stat"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + "</span></div>";
  }

  function renderTotals() {
    const t = state.snapshot && state.snapshot.totals;
    if (!t) {
      el.totals.innerHTML = "";
      return;
    }
    const active = state.snapshot.agents.filter((a) => a.working).length;
    el.totals.innerHTML = [
      statCard("Tokens", fmtTokens(t.tokens.total)),
      statCard("Entrada", fmtTokens(t.tokens.input)),
      statCard("Salida", fmtTokens(t.tokens.output)),
      statCard("Coste", fmtCost(t.cost)),
      statCard("Tiempo", fmtDuration(t.workMs)),
      statCard("Sesiones", String(t.sessions)),
      statCard("Mensajes", String(t.messages)),
      statCard("Activos", String(active)),
    ].join("");
  }

  function renderTable() {
    const s = state.snapshot;
    if (!s) {
      return;
    }
    const filter = state.filter.trim().toLowerCase();
    let agents = s.agents.filter((a) => !filter || a.agent.toLowerCase().includes(filter));

    const dir = state.sortDir === "asc" ? 1 : -1;
    agents = agents.slice().sort((a, b) => {
      const va = valueFor(a, state.sortKey);
      const vb = valueFor(b, state.sortKey);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.agent.localeCompare(b.agent);
    });

    const now = Date.now();
    const rows = agents.map((a) => {
      const working = !!a.working;
      const stateCell = working
        ? '<span class="badge working">working</span>'
        : '<span class="badge idle">inactivo</span>';
      return (
        '<tr class="' + (working ? "working" : "") + '">' +
        '<td class="agent">' + esc(a.agent) + "</td>" +
        '<td><span class="state">' + stateCell + "</span></td>" +
        '<td class="num">' + fmtTokens(a.tokens.total) + "</td>" +
        '<td class="num">' + fmtTokens(a.tokens.input) + "</td>" +
        '<td class="num">' + fmtTokens(a.tokens.output) + "</td>" +
        '<td class="num">' + fmtTokens(a.tokens.reasoning) + "</td>" +
        '<td class="num">' + fmtTokens(a.tokens.cacheRead) + "</td>" +
        '<td class="num">' + fmtCost(a.cost) + "</td>" +
        '<td class="num">' + fmtDuration(a.workMs) + "</td>" +
        '<td class="num">' + a.sessions + "</td>" +
        '<td class="num">' + a.messages + "</td>" +
        '<td>' + fmtRelative(a.lastActive) + "</td>" +
        '<td class="actions">' +
        '<button class="secondary mini" data-act="reset" data-agent="' + esc(a.agent) + '">Reiniciar</button>' +
        '<button class="secondary mini" data-act="clear" data-agent="' + esc(a.agent) + '">Ver histórico</button>' +
        "</td>" +
        "</tr>"
      );
    });
    el.tbody.innerHTML = rows.join("") || '<tr><td colspan="13">Sin agentes.</td></tr>';

    document.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.toggle("sorted-asc", th.dataset.key === state.sortKey && state.sortDir === "asc");
      th.classList.toggle("sorted-desc", th.dataset.key === state.sortKey && state.sortDir === "desc");
    });
  }

  function renderAll() {
    renderSubtitle();
    renderBanner();
    renderTotals();
    renderTable();
  }

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = key === "agent" ? "asc" : "desc";
      }
      renderTable();
    });
  });

  el.search.addEventListener("input", () => {
    state.filter = el.search.value;
    renderTable();
  });

  el.tbody.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) {
      return;
    }
    const agent = btn.dataset.agent;
    if (btn.dataset.act === "reset") {
      vscode.postMessage({ type: "reset", agent: agent });
    } else if (btn.dataset.act === "clear") {
      vscode.postMessage({ type: "clear", agent: agent });
    }
  });

  document.getElementById("btn-refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  document.getElementById("btn-reset-all").addEventListener("click", () => vscode.postMessage({ type: "resetAll" }));
  document.getElementById("btn-clear-all").addEventListener("click", () => vscode.postMessage({ type: "clearAll" }));

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "stats") {
      state.snapshot = msg.payload;
      renderAll();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
