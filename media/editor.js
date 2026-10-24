// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let init = null;
  /** @type {any} */
  let baseFrontmatter = {};
  /** @type {any[]} */
  let permRows = [];

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
  const select = (id) => /** @type {HTMLSelectElement} */ (document.getElementById(id));
  const textarea = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));

  const FLAT = new Set();
  const ALL_TOOLS = [];

  function post(message) {
    vscode.postMessage(message);
  }

  function setBanner(text, isError) {
    const el = $("banner");
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle("error", !!isError);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  function setOrDelete(obj, key, value) {
    if (value === undefined || value === null || value === "" || (typeof value === "number" && Number.isNaN(value))) {
      delete obj[key];
    } else {
      obj[key] = value;
    }
  }

  function option(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  // ---- color del frontmatter ------------------------------------------
  // El picker SIEMPRE produce hex #rrggbb; colorValue conserva el valor original del
  // frontmatter (p. ej. "blue") mientras el usuario no toque el selector.

  const DEFAULT_PICKER_COLOR = "#888888";

  /** Valor de color tal cual está en el frontmatter. */
  let colorValue = "";

  /** #rgb / #rrggbb -> #rrggbb en minúsculas, o undefined si no es un hex válido. */
  function hexColor(value) {
    const v = (value || "").trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(v)) {
      return v;
    }
    return /^#[0-9a-f]{3}$/.test(v)
      ? "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]
      : undefined;
  }

  /** Avisa cuando el frontmatter trae un nombre de color: el picker no sabe mostrarlo. */
  function refreshColorHint() {
    $("color-hint").textContent =
      !hexColor(colorValue) && colorValue
        ? `Valor actual: ${colorValue} — el selector guarda hex; se sustituirá al usar el selector.`
        : "";
  }

  /** Pinta el picker con colorValue (o un valor neutro si no hay color). */
  function refreshColorUi() {
    const hex = hexColor(colorValue);
    input("f-color").value = hex || DEFAULT_PICKER_COLOR;
    refreshColorHint();
  }

  // ---- permission rows -------------------------------------------------

  function renderPermRows() {
    const container = $("perm-rows");
    container.innerHTML = "";
    permRows.forEach((row, index) => {
      container.appendChild(buildPermRow(row, index));
    });
    updatePermPreview();
  }

  function buildPermRow(row, index) {
    const wrap = document.createElement("div");
    wrap.className = "perm-row";

    const toolInput = document.createElement("input");
    toolInput.type = "text";
    toolInput.value = row.tool || "";
    toolInput.placeholder = "herramienta (bash, edit, read...)";
    toolInput.setAttribute("list", "tool-list");
    toolInput.addEventListener("input", () => {
      row.tool = toolInput.value;
      patternInput.classList.toggle("flat-disabled", FLAT.has(row.tool.trim()));
      patternInput.disabled = FLAT.has(row.tool.trim());
      if (FLAT.has(row.tool.trim())) {
        row.pattern = "";
        patternInput.value = "";
      }
      updatePermPreview();
    });

    const patternInput = document.createElement("input");
    patternInput.type = "text";
    patternInput.value = row.pattern || "";
    patternInput.placeholder = "patrón (opcional; vacío = regla plana)";
    patternInput.addEventListener("input", () => {
      row.pattern = patternInput.value;
      updatePermPreview();
    });

    const actionSelect = document.createElement("select");
    ["allow", "ask", "deny"].forEach((a) => actionSelect.appendChild(option(a, a)));
    actionSelect.value = row.action || "allow";
    actionSelect.addEventListener("change", () => {
      row.action = actionSelect.value;
      updatePermPreview();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary small";
    remove.textContent = "✕";
    remove.title = "Quitar";
    remove.addEventListener("click", () => {
      permRows.splice(index, 1);
      renderPermRows();
    });

    if (FLAT.has((row.tool || "").trim())) {
      patternInput.disabled = true;
      patternInput.classList.add("flat-disabled");
    }

    wrap.append(toolInput, patternInput, actionSelect, remove);
    return wrap;
  }

  function buildPermission() {
    const flat = {};
    const patterned = {};
    for (const row of permRows) {
      const tool = (row.tool || "").trim();
      if (!tool) {
        continue;
      }
      const action = row.action || "allow";
      const pattern = (row.pattern || "").trim();
      if (pattern && !FLAT.has(tool)) {
        patterned[tool] = patterned[tool] || {};
        patterned[tool][pattern] = action;
      } else {
        flat[tool] = action;
      }
    }
    const perm = { ...flat };
    for (const [tool, map] of Object.entries(patterned)) {
      perm[tool] = map;
    }
    return perm;
  }

  function updatePermPreview() {
    const perm = buildPermission();
    $("perm-preview").textContent = Object.keys(permissionSafe(perm)).length
      ? JSON.stringify(perm, null, 2)
      : "(sin permisos)";
  }

  function permissionSafe(perm) {
    return perm || {};
  }

  function rowsFromPermission(permission) {
    const rows = [];
    if (!permission || typeof permission !== "object") {
      return rows;
    }
    for (const [tool, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        rows.push({ tool, pattern: "", action: value });
      } else if (value && typeof value === "object") {
        for (const [pattern, action] of Object.entries(value)) {
          rows.push({ tool, pattern, action });
        }
      }
    }
    return rows;
  }

  // ---- selector de modelos: combo buscable con scroll -----------------
  // El <datalist> nativo del webview no scrollea ni filtra y a veces inserta
  // la etiqueta en vez del valor, así que el desplegable es nuestro.

  const MAX_SUGGESTIONS = 200;

  /** @type {{id: string; name: string}[]} */
  let modelRows = [];
  /** @type {{id: string; name: string}[]} */
  let modelFiltered = [];
  let modelActive = -1;
  let modelOpen = false;

  function modelHint(text) {
    $("model-hint").textContent = text;
  }

  function renderModelPopup() {
    const popup = $("model-popup");
    popup.innerHTML = "";
    modelFiltered.forEach((m, i) => {
      const item = document.createElement("div");
      item.className = "combo-item" + (i === modelActive ? " active" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", i === modelActive ? "true" : "false");
      const name = document.createElement("span");
      name.className = "combo-name";
      name.textContent = m.name || m.id;
      const id = document.createElement("span");
      id.className = "combo-id";
      id.textContent = m.id;
      item.append(name, id);
      // evita que el mousedown robe el foco antes del click
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => pickModel(m.id));
      popup.appendChild(item);
    });
  }

  function filterModels(showAll) {
    const q = showAll ? "" : input("f-model").value.trim().toLowerCase();
    const matches = q
      ? modelRows.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      : modelRows;
    modelFiltered = matches.slice(0, MAX_SUGGESTIONS);
    modelActive = modelFiltered.length ? 0 : -1;
    modelHint(
      modelFiltered.length
        ? `Mostrando ${modelFiltered.length} de ${matches.length} · escribe para filtrar`
        : `Ningún modelo coincide (${modelRows.length} disponibles). Puedes escribir el id a mano.`
    );
    renderModelPopup();
  }

  function openModelPopup() {
    if (modelOpen) {
      return;
    }
    modelOpen = true;
    $("model-popup").hidden = false;
    input("f-model").setAttribute("aria-expanded", "true");
  }

  function closeModelPopup() {
    modelOpen = false;
    modelActive = -1;
    $("model-popup").hidden = true;
    input("f-model").setAttribute("aria-expanded", "false");
  }

  /** Escribe el id exacto, nunca el nombre, para no romper "provider/model-id". */
  function pickModel(id) {
    input("f-model").value = id;
    closeModelPopup();
    post({ type: "dirty", value: true });
    runValidate();
  }

  function moveActive(delta) {
    if (!modelFiltered.length) {
      return;
    }
    modelActive = (modelActive + delta + modelFiltered.length) % modelFiltered.length;
    renderModelPopup();
    const el = $("model-popup").children[modelActive];
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function wireModelCombo() {
    const el = input("f-model");
    el.addEventListener("focus", () => {
      openModelPopup();
      // con el campo ya relleno se muestra el catálogo completo, no una fila
      filterModels(true);
    });
    el.addEventListener("input", () => {
      openModelPopup();
      filterModels();
    });
    el.addEventListener("blur", closeModelPopup);
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openModelPopup();
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === "Enter") {
        if (modelOpen && modelActive >= 0) {
          e.preventDefault();
          pickModel(modelFiltered[modelActive].id);
        }
      } else if (e.key === "Escape") {
        closeModelPopup();
      }
    });
  }

  // ---- collect / populate ---------------------------------------------

  function collectFrontmatter() {
    const fm = clone(baseFrontmatter);

    setOrDelete(fm, "description", textarea("f-description").value.trim());
    setOrDelete(fm, "mode", select("f-mode").value || undefined);
    setOrDelete(fm, "model", input("f-model").value.trim() || undefined);
    setOrDelete(fm, "variant", input("f-variant").value.trim() || undefined);
    setOrDelete(fm, "color", colorValue || undefined);

    const temp = input("f-temperature").value.trim();
    setOrDelete(fm, "temperature", temp === "" ? undefined : Number(temp));
    const topP = input("f-top_p").value.trim();
    setOrDelete(fm, "top_p", topP === "" ? undefined : Number(topP));
    const steps = input("f-steps").value.trim();
    setOrDelete(fm, "steps", steps === "" ? undefined : parseInt(steps, 10));

    if (input("f-hidden").checked) {
      fm.hidden = true;
    } else {
      delete fm.hidden;
    }
    if (input("f-disable").checked) {
      fm.disable = true;
    } else {
      delete fm.disable;
    }

    const perm = buildPermission();
    if (Object.keys(perm).length > 0) {
      fm.permission = perm;
    } else {
      delete fm.permission;
    }
    return fm;
  }

  function runValidate() {
    post({
      type: "validate",
      payload: {
        name: input("f-name").value.trim(),
        frontmatter: collectFrontmatter(),
      },
    });
  }

  function renderIssues(issues) {
    const ul = $("issues");
    ul.innerHTML = "";
    if (!issues || issues.length === 0) {
      const li = document.createElement("li");
      li.className = "ok";
      li.textContent = "Sin problemas.";
      ul.appendChild(li);
      return;
    }
    for (const issue of issues) {
      const li = document.createElement("li");
      li.className = issue.level;
      li.textContent = (issue.field ? `[${issue.field}] ` : "") + issue.message;
      ul.appendChild(li);
    }
  }

  function applyInit() {
    const d = init;

    $("title").textContent =
      d.mode === "create" ? `Nuevo ${d.name ? "agente" : "agente"}: ${d.name}` : `Editar: ${d.name}`;
    $("subtitle").textContent = [
      d.mode === "create" ? "Creando" : "Editando",
      `origen: ${d.source}`,
      d.filePath ? d.filePath : "se creará el .md al guardar",
    ].join("  ·  ");

    input("f-name").value = d.name;
    input("f-name").disabled = d.mode === "edit" && !d.canRename;

    const scopeSel = select("f-scope");
    scopeSel.value = d.targetScope;
    scopeSel.disabled = d.mode === "edit";
    if (!d.hasProject) {
      const projOpt = scopeSel.querySelector('option[value="project"]');
      if (projOpt) {
        projOpt.disabled = true;
        projOpt.textContent += " (sin proyecto abierto)";
      }
      if (scopeSel.value === "project") {
        scopeSel.value = "global";
      }
    }

    const fm = d.frontmatter || {};
    baseFrontmatter = clone(fm);

    textarea("f-description").value = fm.description || "";
    select("f-mode").value = fm.mode || "";
    input("f-model").value = fm.model || "";
    input("f-variant").value = fm.variant || "";
    input("f-temperature").value = fm.temperature ?? "";
    input("f-top_p").value = fm.top_p ?? "";
    input("f-steps").value = fm.steps ?? "";
    colorValue = typeof fm.color === "string" ? fm.color.trim() : "";
    refreshColorUi();
    input("f-hidden").checked = !!fm.hidden;
    input("f-disable").checked = !!fm.disable;
    textarea("f-prompt").value = d.prompt || "";

    permRows = rowsFromPermission(fm.permission);
    renderPermRows();

    modelRows = (d.models || []).map((m) => ({ id: m.id, name: m.name || m.id }));
    modelHint(
      modelRows.length
        ? `${modelRows.length} modelos disponibles · escribe para filtrar`
        : "Sin catálogo de modelos detectado: escribe provider/model-id a mano."
    );

    const toolList = document.createElement("datalist");
    toolList.id = "tool-list";
    (d.allTools || []).forEach((t) => toolList.appendChild(option(t, t)));
    document.body.appendChild(toolList);

    wireModelCombo();

    $("btn-open-raw").hidden = !d.filePath;
    runValidate();
  }

  // ---- events ----------------------------------------------------------

  function wireEvents() {
    // El picker se sincroniza ANTES del cableado genérico: cuando ese dispare runValidate,
    // colorValue ya tiene el valor nuevo.
    const picker = input("f-color");
    ["input", "change"].forEach((ev) =>
      picker.addEventListener(ev, () => {
        colorValue = picker.value;
        refreshColorHint();
      })
    );

    $("btn-clear-color").addEventListener("click", () => {
      colorValue = "";
      refreshColorUi();
      post({ type: "dirty", value: true });
      runValidate();
    });

    ["f-name", "f-description", "f-mode", "f-model", "f-variant", "f-temperature", "f-top_p", "f-steps", "f-color", "f-hidden", "f-disable", "f-prompt"].forEach(
      (id) => {
        const el = document.getElementById(id);
        el?.addEventListener("input", () => {
          post({ type: "dirty", value: true });
          runValidate();
        });
        el?.addEventListener("change", () => post({ type: "dirty", value: true }));
      }
    );

    $("btn-add-perm").addEventListener("click", () => {
      permRows.push({ tool: "", pattern: "", action: "allow" });
      renderPermRows();
      post({ type: "dirty", value: true });
    });

    $("btn-save").addEventListener("click", () => {
      post({
        type: "save",
        payload: {
          name: input("f-name").value.trim(),
          targetScope: select("f-scope").value,
          frontmatter: collectFrontmatter(),
          prompt: textarea("f-prompt").value,
        },
      });
    });

    $("btn-cancel").addEventListener("click", () => post({ type: "cancel" }));
    $("btn-open-raw").addEventListener("click", () => post({ type: "openRaw" }));

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        $("btn-save").click();
      }
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "init":
        init = message.payload;
        (init.flatTools || []).forEach((t) => FLAT.add(t));
        (init.allTools || []).forEach((t) => ALL_TOOLS.push(t));
        applyInit();
        break;
      case "validation":
        renderIssues(message.issues);
        break;
      case "saved":
        setBanner(message.message, !message.ok);
        if (message.ok) {
          runValidate();
        }
        break;
    }
  });

  wireEvents();
  post({ type: "ready" });
})();
