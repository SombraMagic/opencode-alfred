// @ts-check
/* Editor de agentes de opencode — formulario del frontmatter y del prompt.
   Las claves no gestionadas del frontmatter se conservan siempre (clone de
   baseFrontmatter); las desconocidas se editan como "opciones del proveedor". */
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  let init = null;
  /** @type {any} */
  let baseFrontmatter = {};
  /** Tools conocidas: tool -> { action, patterns: [{pattern, action}], expanded }. */
  let toolState = new Map();
  /** Filas libres de "Otras reglas" (claves fuera de allTools). */
  let permExtraRows = [];
  /** Filas de opciones del proveedor (claves del frontmatter fuera de KNOWN_KEYS). */
  let optionRows = [];
  /** Copia local de la cabecera: se refresca al guardar. */
  let mode = "create";
  let agentName = "";
  let source = "file";
  let filePath = "";

  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));
  const select = (id) => /** @type {HTMLSelectElement} */ (document.getElementById(id));
  const textarea = (id) => /** @type {HTMLTextAreaElement} */ (document.getElementById(id));

  const FLAT = new Set();
  const PATTERN = new Set();
  const ALL_TOOLS = [];
  const ALL_SET = new Set();

  /** Claves con UI propia; el resto se edita en "Opciones del proveedor" (options viaja intacto). */
  const KNOWN_KEYS = new Set([
    "name",
    "model",
    "variant",
    "description",
    "mode",
    "hidden",
    "color",
    "steps",
    "options",
    "permission",
    "disable",
    "temperature",
    "top_p",
  ]);

  function post(message) {
    vscode.postMessage(message);
  }

  /** Cualquier cambio del usuario: marca sucio y revalida con el frontmatter completo. */
  function changed() {
    post({ type: "dirty", value: true });
    runValidate();
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
    el.classList.toggle("ok", !isError);
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

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function option(value, label) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  /** Asigna el valor a un select; si no tiene esa opción, la añade para no perderla. */
  function selectValue(sel, value) {
    const text = String(value === undefined || value === null ? "" : value);
    const known = Array.prototype.some.call(sel.options, (o) => o.value === text);
    if (text && !known) sel.appendChild(option(text, text + " (desconocido)"));
    sel.value = text;
  }

  // ---- cabecera ----------------------------------------------------------

  function renderHead() {
    $("title").textContent =
      mode === "create"
        ? agentName
          ? "Nuevo agente: " + agentName
          : "Nuevo agente"
        : "Editar: " + agentName;
    $("subtitle").textContent = [
      mode === "create" ? "Creando" : "Editando",
      "origen: " + source,
      filePath || "se creará el .md al guardar",
    ].join("  ·  ");
  }

  // ---- color del frontmatter ---------------------------------------------
  // El picker SIEMPRE produce hex #rrggbb; colorValue conserva el valor original del
  // frontmatter (p. ej. "primary" o "blue") mientras el usuario no toque picker ni chip.

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

  /** Chips de los colores de tema; el activo es el que coincide con colorValue. */
  function renderColors() {
    const wrap = $("colors");
    wrap.innerHTML = "";
    ((init && init.themeColors) || []).forEach((name) => {
      const chip = node("button", "color c-" + name);
      chip.setAttribute("type", "button");
      chip.setAttribute("aria-pressed", String(colorValue === name));
      chip.appendChild(node("span", "dot"));
      chip.appendChild(node("span", "color-name", name));
      chip.addEventListener("click", () => {
        colorValue = name;
        refreshColorUi();
        renderColors();
        changed();
      });
      wrap.appendChild(chip);
    });
  }

  // ---- permisos: tools conocidas ------------------------------------------

  function supportsPatterns(tool) {
    return PATTERN.has(tool);
  }

  /** Reparte el permission del frontmatter entre tools conocidas y otras reglas. */
  function loadPermission(permission) {
    toolState = new Map();
    permExtraRows = [];
    if (!permission || typeof permission !== "object") {
      return;
    }
    for (const [tool, value] of Object.entries(permission)) {
      if (ALL_SET.has(tool)) {
        const st = { action: "", patterns: [], expanded: false };
        if (typeof value === "string") {
          st.action = value;
        } else if (value && typeof value === "object") {
          const entries = Object.entries(value);
          if (FLAT.has(tool)) {
            // Las tools planas no admiten patrones: gana la última acción, como antes.
            st.action = entries.length ? String(entries[entries.length - 1][1]) : "";
          } else {
            st.patterns = entries.map(([pattern, action]) => ({
              pattern,
              action: String(action),
            }));
            st.expanded = st.patterns.length > 0;
          }
        }
        toolState.set(tool, st);
      } else if (typeof value === "string") {
        permExtraRows.push({ tool, pattern: "", action: value });
      } else if (value && typeof value === "object") {
        for (const [pattern, action] of Object.entries(value)) {
          permExtraRows.push({ tool, pattern, action: String(action) });
        }
      }
    }
  }

  function renderTools() {
    const wrap = $("perm-tools");
    wrap.innerHTML = "";
    for (const tool of ALL_TOOLS) {
      let st = toolState.get(tool);
      if (!st) {
        st = { action: "", patterns: [], expanded: false };
        toolState.set(tool, st);
      }
      const row = buildToolRow(tool, st);
      wrap.appendChild(row);
      if (st.expanded && supportsPatterns(tool)) {
        wrap.appendChild(buildPatternBox(tool, st, row.querySelector("select")));
      }
    }
  }

  /** La fila placeholder vacía que inserta "+ regla" no cuenta: no emite patrón. */
  function hasRealPattern(st) {
    return st.patterns.some((r) => (r.pattern || "").trim() !== "");
  }

  /** El select plano deja de emitirse (y se deshabilita) solo con patrones reales. */
  function syncFlatSelect(sel, st) {
    const patterned = hasRealPattern(st);
    sel.disabled = patterned;
    sel.title = patterned
      ? "Con reglas de patrón, la acción plana no se emite: usa una regla * como comodín."
      : "";
  }

  function buildToolRow(tool, st) {
    const row = node("div", "perm-tool");
    row.appendChild(node("span", "perm-name", tool));

    const sel = document.createElement("select");
    sel.appendChild(option("", "heredado (omitir)"));
    ["allow", "ask", "deny"].forEach((a) => sel.appendChild(option(a, a)));
    selectValue(sel, st.action);
    syncFlatSelect(sel, st);
    sel.setAttribute("aria-label", "Acción de " + tool);
    sel.addEventListener("change", () => {
      st.action = sel.value;
      changed();
    });
    row.appendChild(sel);

    if (supportsPatterns(tool)) {
      const btn = node("button", "secondary small", st.expanded ? "− patrón" : "+ patrón");
      btn.setAttribute("type", "button");
      btn.setAttribute("aria-expanded", String(st.expanded));
      btn.title = "Mostrar u ocultar las reglas con patrón de " + tool;
      btn.addEventListener("click", () => {
        st.expanded = !st.expanded;
        renderTools();
      });
      row.appendChild(btn);
    }
    return row;
  }

  /** Reglas con patrón de una tool, ordenadas: gana la última que coincide. */
  function buildPatternBox(tool, st, flatSel) {
    const box = node("div", "perm-patterns");
    st.patterns.forEach((rule, index) => {
      const row = node("div", "perm-rule");

      const pat = document.createElement("input");
      pat.type = "text";
      pat.value = rule.pattern;
      pat.placeholder = "patrón (p. ej. git * o *)";
      pat.spellcheck = false;
      pat.setAttribute("aria-label", `Patrón de ${tool} (regla ${index + 1})`);
      pat.addEventListener("input", () => {
        rule.pattern = pat.value;
        syncFlatSelect(flatSel, st);
        changed();
      });

      const sel = document.createElement("select");
      ["allow", "ask", "deny"].forEach((a) => sel.appendChild(option(a, a)));
      selectValue(sel, rule.action || "allow");
      sel.setAttribute("aria-label", `Acción de ${tool} para "${rule.pattern}"`);
      sel.addEventListener("change", () => {
        rule.action = sel.value;
        changed();
      });

      const rm = node("button", "secondary small", "✕");
      rm.setAttribute("type", "button");
      rm.title = "Quitar regla";
      rm.addEventListener("click", () => {
        st.patterns.splice(index, 1);
        renderTools();
        changed();
      });

      row.append(pat, sel, rm);
      box.appendChild(row);
    });

    const add = node("button", "secondary small", "+ regla");
    add.setAttribute("type", "button");
    add.addEventListener("click", () => {
      // La acción plana no se pierde: se siembra como comodín * (amplio primero).
      if (st.action && !hasRealPattern(st)) {
        st.patterns.push({ pattern: "*", action: st.action });
      }
      st.patterns.push({ pattern: "", action: "allow" });
      renderTools();
      changed();
    });
    box.appendChild(add);
    return box;
  }

  // ---- permisos: otras reglas (MCP, tools propias) -------------------------

  function renderExtraRows() {
    const wrap = $("perm-extra");
    wrap.innerHTML = "";
    permExtraRows.forEach((row, index) => {
      wrap.appendChild(buildExtraRow(row, index));
    });
  }

  function buildExtraRow(row, index) {
    const wrap = node("div", "perm-row");

    const toolInput = document.createElement("input");
    toolInput.type = "text";
    toolInput.value = row.tool || "";
    toolInput.placeholder = "herramienta (mymcp_*, mi_tool…)";
    toolInput.spellcheck = false;
    toolInput.setAttribute("list", "tool-list");
    toolInput.addEventListener("input", () => {
      row.tool = toolInput.value;
      const flat = FLAT.has(row.tool.trim());
      patternInput.disabled = flat;
      patternInput.classList.toggle("flat-disabled", flat);
      if (flat) {
        row.pattern = "";
        patternInput.value = "";
      }
      changed();
    });

    const patternInput = document.createElement("input");
    patternInput.type = "text";
    patternInput.value = row.pattern || "";
    patternInput.placeholder = "patrón (opcional; vacío = regla plana)";
    patternInput.spellcheck = false;
    patternInput.addEventListener("input", () => {
      row.pattern = patternInput.value;
      changed();
    });

    const actionSelect = document.createElement("select");
    ["allow", "ask", "deny"].forEach((a) => actionSelect.appendChild(option(a, a)));
    selectValue(actionSelect, row.action || "allow");
    actionSelect.addEventListener("change", () => {
      row.action = actionSelect.value;
      changed();
    });

    const remove = node("button", "secondary small", "✕");
    remove.setAttribute("type", "button");
    remove.title = "Quitar";
    remove.addEventListener("click", () => {
      permExtraRows.splice(index, 1);
      renderExtraRows();
      changed();
    });

    if (FLAT.has((row.tool || "").trim())) {
      patternInput.disabled = true;
      patternInput.classList.add("flat-disabled");
    }

    wrap.append(toolInput, patternInput, actionSelect, remove);
    return wrap;
  }

  /**
   * permission emitido: acción plana cuando no hay patrón; mapa patrón->acción cuando sí.
   * El orden ORIGINAL de las claves se conserva: se casan como comodines y gana la
   * ÚLTIMA que coincide, así que reordenar el fichero invertiría su semántica.
   * Las claves nuevas van al final; una fila libre con clave de tool conocida se
   * ignora (esa tool se edita en su fila propia).
   */
  function buildPermission() {
    const perm = {};
    const base = baseFrontmatter.permission;
    const baseKeys = base && typeof base === "object" ? Object.keys(base) : [];
    const emitted = new Set();

    // Claves del fichero original, en su orden.
    for (const key of baseKeys) {
      const value = ALL_SET.has(key) ? knownToolValue(key) : extraRowsValue(key);
      if (value !== undefined) {
        perm[key] = value;
      }
      emitted.add(key);
    }

    // Tools conocidas recién tocadas, en el orden de allTools.
    for (const tool of ALL_TOOLS) {
      if (emitted.has(tool)) {
        continue;
      }
      const value = knownToolValue(tool);
      if (value !== undefined) {
        perm[tool] = value;
      }
    }

    // Filas libres nuevas, en el orden de las filas.
    for (const row of permExtraRows) {
      const key = (row.tool || "").trim();
      if (!key || emitted.has(key) || ALL_SET.has(key)) {
        continue;
      }
      const value = extraRowsValue(key);
      if (value !== undefined) {
        perm[key] = value;
      }
      emitted.add(key);
    }
    return perm;
  }

  /** Lo que emite hoy una tool conocida: mapa si hay patrones reales; si no, acción plana. */
  function knownToolValue(tool) {
    const st = toolState.get(tool);
    if (!st) {
      return undefined;
    }
    const map = {};
    if (!FLAT.has(tool)) {
      for (const rule of st.patterns) {
        const pattern = (rule.pattern || "").trim();
        if (pattern) {
          map[pattern] = rule.action || "allow";
        }
      }
    }
    if (Object.keys(map).length > 0) {
      return map;
    }
    return st.action || undefined;
  }

  /** Lo que emiten las filas libres de una clave: mapa si hay patrones; si no, la última acción plana. */
  function extraRowsValue(key) {
    let flat;
    const map = {};
    for (const row of permExtraRows) {
      if ((row.tool || "").trim() !== key) {
        continue;
      }
      const action = row.action || "allow";
      const pattern = (row.pattern || "").trim();
      if (pattern && !FLAT.has(key)) {
        map[pattern] = action;
      } else {
        flat = action;
      }
    }
    if (Object.keys(map).length > 0) {
      return map;
    }
    return flat;
  }

  // ---- opciones del proveedor (claves desconocidas) ------------------------

  function displayExtraValue(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  /** Texto plano -> string; JSON válido -> su valor (números, booleanos, objetos). */
  function parseExtraValue(text) {
    const t = String(text === undefined || text === null ? "" : text).trim();
    if (t === "") {
      return undefined;
    }
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  function loadOptions(fm) {
    optionRows = Object.keys(fm)
      .filter((key) => !KNOWN_KEYS.has(key))
      .map((key) => ({ key, value: displayExtraValue(fm[key]) }));
  }

  function renderOptions() {
    const wrap = $("option-rows");
    wrap.innerHTML = "";
    optionRows.forEach((row, index) => {
      const div = node("div", "opt-row");

      const key = document.createElement("input");
      key.type = "text";
      key.value = row.key;
      key.placeholder = "clave (reasoningEffort…)";
      key.spellcheck = false;
      key.addEventListener("input", () => {
        row.key = key.value;
        changed();
      });

      const value = document.createElement("input");
      value.type = "text";
      value.value = row.value;
      value.placeholder = "valor (texto o JSON)";
      value.spellcheck = false;
      value.addEventListener("input", () => {
        row.value = value.value;
        changed();
      });

      const rm = node("button", "secondary small", "✕");
      rm.setAttribute("type", "button");
      rm.title = "Quitar opción";
      rm.addEventListener("click", () => {
        optionRows.splice(index, 1);
        renderOptions();
        changed();
      });

      div.append(key, value, rm);
      wrap.appendChild(div);
    });
  }

  // ---- selector de modelos: combo buscable con scroll ----------------------
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
      const item = node("div", "combo-item" + (i === modelActive ? " active" : ""));
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", i === modelActive ? "true" : "false");
      item.appendChild(node("span", "combo-name", m.name || m.id));
      item.appendChild(node("span", "combo-id", m.id));
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
    changed();
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

  // ---- collect / validate ---------------------------------------------------

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

    // Opciones del proveedor: las claves desconocidas se reescriben desde las filas.
    for (const key of Object.keys(fm)) {
      if (!KNOWN_KEYS.has(key)) {
        delete fm[key];
      }
    }
    for (const row of optionRows) {
      const key = (row.key || "").trim();
      if (!key || KNOWN_KEYS.has(key)) {
        continue;
      }
      const value = parseExtraValue(row.value);
      if (value !== undefined) {
        fm[key] = value;
      }
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
      ul.appendChild(node("li", "ok", "Sin problemas."));
      return;
    }
    for (const issue of issues) {
      const li = node("li", issue.level || "info");
      li.textContent = (issue.field ? `[${issue.field}] ` : "") + issue.message;
      ul.appendChild(li);
    }
  }

  function renderCount() {
    const chars = textarea("f-prompt").value.length;
    $("prompt-count").textContent = chars + " caracteres · ~" + Math.round(chars / 4) + " tokens";
  }

  // ---- init ------------------------------------------------------------------

  function applyInit() {
    const d = init;

    mode = d.mode;
    agentName = d.name;
    source = d.source;
    filePath = d.filePath || "";
    renderHead();

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
    selectValue(select("f-mode"), fm.mode || "");
    input("f-model").value = fm.model || "";
    input("f-variant").value = fm.variant || "";
    input("f-temperature").value = fm.temperature ?? "";
    input("f-top_p").value = fm.top_p ?? "";
    input("f-steps").value = fm.steps ?? "";
    colorValue = typeof fm.color === "string" ? fm.color.trim() : "";
    refreshColorUi();
    renderColors();
    input("f-hidden").checked = !!fm.hidden;
    input("f-disable").checked = !!fm.disable;
    textarea("f-prompt").value = d.prompt || "";
    renderCount();

    loadPermission(fm.permission);
    renderTools();
    renderExtraRows();

    loadOptions(fm);
    renderOptions();

    $("preview").textContent = d.preview || "";

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
    $("btn-delete").hidden = !d.filePath;
    runValidate();
  }

  // ---- events ----------------------------------------------------------------

  function wireEvents() {
    // El picker se sincroniza ANTES del cableado genérico: cuando ese dispare runValidate,
    // colorValue ya tiene el valor nuevo.
    const picker = input("f-color");
    ["input", "change"].forEach((ev) =>
      picker.addEventListener(ev, () => {
        colorValue = picker.value;
        refreshColorHint();
        renderColors();
      })
    );

    $("btn-clear-color").addEventListener("click", () => {
      colorValue = "";
      refreshColorUi();
      renderColors();
      changed();
    });

    ["f-name", "f-description", "f-mode", "f-model", "f-variant", "f-temperature", "f-top_p", "f-steps", "f-color", "f-hidden", "f-disable", "f-prompt"].forEach(
      (id) => {
        const el = document.getElementById(id);
        el?.addEventListener("input", () => changed());
        el?.addEventListener("change", () => post({ type: "dirty", value: true }));
      }
    );

    textarea("f-prompt").addEventListener("input", renderCount);

    $("btn-add-perm").addEventListener("click", () => {
      permExtraRows.push({ tool: "", pattern: "", action: "allow" });
      renderExtraRows();
      changed();
    });

    $("btn-add-option").addEventListener("click", () => {
      optionRows.push({ key: "", value: "" });
      renderOptions();
      changed();
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
    $("btn-delete").addEventListener("click", () => post({ type: "delete" }));

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
        (init.patternTools || []).forEach((t) => PATTERN.add(t));
        (init.allTools || []).forEach((t) => {
          ALL_TOOLS.push(t);
          ALL_SET.add(t);
        });
        applyInit();
        break;
      case "validation":
        renderIssues(message.issues);
        $("preview").textContent = message.preview || "";
        break;
      case "saved":
        setBanner(message.message, !message.ok);
        if (message.ok) {
          if (message.file) {
            // El agente ya tiene fichero: la cabecera y "Abrir .md" se ponen al día.
            mode = "edit";
            filePath = message.file;
            source = "file";
            agentName = input("f-name").value.trim() || agentName;
            $("btn-open-raw").hidden = false;
            $("btn-delete").hidden = false;
            renderHead();
          }
          runValidate();
        }
        break;
    }
  });

  wireEvents();
  post({ type: "ready" });
})();
