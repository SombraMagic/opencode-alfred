/* ALFRED // PROJECT EXPLORER — Controlador del explorador del proyecto */
(function () {
  "use strict";

  // Puente con VS Code o modo demo si se abre fuera de la extensión.
  let vscode;
  let isDemo = false;
  if (typeof acquireVsCodeApi === "function") {
    vscode = acquireVsCodeApi();
  } else {
    isDemo = true;
    vscode = {
      postMessage: function (msg) {
        console.log("[Demo] postMessage:", msg);
      },
      getState: function () { return null; },
      setState: function () {}
    };
  }

  const ROW_H = 30;

  const SVG_ARROW_UP = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SVG_ARROW_DOWN = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Estado global
  const state = {
    layout: "one",
    split: 0.5,
    clipboard: null, // { treeId, rel, mode: "copy"|"cut" }
    dragSource: null, // { treeId, rel, kind }
    branchModalTarget: "a"
  };

  // Estado por árbol ("a" y "b")
  const trees = {
    a: createTreeState("a"),
    b: createTreeState("b")
  };

  function createTreeState(id) {
    return {
      id: id,
      meta: null,
      rows: [],
      mode: "tree",
      query: "",
      filter: "all",
      truncated: false,
      selectedIndex: -1,
      busy: false,
      searchTimer: null,
      scan: { files: 0, dirs: 0, bytes: 0 },
      dom: {}
    };
  }

  // ── Iconos SVG por tipo ───────────────────────────────────
  const SVG_ICONS = {
    folder: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.4 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8z" stroke="#ffb000" stroke-width="1.2" fill="rgba(255,176,0,0.15)"/></svg>',
    folderOpen: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.4 1.5h6a1 1 0 0 1 1 1v2.5M1.5 6.5h13l-1.5 6.5h-11L1.5 6.5z" stroke="#ffb000" stroke-width="1.2" fill="rgba(255,176,0,0.25)"/></svg>',
    md: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="#00e5ff" stroke-width="1.2" fill="rgba(0,229,255,0.12)"/><path d="M4 10.5V5.5l2 2.5 2-2.5v5M12 8.5l-1.8 2-1.8-2M10.2 5.5v5" stroke="#00e5ff" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ts: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="rgba(0,229,255,0.15)" stroke="#00e5ff" stroke-width="1.1"/><path d="M4 6h4M6 6v6M9.5 10.5c.5.8 1.5.8 2 .3.4-.4.2-1.1-.5-1.3l-.8-.3c-.8-.3-1.1-1-.8-1.7.3-.8 1.2-1 2-.7" stroke="#00e5ff" stroke-width="1.1" stroke-linecap="round"/></svg>',
    js: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="rgba(255,176,0,0.15)" stroke="#ffb000" stroke-width="1.1"/><path d="M5.5 8v3a1 1 0 0 1-2 0M9 10.5c.5.8 1.5.8 2 .3.4-.4.2-1.1-.5-1.3l-.8-.3c-.8-.3-1.1-1-.8-1.7.3-.8 1.2-1 2-.7" stroke="#ffb000" stroke-width="1.1" stroke-linecap="round"/></svg>',
    json: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><text x="8" y="11" fill="#ffb000" font-family="monospace" font-size="10" font-weight="bold" text-anchor="middle">{ }</text></svg>',
    css: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" fill="rgba(255,45,149,0.12)" stroke="#ff2d95" stroke-width="1.1"/><path d="M5 6h6M4.5 10h6M7 4.5l-1 7M10 4.5l-1 7" stroke="#ff2d95" stroke-width="1.1" stroke-linecap="round"/></svg>',
    html: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M5 5L2 8l3 3M11 5l3 3-3 3M9.5 4l-3 8" stroke="#ff8c00" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    image: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#23d18b" stroke-width="1.1" fill="rgba(35,209,139,0.1)"/><circle cx="5.5" cy="5.5" r="1.5" fill="#23d18b"/><path d="M14 11l-4-4-5 5" stroke="#23d18b" stroke-width="1.1"/></svg>',
    video: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2" y="3" width="9" height="10" rx="1" stroke="#ff2d95" stroke-width="1.1" fill="rgba(255,45,149,0.1)"/><path d="M11 6.5l3-2v7l-3-2" stroke="#ff2d95" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    audio: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M6 12V4l6-1.5v8" stroke="#a970ff" stroke-width="1.2"/><circle cx="4.5" cy="12" r="2" fill="#a970ff"/><circle cx="10.5" cy="10.5" r="2" fill="#a970ff"/></svg>',
    zip: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="3" y="2" width="10" height="12" rx="1" stroke="#ffb000" stroke-width="1.1"/><path d="M7 3h2v2H7zM7 6h2v2H7zM7 9h2v2H7z" fill="#ffb000"/></svg>',
    sql: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><ellipse cx="8" cy="4" rx="5" ry="2" stroke="#00e5ff" stroke-width="1.1"/><path d="M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8" stroke="#00e5ff" stroke-width="1.1"/></svg>',
    py: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M7.5 2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4V7a1 1 0 0 0-1-1H5M8.5 14H11a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2H7v1a1 1 0 0 0 1 1h3" stroke="#ffb000" stroke-width="1.1" stroke-linecap="round"/><circle cx="4.5" cy="3.5" r=".7" fill="#00e5ff"/><circle cx="11.5" cy="12.5" r=".7" fill="#ffb000"/></svg>',
    go: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M2.5 8a4 4 0 1 0 4-4H4M9 8h5M11.5 5.5l2.5 2.5-2.5 2.5" stroke="#00e5ff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    rs: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><circle cx="8" cy="8" r="4.5" stroke="#ff8c00" stroke-width="1.2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M6.5 6.5h3a1.5 1.5 0 0 1 0 3h-3v-3zM8 9.5l2 2" stroke="#ff8c00" stroke-width="1.1"/></svg>',
    java: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M3 6h9v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6zM12 7h1.5a1.5 1.5 0 0 1 0 3H12" style="stroke:var(--danger)" stroke-width="1.1"/><path d="M6 3c0 1.5 2 1.5 2 3M9 2c0 1.5 2 1.5 2 3" style="stroke:var(--danger)" stroke-width="1" stroke-linecap="round"/></svg>',
    sh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1" stroke="#23d18b" stroke-width="1.1" fill="rgba(35,209,139,0.1)"/><path d="M4.5 5.5l2.5 2.5-2.5 2.5M8.5 11h3" stroke="#23d18b" stroke-width="1.1" stroke-linecap="round"/></svg>',
    lock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="3.5" y="7" width="9" height="7" rx="1" stroke="#ffb000" stroke-width="1.1" fill="rgba(255,176,0,0.15)"/><path d="M5.5 7V4.5a2.5 2.5 0 0 1 5 0V7" stroke="#ffb000" stroke-width="1.1"/></svg>',
    pdf: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M3 2.5h6.5L13 6v7.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" style="stroke:var(--danger)" stroke-width="1.1"/><path d="M9.5 2.5V6H13" style="stroke:var(--danger)" stroke-width="1"/><text x="8" y="12" style="fill:var(--danger)" font-size="6" font-family="sans-serif" font-weight="bold" text-anchor="middle">PDF</text></svg>',
    font: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M4 13L8 3l4 10M5.5 9.5h5" stroke="#a970ff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    binary: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="#23d18b" stroke-width="1.1"/><text x="5.5" y="7" fill="#23d18b" font-size="5" font-family="monospace">01</text><text x="5.5" y="11.5" fill="#23d18b" font-size="5" font-family="monospace">10</text></svg>',
    link: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1" stroke="#5d7d92" stroke-width="1.2" stroke-linecap="round"/></svg>',
    error: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><circle cx="8" cy="8" r="6" stroke="#ff2d95" stroke-width="1.2"/><path d="M8 5v3.5M8 11v.5" stroke="#ff2d95" stroke-width="1.3" stroke-linecap="round"/></svg>',
    file: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M3 2.5h6.5L13 6v7.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" stroke="#5d7d92" stroke-width="1.1"/><path d="M9.5 2.5V6H13" stroke="#5d7d92" stroke-width="1"/></svg>'
  };

  const EXT_ICONS = {
    md: "md", markdown: "md", mdown: "md",
    ts: "ts", tsx: "ts",
    js: "js", jsx: "js", mjs: "js", cjs: "js",
    json: "json", jsonc: "json",
    css: "css", scss: "css", less: "css",
    html: "html", htm: "html",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image", bmp: "image",
    mp4: "video", webm: "video", mkv: "video", avi: "video", mov: "video",
    mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio",
    zip: "zip", tar: "zip", gz: "zip", "7z": "zip", rar: "zip",
    sql: "sql", db: "sql", sqlite: "sql", sqlite3: "sql",
    py: "py", pyw: "py",
    go: "go",
    rs: "rs",
    java: "java", jar: "java",
    sh: "sh", bash: "sh", zsh: "sh", ps1: "sh", bat: "sh", cmd: "sh",
    lock: "lock",
    pdf: "pdf",
    woff: "font", woff2: "font", ttf: "font", otf: "font",
    wasm: "binary", bin: "binary", exe: "binary", dll: "binary", so: "binary"
  };

  function getRowIconSvg(row) {
    if ((row.kind === "missing" || row.error) && !(row.git && row.git.stashed)) return SVG_ICONS.error;
    if (row.kind === "link") return SVG_ICONS.link;
    if (row.kind === "dir") {
      return row.expanded ? SVG_ICONS.folderOpen : SVG_ICONS.folder;
    }
    const ext = (row.ext || "").toLowerCase().replace(/^\./, "");
    const iconType = EXT_ICONS[ext] || "file";
    return SVG_ICONS[iconType] || SVG_ICONS.file;
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || isNaN(bytes) || bytes < 0) return "—";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return (i === 0 ? val.toFixed(0) : val.toFixed(val < 10 ? 1 : 0)) + " " + units[i];
  }

  // ── Inicialización del DOM ─────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    initDomReferences();
    setupGlobalEvents();
    setupPanelEvents("a");
    setupPanelEvents("b");
    setupContextMenu();
    setupBranchModal();

    if (isDemo) {
      initDemoData();
    }

    vscode.postMessage({ type: "ready" });
  });

  function initDomReferences() {
    state.domContainer = document.getElementById("panels-container");
    state.domBtnLayout = document.getElementById("btn-toggle-layout");
    state.domLabelLayout = document.getElementById("label-layout");
    state.domResizer = document.getElementById("split-resizer");
    state.domContextMenu = document.getElementById("context-menu");
    state.domToast = document.getElementById("toast-notice");
    state.domToastText = document.getElementById("toast-text");
    state.domBranchModal = document.getElementById("branch-modal");
    state.domBranchInput = document.getElementById("branch-modal-input");
    state.domBranchOk = document.getElementById("branch-modal-ok");
    state.domBranchCancel = document.getElementById("branch-modal-cancel");

    bindPanelDom("a");
    bindPanelDom("b");
  }

  function bindPanelDom(id) {
    const t = trees[id];
    t.dom = {
      panel: document.getElementById("panel-" + id),
      rootPath: document.getElementById(id + "-root-path"),
      btnRoot: document.getElementById(id + "-btn-root"),
      btnHidden: document.getElementById(id + "-btn-hidden"),
      btnSorts: document.querySelectorAll("#panel-" + id + " .pe-sort-btn"),
      btnSortDir: document.getElementById(id + "-btn-sort-dir"),
      btnRefresh: document.getElementById(id + "-btn-refresh"),
      // Git
      gitBar: document.getElementById(id + "-git-bar"),
      gitBranch: document.getElementById(id + "-git-branch"),
      gitSync: document.getElementById(id + "-git-sync"),
      btnFetch: document.getElementById(id + "-btn-fetch"),
      btnPull: document.getElementById(id + "-btn-pull"),
      btnPush: document.getElementById(id + "-btn-push"),
      btnGitRefresh: document.getElementById(id + "-btn-git-refresh"),
      selectBranch: document.getElementById(id + "-select-branch"),
      btnNewBranch: document.getElementById(id + "-btn-new-branch"),
      btnStageAll: document.getElementById(id + "-btn-stage-all"),
      inputCommit: document.getElementById(id + "-input-commit"),
      btnCommit: document.getElementById(id + "-btn-commit"),
      // Búsqueda y chips
      searchInput: document.getElementById(id + "-search-input"),
      searchClear: document.getElementById(id + "-search-clear"),
      searchSpinner: document.getElementById(id + "-search-spinner"),
      filterChips: document.querySelectorAll("#panel-" + id + " .pe-filter-chip"),
      countChanged: document.getElementById(id + "-count-changed"),
      countStaged: document.getElementById(id + "-count-staged"),
      countUnpushed: document.getElementById(id + "-count-unpushed"),
      countConflict: document.getElementById(id + "-count-conflict"),
      countStashed: document.getElementById(id + "-count-stashed"),
      // Árbol
      treeScroll: document.getElementById(id + "-tree-scroll"),
      treePhantom: document.getElementById(id + "-tree-phantom"),
      treeViewport: document.getElementById(id + "-tree-viewport"),
      treeEmpty: document.getElementById(id + "-tree-empty"),
      emptyText: document.getElementById(id + "-empty-text"),
      // Pie
      footerStats: document.getElementById(id + "-footer-stats"),
      tagNogit: document.getElementById(id + "-tag-nogit"),
      tagTruncated: document.getElementById(id + "-tag-truncated"),
      scanProgress: document.getElementById(id + "-scan-progress"),
      statusLine: document.getElementById(id + "-status-line"),
      statusSpinner: document.querySelector("#" + id + "-status-line .pe-status-spinner"),
      statusText: document.getElementById(id + "-status-text")
    };
  }

  // ── Eventos globales y Split ──────────────────────────────
  function setupGlobalEvents() {
    // Alternar 1 / 2 columnas
    state.domBtnLayout.addEventListener("click", () => {
      const next = state.layout === "one" ? "two" : "one";
      applyLayout(next);
      vscode.postMessage({ type: "setLayout", layout: next });
    });

    // Arrastre del separador
    let dragging = false;
    state.domResizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      state.domResizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = state.domContainer.getBoundingClientRect();
      let ratio = (e.clientX - rect.left) / rect.width;
      if (ratio < 0.2) ratio = 0.2;
      if (ratio > 0.8) ratio = 0.8;
      applySplit(ratio);
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      state.domResizer.classList.remove("dragging");
      document.body.style.cursor = "";
      vscode.postMessage({ type: "setSplit", ratio: state.split });
    });
  }

  function applyLayout(layout) {
    state.layout = layout;
    if (layout === "two") {
      state.domContainer.classList.remove("layout-one");
      state.domContainer.classList.add("layout-two");
      state.domLabelLayout.textContent = "1 COLUMNA";
    } else {
      state.domContainer.classList.remove("layout-two");
      state.domContainer.classList.add("layout-one");
      state.domLabelLayout.textContent = "2 COLUMNAS";
    }
    renderVirtualRows("a");
    if (layout === "two") renderVirtualRows("b");
  }

  function applySplit(ratio) {
    state.split = ratio;
    state.domContainer.style.setProperty("--split-ratio", String(ratio));
  }

  // ── Eventos de panel ──────────────────────────────────────
  function setupPanelEvents(id) {
    const t = trees[id];
    const d = t.dom;

    // Barra de raíz
    d.btnRoot.addEventListener("click", () => vscode.postMessage({ type: "chooseRoot", treeId: id }));
    d.btnHidden.addEventListener("click", () => vscode.postMessage({ type: "toggleHidden", treeId: id }));
    if (d.btnSorts) {
      d.btnSorts.forEach((btn) => {
        btn.addEventListener("click", () => {
          const sort = btn.dataset.sort;
          if (sort) vscode.postMessage({ type: "setSort", treeId: id, sort: sort });
        });
      });
    }
    if (d.btnSortDir) {
      d.btnSortDir.addEventListener("click", () => {
        const nextDir = (t.meta && t.meta.sortDir === "asc") ? "desc" : "asc";
        vscode.postMessage({ type: "setSortDir", treeId: id, dir: nextDir });
      });
    }
    d.btnRefresh.addEventListener("click", () => vscode.postMessage({ type: "refresh", treeId: id }));

    // Tira Git
    d.btnFetch.addEventListener("click", () => vscode.postMessage({ type: "git", treeId: id, action: "fetch" }));
    d.btnPull.addEventListener("click", () => vscode.postMessage({ type: "git", treeId: id, action: "pull" }));
    d.btnPush.addEventListener("click", () => vscode.postMessage({ type: "git", treeId: id, action: "push" }));
    d.btnGitRefresh.addEventListener("click", () => vscode.postMessage({ type: "git", treeId: id, action: "refresh" }));

    d.selectBranch.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val) vscode.postMessage({ type: "git", treeId: id, action: "checkout", branch: val });
    });

    d.btnNewBranch.addEventListener("click", () => {
      state.branchModalTarget = id;
      state.domBranchInput.value = "";
      state.domBranchModal.hidden = false;
      state.domBranchInput.focus();
    });

    d.btnStageAll.addEventListener("click", () => {
      vscode.postMessage({ type: "git", treeId: id, action: "stageAll" });
    });

    function doCommit() {
      const msg = d.inputCommit.value.trim();
      if (!msg) return;
      vscode.postMessage({ type: "git", treeId: id, action: "commit", message: msg });
      d.inputCommit.value = "";
    }
    d.btnCommit.addEventListener("click", doCommit);
    d.inputCommit.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doCommit();
      }
    });

    // Buscador
    d.searchInput.addEventListener("input", (e) => {
      const val = e.target.value;
      d.searchClear.style.display = val ? "block" : "none";
      if (t.searchTimer) clearTimeout(t.searchTimer);
      d.searchSpinner.hidden = false;
      t.searchTimer = setTimeout(() => {
        d.searchSpinner.hidden = true;
        vscode.postMessage({ type: "search", treeId: id, query: val });
      }, 220);
    });

    d.searchClear.addEventListener("click", () => {
      d.searchInput.value = "";
      d.searchClear.style.display = "none";
      d.searchInput.focus();
      vscode.postMessage({ type: "search", treeId: id, query: "" });
    });

    // Chips de filtro
    d.filterChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const filter = chip.dataset.filter;
        d.filterChips.forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        vscode.postMessage({ type: "setFilter", treeId: id, filter });
      });
    });

    // Scroll virtualizado
    d.treeScroll.addEventListener("scroll", () => {
      renderVirtualRows(id);
    });

    // Teclado en el árbol
    d.treeScroll.addEventListener("keydown", (e) => {
      // Ignorar si el foco está en input o select
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
      handleTreeKeydown(id, e);
    });

    // Drag & Drop en el fondo del árbol (para transferir a la raíz)
    d.treeScroll.addEventListener("dragover", (e) => {
      if (!state.dragSource) return;
      e.preventDefault();
      d.treeScroll.classList.add("drag-over-root");
    });
    d.treeScroll.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && d.treeScroll.contains(e.relatedTarget)) return;
      d.treeScroll.classList.remove("drag-over-root");
    });
    d.treeScroll.addEventListener("drop", (e) => {
      e.preventDefault();
      d.treeScroll.classList.remove("drag-over-root");
      if (!state.dragSource) return;
      // Si se soltó en el fondo del scroll, el destino es la raíz ""
      const mode = (e.ctrlKey || e.metaKey) ? "copy" : "move";
      vscode.postMessage({
        type: "transfer",
        fromTree: state.dragSource.treeId,
        fromRel: state.dragSource.rel,
        toTree: id,
        toDir: "",
        mode: mode
      });
      state.dragSource = null;
    });
  }

  // ── Manejo de teclado en el árbol ─────────────────────────
  function handleTreeKeydown(id, e) {
    const t = trees[id];
    const rows = t.rows;
    if (!rows || rows.length === 0) return;

    let idx = t.selectedIndex;
    if (idx < 0) idx = 0;

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        idx = Math.min(rows.length - 1, idx + 1);
        selectRow(id, idx, true);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        idx = Math.max(0, idx - 1);
        selectRow(id, idx, true);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const row = rows[idx];
        if (row) {
          if (row.kind === "dir" && row.expanded && t.mode !== "result") {
            vscode.postMessage({ type: "collapse", treeId: id, rel: row.rel });
          } else if (row.depth > 0) {
            // Buscar carpeta padre
            for (let i = idx - 1; i >= 0; i--) {
              if (rows[i].depth < row.depth) {
                selectRow(id, i, true);
                break;
              }
            }
          }
        }
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        const row = rows[idx];
        if (row && row.kind === "dir") {
          if (!row.expanded && t.mode !== "result") {
            vscode.postMessage({ type: "expand", treeId: id, rel: row.rel });
          } else if (idx + 1 < rows.length && rows[idx + 1].depth > row.depth) {
            selectRow(id, idx + 1, true);
          }
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        const row = rows[idx];
        if (row) {
          if (row.kind === "dir") {
            if (t.mode !== "result") {
              const action = row.expanded ? "collapse" : "expand";
              vscode.postMessage({ type: action, treeId: id, rel: row.rel });
            }
          } else if (row.kind !== "missing") {
            vscode.postMessage({ type: "open", treeId: id, rel: row.rel });
          }
        }
        break;
      }
      case "Delete": {
        e.preventDefault();
        const row = rows[idx];
        if (row && row.kind !== "missing") {
          vscode.postMessage({ type: "delete", treeId: id, rel: row.rel });
        }
        break;
      }
    }
  }

  function selectRow(id, index, scrollIntoView) {
    const t = trees[id];
    t.selectedIndex = index;
    renderVirtualRows(id);

    if (scrollIntoView && t.dom.treeScroll) {
      const top = index * ROW_H;
      const bottom = top + ROW_H;
      const sTop = t.dom.treeScroll.scrollTop;
      const sHeight = t.dom.treeScroll.clientHeight;

      if (top < sTop) {
        t.dom.treeScroll.scrollTop = top;
      } else if (bottom > sTop + sHeight) {
        t.dom.treeScroll.scrollTop = bottom - sHeight;
      }
    }
  }

  // ── Render virtualizado ───────────────────────────────────
  function renderVirtualRows(id) {
    const t = trees[id];
    const d = t.dom;
    if (!d.treeScroll) return;

    const rows = t.rows || [];
    const total = rows.length;

    d.treePhantom.style.height = (total * ROW_H) + "px";

    if (total === 0) {
      d.treeViewport.innerHTML = "";
      d.treeEmpty.hidden = false;
      d.emptyText.textContent = t.query
        ? "Sin resultados para la búsqueda"
        : (t.filter && t.filter !== "all")
          ? "Sin resultados para el filtro"
          : "Carpeta vacía";
      return;
    }

    d.treeEmpty.hidden = true;

    const scrollTop = d.treeScroll.scrollTop;
    const viewHeight = d.treeScroll.clientHeight || 400;

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 12);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewHeight) / ROW_H) + 12);

    d.treeViewport.style.transform = "translateY(" + (startIdx * ROW_H) + "px)";

    // Construir fragmento DOM sin innerHTML para nombres de usuario
    const frag = document.createDocumentFragment();

    for (let i = startIdx; i < endIdx; i++) {
      const row = rows[i];
      const elRow = createRowElement(id, row, i);
      frag.appendChild(elRow);
    }

    d.treeViewport.innerHTML = "";
    d.treeViewport.appendChild(frag);
  }

  function createRowElement(treeId, row, index) {
    const t = trees[treeId];
    const el = document.createElement("div");
    el.className = "pe-row";
    el.dataset.index = String(index);
    el.dataset.rel = row.rel;
    el.dataset.kind = row.kind;

    if (index === t.selectedIndex) el.classList.add("selected");
    if (row.kind === "missing" && !(row.git && row.git.stashed)) el.classList.add("missing");
    if (row.ext && row.ext.toLowerCase() === "md") el.classList.add("is-md");
    if (row.git && row.git.state === "untracked") el.classList.add("pe-row-new");
    if (row.git && (row.git.state === "conflict" || row.git.conflict === true)) el.classList.add("pe-row-conflict");

    // Arrastrable si no es missing ni raíz
    if (row.kind !== "missing" && row.rel !== "") {
      el.draggable = true;
    }

    // Indentación
    if (row.depth > 0) {
      const elIndent = document.createElement("div");
      elIndent.className = "pe-row-indent";
      for (let d = 0; d < row.depth; d++) {
        const guide = document.createElement("div");
        guide.className = "pe-row-guide";
        elIndent.appendChild(guide);
      }
      el.appendChild(elIndent);
    }

    // Chevron para carpetas (oculto en modo resultado, manteniendo hueco para alinear)
    const elChevron = document.createElement("div");
    elChevron.className = "pe-chevron";
    if (row.kind === "dir" && t.mode !== "result") {
      if (row.expanded) elChevron.classList.add("expanded");
      if (row.hasChildren) {
        elChevron.innerHTML = '<svg class="pe-chevron-icon" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 3.5L10.5 8 6 12.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
    }
    el.appendChild(elChevron);

    // Icono SVG
    const elIcon = document.createElement("div");
    elIcon.className = "pe-row-icon";
    elIcon.innerHTML = getRowIconSvg(row);
    el.appendChild(elIcon);

    // Nombre (textContent estricto)
    const elName = document.createElement("span");
    elName.className = "pe-row-name";
    elName.textContent = row.name || row.rel;
    elName.title = row.rel;
    el.appendChild(elName);

    // Insignias Git
    if (row.git || row.folderGit) {
      const elGit = document.createElement("div");
      elGit.className = "pe-row-git";

      if (row.folderGit) {
        const dot = document.createElement("span");
        dot.className = "pe-folder-git-dot";
        dot.title = "Cambios Git en esta carpeta";
        elGit.appendChild(dot);
      }

      if (row.git) {
        const g = row.git;
        // Estado
        if (g.state === "conflict" || g.conflict === true) {
          appendGitBadge(elGit, "!", "c", "Conflicto al hacer pull");
        } else if (g.state === "modified") {
          appendGitBadge(elGit, "M", "m", "Modificado");
        } else if (g.state === "staged") {
          appendGitBadge(elGit, "S", "s", "Preparado (staged)");
        } else if (g.state === "untracked") {
          appendGitBadge(elGit, "?", "u", "Nuevo / Sin seguimiento");
        } else if (g.state === "deleted") {
          appendGitBadge(elGit, "D", "d", "Eliminado");
        } else if (g.state === "renamed") {
          appendGitBadge(elGit, "R", "r", "Renombrado");
        }

        if (g.unpushed) {
          appendGitBadge(elGit, "↑", "p", "Sin push");
        }
        if (g.stashed) {
          appendGitBadge(elGit, "A", "a", "Apartado por Alfred (stash)");
        }

        if (typeof g.added === "number" && g.added > 0) {
          const add = document.createElement("span");
          add.className = "pe-git-diff-added";
          add.textContent = "+" + g.added;
          elGit.appendChild(add);
        }
        if (typeof g.removed === "number" && g.removed > 0) {
          const rem = document.createElement("span");
          rem.className = "pe-git-diff-removed";
          rem.textContent = "−" + g.removed;
          elGit.appendChild(rem);
        }
      }

      el.appendChild(elGit);
    }

    // Barra de porcentaje
    const elBarWrap = document.createElement("div");
    elBarWrap.className = "pe-row-bar-wrap";
    if (typeof row.pct === "number" && row.pct > 0) {
      const fill = document.createElement("div");
      fill.className = "pe-row-bar-fill";
      fill.style.width = Math.min(100, Math.max(0, row.pct)) + "%";
      elBarWrap.appendChild(fill);
    }
    el.appendChild(elBarWrap);

    // Texto de porcentaje
    const elPct = document.createElement("span");
    elPct.className = "pe-row-pct";
    elPct.textContent = (typeof row.pct === "number" && row.pct > 0) ? (row.pct.toFixed(0) + "%") : "";
    el.appendChild(elPct);

    // Tamaño
    const elSize = document.createElement("span");
    elSize.className = "pe-row-size";
    elSize.textContent = (row.kind === "dir" && row.size === 0) ? "—" : formatBytes(row.size);
    el.appendChild(elSize);

    // ── Listeners de la fila ────────────────────────────────
    elChevron.addEventListener("click", (e) => {
      e.stopPropagation();
      if (row.kind === "dir" && t.mode !== "result") {
        const action = row.expanded ? "collapse" : "expand";
        vscode.postMessage({ type: action, treeId, rel: row.rel });
      }
    });

    el.addEventListener("click", () => {
      selectRow(treeId, index, false);
    });

    el.addEventListener("dblclick", () => {
      if (row.kind === "dir") {
        if (t.mode !== "result") {
          const action = row.expanded ? "collapse" : "expand";
          vscode.postMessage({ type: action, treeId, rel: row.rel });
        }
      } else if (row.kind !== "missing") {
        vscode.postMessage({ type: "open", treeId, rel: row.rel });
      }
    });

    // Drag & Drop
    el.addEventListener("dragstart", (e) => {
      if (row.kind === "missing") {
        e.preventDefault();
        return;
      }
      state.dragSource = { treeId, rel: row.rel, kind: row.kind };
      e.dataTransfer.setData("text/plain", row.rel);
      e.dataTransfer.effectAllowed = "copyMove";
    });

    el.addEventListener("dragover", (e) => {
      if (!state.dragSource) return;
      if (row.kind !== "dir") return;
      // No permitir soltar sobre sí mismo o subcarpetas
      if (state.dragSource.treeId === treeId && (state.dragSource.rel === row.rel || row.rel.startsWith(state.dragSource.rel + "/"))) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("drag-over");
    });

    el.addEventListener("dragleave", () => {
      el.classList.remove("drag-over");
    });

    el.addEventListener("drop", (e) => {
      el.classList.remove("drag-over");
      if (!state.dragSource) return;
      if (row.kind !== "dir") return;
      if (state.dragSource.treeId === treeId && (state.dragSource.rel === row.rel || row.rel.startsWith(state.dragSource.rel + "/"))) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const mode = (e.ctrlKey || e.metaKey) ? "copy" : "move";
      vscode.postMessage({
        type: "transfer",
        fromTree: state.dragSource.treeId,
        fromRel: state.dragSource.rel,
        toTree: treeId,
        toDir: row.rel,
        mode: mode
      });
      state.dragSource = null;
    });

    return el;
  }

  function appendGitBadge(parent, char, typeClass, title) {
    const badge = document.createElement("span");
    badge.className = "pe-git-badge " + typeClass;
    badge.textContent = char;
    badge.title = title;
    parent.appendChild(badge);
  }

  // ── Menú Contextual ───────────────────────────────────────
  let ctxTarget = null; // { treeId, rel, kind, row, filter }

  function setupContextMenu() {
    const menu = state.domContextMenu;

    // capture: true para capturar contextmenu y evitar el menú nativo de VS Code en el árbol
    window.addEventListener(
      "contextmenu",
      (e) => {
        // Permitir el menú nativo de VS Code en campos de texto y selects
        if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable='true']")) {
          menu.hidden = true;
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        const rowEl = e.target.closest(".pe-row");
        const scrollEl = e.target.closest(".pe-tree-scroll");

        if (!rowEl && !scrollEl) {
          menu.hidden = true;
          return;
        }

        let treeId = "a";
        let rel = "";
        let kind = "dir";
        let row = null;

        if (rowEl) {
          const panel = rowEl.closest(".pe-panel");
          treeId = panel ? panel.dataset.tree : "a";
          rel = rowEl.dataset.rel || "";
          kind = rowEl.dataset.kind || "file";
          const idx = parseInt(rowEl.dataset.index, 10);
          if (!isNaN(idx)) {
            selectRow(treeId, idx, false);
            const rList = trees[treeId] ? trees[treeId].rows : null;
            row = (rList && rList[idx]) ? rList[idx] : null;
          }
        } else if (scrollEl) {
          const panel = scrollEl.closest(".pe-panel");
          treeId = panel ? panel.dataset.tree : "a";
          rel = "";
          kind = "dir";
          row = null;
        }

        const filter = (trees[treeId] && trees[treeId].filter) ? trees[treeId].filter : "all";
        ctxTarget = { treeId, rel, kind, row, filter };

        const isFile = kind !== "dir" && kind !== "missing";
        const isDir = kind === "dir";
        const isMissing = kind === "missing";

        const g = row && row.git ? row.git : null;
        const gitState = g ? g.state : null;
        const isConflict = !!(g && (gitState === "conflict" || g.conflict === true));
        const isStagedFlag = g ? (gitState === "staged" || g.staged === true) : false;

        // diff: solo fichero ("file") con row.git y estado modified, staged o renamed
        const canDiff = kind === "file" && !!g && (
          gitState === "modified" ||
          gitState === "staged" ||
          gitState === "renamed"
        );

        // stage: solo fichero ("file") con estado modified o untracked, y filtro distinto de staged
        const canStage = kind === "file" && !!g && filter !== "staged" && (
          gitState === "modified" || gitState === "untracked"
        );

        // unstage: solo fichero ("file") con state==="staged" o row.git.staged===true
        const canUnstage = kind === "file" && isStagedFlag;

        // discard: solo fichero ("file") con state==="modified", y filtro distinto de staged
        const canDiscard = kind === "file" && !!g && filter !== "staged" && (
          gitState === "modified"
        );

        // conflicto: resolver exige merge real; descartar vale también para el previsto
        const canConflictFile = kind === "file" && isConflict && rel !== "";
        const canResolveFile = canConflictFile && gitState === "conflict";
        const canResolveOurs = canResolveFile;
        const canResolveTheirs = canResolveFile;
        const canDiscardConflict = canConflictFile;
        const canStashConflict = canConflictFile && gitState !== "conflict";
        // apartado: la fila (también la virtual de un fichero que ya no está en disco) lleva stashed
        const canStashed = !!g && g.stashed === true && rel !== "";

        // resolver todo: solo con el botón derecho sobre el fondo del árbol y el filtro CONFLICTO
        const canResolveAll = rel === "" && filter === "conflict";

        // rename: cualquier fila con rel !== "" y kind !== "missing"
        const canRename = rel !== "" && !isMissing;

        // newfile: cualquier carpeta (kind==="dir") o fondo/raíz
        const canNewFile = isDir || rel === "";

        // open y reveal
        const canOpen = isFile;
        const canReveal = rel !== "" && !isMissing;

        // copy / cut
        const canCopy = rel !== "" && !isMissing;
        const canCut = rel !== "" && !isMissing;

        // paste: solo si es carpeta y hay algo en el portapapeles
        const canPaste = isDir && !!state.clipboard;

        // delete: no missing y no raíz
        const canDelete = !isMissing && rel !== "";

        // Habilitar / deshabilitar u ocultar elementos del menú
        const btnOpen = menu.querySelector('[data-action="open"]');
        const btnReveal = menu.querySelector('[data-action="reveal"]');
        const btnCopy = menu.querySelector('[data-action="copy"]');
        const btnCut = menu.querySelector('[data-action="cut"]');
        const btnPaste = menu.querySelector('[data-action="paste"]');

        const btnDiff = menu.querySelector('[data-action="diff"]');
        const btnStage = menu.querySelector('[data-action="stage"]');
        const btnUnstage = menu.querySelector('[data-action="unstage"]');
        const btnDiscard = menu.querySelector('[data-action="discard"]');
        const dividerGit = document.getElementById("ctx-divider-git");
        const btnResolveOurs = menu.querySelector('[data-action="resolveOurs"]');
        const btnResolveTheirs = menu.querySelector('[data-action="resolveTheirs"]');
        const btnDiscardConflict = menu.querySelector('[data-action="discardConflict"]');
        const btnStashConflict = menu.querySelector('[data-action="stashConflict"]');
        const stashedBtns = menu.querySelectorAll('[data-action="stashDiff"],[data-action="stashPop"],[data-action="stashPopForce"],[data-action="stashDrop"]');
        const btnResolveAllOurs = menu.querySelector('[data-action="resolveAllOurs"]');
        const btnResolveAllTheirs = menu.querySelector('[data-action="resolveAllTheirs"]');
        const dividerConflict = document.getElementById("ctx-divider-conflict");

        const btnRename = menu.querySelector('[data-action="rename"]');
        const btnNewFile = menu.querySelector('[data-action="newfile"]');
        const dividerFs = document.getElementById("ctx-divider-fs");

        const btnDelete = menu.querySelector('[data-action="delete"]');

        if (btnOpen) btnOpen.hidden = !canOpen;
        if (btnReveal) btnReveal.hidden = !canReveal;

        if (btnCopy) btnCopy.hidden = !canCopy;
        if (btnCut) btnCut.hidden = !canCut;
        if (btnPaste) {
          btnPaste.hidden = !isDir;
          btnPaste.disabled = !canPaste;
        }

        if (btnDiff) btnDiff.hidden = !canDiff;
        if (btnStage) btnStage.hidden = !canStage;
        if (btnUnstage) btnUnstage.hidden = !canUnstage;
        if (btnDiscard) btnDiscard.hidden = !canDiscard;
        if (btnResolveOurs) btnResolveOurs.hidden = !canResolveOurs;
        if (btnResolveTheirs) btnResolveTheirs.hidden = !canResolveTheirs;
        if (btnDiscardConflict) btnDiscardConflict.hidden = !canDiscardConflict;
        if (btnStashConflict) btnStashConflict.hidden = !canStashConflict;
        stashedBtns.forEach((b) => { b.hidden = !canStashed; });
        if (btnResolveAllOurs) btnResolveAllOurs.hidden = !canResolveAll;
        if (btnResolveAllTheirs) btnResolveAllTheirs.hidden = !canResolveAll;

        const hasGitActions = canDiff || canStage || canUnstage || canDiscard;
        if (dividerGit) dividerGit.hidden = !hasGitActions;

        const hasConflictActions = canResolveOurs || canResolveTheirs || canDiscardConflict || canStashConflict || canStashed || canResolveAll;
        if (dividerConflict) dividerConflict.hidden = !hasConflictActions;

        if (btnRename) btnRename.hidden = !canRename;
        if (btnNewFile) btnNewFile.hidden = !canNewFile;
        if (dividerFs) dividerFs.hidden = !canRename && !canNewFile;

        if (btnDelete) btnDelete.hidden = !canDelete;

        // Mostrar menú y calcular posición clamped con offsetHeight/offsetWidth reales
        menu.hidden = false;
        const w = menu.offsetWidth || 180;
        const h = menu.offsetHeight || 300;
        const x = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX));
        const y = Math.min(window.innerHeight - h - 8, Math.max(8, e.clientY));
        menu.style.left = x + "px";
        menu.style.top = y + "px";
      },
      { capture: true }
    );

    window.addEventListener("click", (e) => {
      if (!menu.contains(e.target)) {
        menu.hidden = true;
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        menu.hidden = true;
      }
    });

    menu.querySelectorAll(".pe-ctx-item").forEach((item) => {
      item.addEventListener("click", () => {
        menu.hidden = true;
        if (!ctxTarget) return;
        const action = item.dataset.action;
        handleContextAction(action, ctxTarget);
      });
    });
  }

  function handleContextAction(action, target) {
    const { treeId, rel, kind } = target;

    switch (action) {
      case "open":
        if (kind !== "missing") vscode.postMessage({ type: "open", treeId, rel });
        break;
      case "reveal":
        vscode.postMessage({ type: "reveal", treeId, rel });
        break;
      case "diff":
        vscode.postMessage({ type: "diff", treeId, rel });
        break;
      case "stage":
        vscode.postMessage({ type: "git", treeId, action: "stage", rel });
        break;
      case "unstage":
        vscode.postMessage({ type: "git", treeId, action: "unstage", rel });
        break;
      case "discard":
        vscode.postMessage({ type: "git", treeId, action: "discard", rel });
        break;
      case "resolveOurs":
      case "resolveTheirs":
      case "discardConflict":
      case "stashConflict":
      case "stashDiff":
      case "stashPop":
      case "stashPopForce":
      case "stashDrop":
        vscode.postMessage({ type: "git", treeId, action, rel });
        break;
      case "resolveAllOurs":
      case "resolveAllTheirs":
        vscode.postMessage({ type: "git", treeId, action });
        break;
      case "rename":
        vscode.postMessage({ type: "rename", treeId, rel });
        break;
      case "newfile":
        vscode.postMessage({ type: "newFile", treeId, parentRel: rel });
        break;
      case "copy":
        state.clipboard = { treeId, rel, mode: "copy" };
        showToast("Copiado al portapapeles: " + (rel || "raíz"), "ok");
        break;
      case "cut":
        state.clipboard = { treeId, rel, mode: "cut" };
        showToast("Cortado: " + (rel || "raíz"), "ok");
        break;
      case "paste":
        if (!state.clipboard) return;
        vscode.postMessage({
          type: "transfer",
          fromTree: state.clipboard.treeId,
          fromRel: state.clipboard.rel,
          toTree: treeId,
          toDir: rel,
          mode: state.clipboard.mode === "cut" ? "move" : "copy"
        });
        if (state.clipboard.mode === "cut") state.clipboard = null;
        break;
      case "delete":
        vscode.postMessage({ type: "delete", treeId, rel });
        break;
    }
  }

  // ── Modal de Nueva Rama ───────────────────────────────────
  function setupBranchModal() {
    const modal = state.domBranchModal;
    const input = state.domBranchInput;

    function submit() {
      const val = input.value.trim();
      if (!val) return;
      modal.hidden = true;
      vscode.postMessage({
        type: "git",
        treeId: state.branchModalTarget,
        action: "createBranch",
        branch: val
      });
    }

    state.domBranchOk.addEventListener("click", submit);
    state.domBranchCancel.addEventListener("click", () => { modal.hidden = true; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        modal.hidden = true;
      }
    });
  }

  // ── Toast de aviso ────────────────────────────────────────
  let toastTimer = null;
  function showToast(msg, kind) {
    if (toastTimer) clearTimeout(toastTimer);
    state.domToastText.textContent = msg;
    state.domToast.className = "pe-toast " + (kind || "ok");
    state.domToast.hidden = false;
    toastTimer = setTimeout(() => {
      state.domToast.hidden = true;
    }, 3200);
  }

  // ── Manejo de Mensajes del Host ───────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    switch (msg.type) {
      case "init":
        onInit(msg.payload);
        break;
      case "view":
        onView(msg.payload);
        break;
      case "scan":
        onScan(msg.payload);
        break;
      case "git":
        onGit(msg.payload);
        break;
      case "status":
        onStatus(msg.payload);
        break;
      case "op":
        onOp(msg.payload);
        break;
    }
  });

  function onInit(payload) {
    if (!payload) return;
    if (payload.layout) applyLayout(payload.layout);
    if (typeof payload.split === "number") applySplit(payload.split);

    if (Array.isArray(payload.trees)) {
      payload.trees.forEach((treeMeta) => {
        if (!treeMeta || !treeMeta.id) return;
        const t = trees[treeMeta.id];
        if (!t) return;
        t.meta = treeMeta;
        applyTreeMeta(treeMeta.id);
      });
    }
  }

  function applyTreeMeta(id) {
    const t = trees[id];
    const m = t.meta;
    const d = t.dom;
    if (!m || !d.rootPath) return;

    d.rootPath.textContent = m.root || m.label || "—";
    d.rootPath.title = m.root || m.label || "";

    d.btnHidden.classList.toggle("active", !!m.showHidden);
    if (d.btnSorts) {
      d.btnSorts.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.sort === m.sort);
      });
    }
    if (d.btnSortDir) {
      const isAsc = m.sortDir === "asc";
      d.btnSortDir.innerHTML = isAsc ? SVG_ARROW_UP : SVG_ARROW_DOWN;
      d.btnSortDir.title = isAsc ? "Orden ascendente" : "Orden descendente";
      d.btnSortDir.setAttribute("aria-label", isAsc ? "Orden ascendente" : "Orden descendente");
    }

    if (typeof m.query === "string" && d.searchInput.value !== m.query) {
      d.searchInput.value = m.query;
      d.searchClear.style.display = m.query ? "block" : "none";
    }

    if (m.filter) {
      t.filter = m.filter;
      d.filterChips.forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.filter === m.filter);
      });
    }

    if (m.scan && typeof m.scan.files === "number") {
      t.scan.files = m.scan.files;
      t.scan.dirs = typeof m.scan.dirs === "number" ? m.scan.dirs : 0;
      t.scan.bytes = typeof m.scan.bytes === "number" ? m.scan.bytes : 0;
      updateFooterStats(id);
    }

    if (m.git) {
      applyGitInfo(id, m.git);
    } else {
      applyGitInfo(id, null);
    }
  }

  function onView(payload) {
    if (!payload || !payload.treeId) return;
    const t = trees[payload.treeId];
    if (!t) return;

    const queryChanged = t.query !== (payload.query || "");
    const modeChanged = t.mode !== (payload.mode || "tree");

    t.rows = payload.rows || [];
    t.mode = payload.mode || "tree";
    t.query = payload.query || "";
    t.filter = payload.filter || t.filter || "all";
    t.truncated = !!payload.truncated;

    t.dom.tagTruncated.hidden = !t.truncated;

    // Actualizar chip activo si vino en view
    t.dom.filterChips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.filter === t.filter);
    });

    if (queryChanged || modeChanged) {
      t.dom.treeScroll.scrollTop = 0;
      t.selectedIndex = -1;
    }

    renderVirtualRows(payload.treeId);
    updateFooterStats(payload.treeId);
  }

  function onScan(payload) {
    if (!payload || !payload.treeId) return;
    const t = trees[payload.treeId];
    if (!t) return;

    const d = t.dom;
    const state = payload.state; // "start" | "progress" | "done" | "error"

    if (state === "start" || state === "progress") {
      d.scanProgress.hidden = false;
    } else {
      d.scanProgress.hidden = true;
    }

    if (state === "error") {
      setStatusLine(payload.treeId, payload.error || "Error al escanear", "error", false);
    } else if (state === "done") {
      setStatusLine(payload.treeId, "", "ok", false);
    }

    updateFooterStats(payload.treeId, payload.files, payload.dirs, payload.bytes);
  }

  function onGit(payload) {
    if (!payload || !payload.treeId) return;
    applyGitInfo(payload.treeId, payload.info);
  }

  function applyGitInfo(id, info) {
    const t = trees[id];
    const d = t.dom;
    if (!d.gitBar) return;

    if (!info) {
      d.tagNogit.hidden = false;
      d.gitBar.classList.add("disabled");
      d.gitBranch.textContent = "sin git";
      d.gitSync.textContent = "";
      d.selectBranch.innerHTML = '<option value="">(sin ramas)</option>';
      if (d.countChanged) d.countChanged.textContent = "0";
      if (d.countStaged) d.countStaged.textContent = "0";
      if (d.countUnpushed) d.countUnpushed.textContent = "0";
      if (d.countConflict) d.countConflict.textContent = "0";
      if (d.countStashed) d.countStashed.textContent = "0";
      return;
    }

    d.tagNogit.hidden = true;
    d.gitBar.classList.remove("disabled");

    d.gitBranch.textContent = info.branch || "HEAD";
    d.gitBranch.title = "Rama: " + (info.branch || "HEAD");

    let syncText = "";
    if (info.ahead > 0) syncText += "↑" + info.ahead + " ";
    if (info.behind > 0) syncText += "↓" + info.behind;
    d.gitSync.textContent = syncText.trim();

    // Actualizar lista de ramas
    if (Array.isArray(info.branches)) {
      d.selectBranch.innerHTML = "";
      info.branches.forEach((b) => {
        const opt = document.createElement("option");
        opt.value = b;
        opt.textContent = b;
        if (b === info.branch) opt.selected = true;
        d.selectBranch.appendChild(opt);
      });
    }

    // Actualizar contadores de chips
    if (info.counts) {
      const c = info.counts;
      if (d.countChanged) d.countChanged.textContent = String(c.changed || 0);
      if (d.countStaged) d.countStaged.textContent = String(c.staged || 0);
      if (d.countUnpushed) d.countUnpushed.textContent = String(c.unpushed || 0);
      if (d.countConflict) d.countConflict.textContent = String(c.conflict || 0);
      if (d.countStashed) d.countStashed.textContent = String(c.stashed || 0);
    }
  }

  function onStatus(payload) {
    if (!payload || !payload.treeId) return;
    const t = trees[payload.treeId];
    if (!t) return;
    t.busy = !!payload.busy;

    // Deshabilitar botones Git si busy
    const d = t.dom;
    const disabled = t.busy;
    d.btnFetch.disabled = disabled;
    d.btnPull.disabled = disabled;
    d.btnPush.disabled = disabled;
    d.btnGitRefresh.disabled = disabled;
    d.btnStageAll.disabled = disabled;
    d.btnCommit.disabled = disabled;
    d.selectBranch.disabled = disabled;
    d.btnNewBranch.disabled = disabled;

    setStatusLine(payload.treeId, payload.text || "", payload.kind || "info", t.busy);
  }

  function setStatusLine(treeId, text, kind, busy) {
    const d = trees[treeId].dom;
    if (!d.statusLine) return;

    if (!text && !busy) {
      d.statusLine.hidden = true;
      return;
    }

    d.statusLine.hidden = false;
    d.statusLine.className = "pe-status-line " + (kind || "info");
    d.statusSpinner.hidden = !busy;
    d.statusText.textContent = text;
  }

  function onOp(payload) {
    if (!payload) return;
    showToast(payload.message || (payload.ok ? "Operación completada" : "Error en operación"), payload.ok ? "ok" : "error");
  }

  function updateFooterStats(id, fCount, dCount, bCount) {
    const t = trees[id];
    const d = t.dom;
    if (!d.footerStats) return;

    if (typeof fCount === "number") t.scan.files = fCount;
    if (typeof dCount === "number") t.scan.dirs = dCount;
    if (typeof bCount === "number") t.scan.bytes = bCount;

    const files = t.scan.files || 0;
    const folders = t.scan.dirs || 0;
    const bytes = t.scan.bytes || 0;

    d.footerStats.textContent = files + " archivos · " + folders + " carpetas · " + formatBytes(bytes);
  }

  // ── Modo Demo Autónomo ────────────────────────────────────
  function initDemoData() {
    onInit({
      layout: "one",
      split: 0.5,
      trees: [
        {
          id: "a",
          root: "E:/PROYECTOS/OpenCode_Alfred",
          label: "OpenCode_Alfred",
          showHidden: false,
          sort: "size",
          sortDir: "desc",
          filter: "all",
          query: "",
          expanded: ["Codigo_Fuente", "Codigo_Fuente/src"],
          scan: { state: "done", files: 120, dirs: 25, bytes: 4850000, truncated: false },
          git: {
            branch: "main",
            upstream: "origin/main",
            ahead: 1,
            behind: 0,
            branches: ["main", "feature/explorer", "develop"],
            counts: { changed: 3, staged: 1, unpushed: 1, conflict: 0 }
          }
        },
        {
          id: "b",
          root: "E:/PROYECTOS/OpenCode_Alfred/Documentacion",
          label: "Documentacion",
          showHidden: false,
          sort: "name",
          sortDir: "asc",
          filter: "all",
          query: "",
          expanded: [],
          scan: { state: "done", files: 8, dirs: 2, bytes: 85000, truncated: false },
          git: null
        }
      ]
    });

    const demoRowsA = [
      { rel: "README.md", name: "README.md", kind: "file", depth: 0, hasChildren: false, expanded: false, size: 4200, pct: 12, mtime: Date.now(), ext: "md", git: { state: "clean" }, folderGit: false, error: false },
      { rel: "Codigo_Fuente", name: "Codigo_Fuente", kind: "dir", depth: 0, hasChildren: true, expanded: true, size: 3800000, pct: 85, mtime: Date.now(), ext: "", git: null, folderGit: true, error: false },
      { rel: "Codigo_Fuente/package.json", name: "package.json", kind: "file", depth: 1, hasChildren: false, expanded: false, size: 3200, pct: 8, mtime: Date.now(), ext: "json", git: { state: "modified", added: 4, removed: 1 }, folderGit: false, error: false },
      { rel: "Codigo_Fuente/src", name: "src", kind: "dir", depth: 1, hasChildren: true, expanded: true, size: 2400000, pct: 60, mtime: Date.now(), ext: "", git: null, folderGit: true, error: false },
      { rel: "Codigo_Fuente/src/extension.ts", name: "extension.ts", kind: "file", depth: 2, hasChildren: false, expanded: false, size: 38400, pct: 25, mtime: Date.now(), ext: "ts", git: { state: "staged", staged: true }, folderGit: false, error: false },
      { rel: "Codigo_Fuente/src/types.ts", name: "types.ts", kind: "file", depth: 2, hasChildren: false, expanded: false, size: 12500, pct: 15, mtime: Date.now(), ext: "ts", git: { state: "clean" }, folderGit: false, error: false },
      { rel: "Codigo_Fuente/media", name: "media", kind: "dir", depth: 1, hasChildren: true, expanded: false, size: 1200000, pct: 30, mtime: Date.now(), ext: "", git: null, folderGit: true, error: false },
      { rel: "Documentacion", name: "Documentacion", kind: "dir", depth: 0, hasChildren: true, expanded: false, size: 85000, pct: 5, mtime: Date.now(), ext: "", git: null, folderGit: false, error: false },
      { rel: "AGENTS.md", name: "AGENTS.md", kind: "file", depth: 0, hasChildren: false, expanded: false, size: 18400, pct: 18, mtime: Date.now(), ext: "md", git: { state: "untracked" }, folderGit: false, error: false },
      { rel: "archivo-fantasma.txt", name: "archivo-fantasma.txt", kind: "missing", depth: 0, hasChildren: false, expanded: false, size: 0, pct: 0, mtime: Date.now(), ext: "txt", git: { state: "deleted" }, folderGit: false, error: true }
    ];

    const demoRowsB = [
      { rel: "README.md", name: "README.md", kind: "file", depth: 0, hasChildren: false, expanded: false, size: 12500, pct: 30, mtime: Date.now(), ext: "md", git: null, folderGit: false, error: false },
      { rel: "ESTADO.md", name: "ESTADO.md", kind: "file", depth: 0, hasChildren: false, expanded: false, size: 24000, pct: 55, mtime: Date.now(), ext: "md", git: null, folderGit: false, error: false },
      { rel: "DESARROLLO.md", name: "DESARROLLO.md", kind: "file", depth: 0, hasChildren: false, expanded: false, size: 15200, pct: 35, mtime: Date.now(), ext: "md", git: null, folderGit: false, error: false }
    ];

    onView({ treeId: "a", mode: "tree", rows: demoRowsA, truncated: false, query: "", filter: "all" });
    onView({ treeId: "b", mode: "tree", rows: demoRowsB, truncated: false, query: "", filter: "all" });
  }

})();
