/* Subagente de Claude — formulario del frontmatter y del prompt. */
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const el = {
    title: $("title"),
    subtitle: $("subtitle"),
    banner: $("banner"),
    name: $("f-name"),
    description: $("f-description"),
    scope: $("f-scope"),
    model: $("f-model"),
    modelCustom: $("f-model-custom"),
    modelCustomRow: $("row-model-custom"),
    modelHint: $("model-hint"),
    permission: $("f-permission"),
    permissionHint: $("permission-hint"),
    effort: $("f-effort"),
    maxTurns: $("f-max-turns"),
    memory: $("f-memory"),
    isolation: $("f-isolation"),
    skills: $("f-skills"),
    background: $("f-background"),
    omitClaudeMd: $("f-omit-claude-md"),
    colors: $("colors"),
    colorNone: $("btn-color-none"),
    toolAdd: $("f-tool-add"),
    toolAddBtn: $("btn-tool-add"),
    toolsKnown: $("tools-known"),
    toolsExtra: $("tools-extra"),
    toolsAll: $("btn-tools-all"),
    toolsRead: $("btn-tools-read"),
    prompt: $("f-prompt"),
    promptCount: $("prompt-count"),
    preview: $("preview"),
    issues: $("issues"),
    save: $("btn-save"),
    openRaw: $("btn-open-raw"),
    delete: $("btn-delete"),
    cancel: $("btn-cancel"),
  };

  /** Valor del desplegable de modelo para «Otro…». */
  const CUSTOM = "__otro";
  const READ_ONLY = ["Read", "Grep", "Glob"];

  let state = null;
  let tools = [];
  let color = "";
  let inited = false;
  let dirty = false;
  /** Tras guardar, el botón no vuelve hasta el próximo cambio. */
  let cleanAfterSave = false;
  let hasError = false;
  let timer = 0;

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function option(value, text) {
    const o = node("option", null, text);
    o.value = value;
    return o;
  }

  /** Asigna el valor; si el desplegable no tiene esa opción, la añade para no perderla. */
  function selectValue(select, value) {
    const text = String(value === undefined || value === null ? "" : value);
    const known = Array.prototype.some.call(select.options, (o) => o.value === text);
    if (text && !known) select.appendChild(option(text, text + " (desconocido)"));
    select.value = text;
  }

  /* ------------------------------- cabecera ------------------------------- */

  function renderHead() {
    if (!state) return;
    const create = state.mode === "create";
    el.title.textContent = create ? "Nuevo subagente" : "Editar " + (state.name || "subagente");
    el.subtitle.textContent =
      baseScope() + (!create && state.filePath ? " · " + state.filePath : "");
    // Sin fichero en disco no hay nada que borrar.
    el.delete.hidden = !state.filePath;
  }

  function baseScope() {
    return state.scope === "global" ? "USUARIO · ~/.claude/agents" : "PROYECTO · .claude/agents";
  }

  /** El scope `project` solo vale con una carpeta abierta. */
  function scopeAllowed(scope) {
    if (scope !== "project") return true;
    const project = el.scope.querySelector('option[value="project"]');
    return !project || !project.disabled;
  }

  function applyScope(value, hasProject) {
    const project = el.scope.querySelector('option[value="project"]');
    if (project) {
      project.disabled = !hasProject;
      project.title = hasProject ? "" : "sin carpeta abierta";
      project.textContent = hasProject
        ? "PROYECTO (.claude/agents)"
        : "PROYECTO (.claude/agents) (sin carpeta abierta)";
    }
    const wanted = value === "global" ? "global" : "project";
    el.scope.value = hasProject ? wanted : "global";
  }

  /* ------------------------------ herramientas ---------------------------- */

  function renderTools() {
    if (!state) return;
    el.toolsKnown.textContent = "";
    for (const tool of state.toolsCatalog) {
      const on = tools.indexOf(tool) !== -1;
      const chip = node("label", "chip" + (on ? " on" : ""));
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = tool;
      box.checked = on;
      box.addEventListener("change", () => setTool(tool, box.checked));
      chip.appendChild(box);
      chip.appendChild(node("span", "chip-text", tool));
      el.toolsKnown.appendChild(chip);
    }

    el.toolsExtra.textContent = "";
    const extras = tools.filter((tool) => state.toolsCatalog.indexOf(tool) === -1);
    for (const tool of extras) {
      const chip = node("span", "chip extra");
      chip.appendChild(node("span", "chip-text", tool));
      const remove = node("button", "chip-x", "×");
      remove.type = "button";
      remove.title = "Quitar " + tool;
      remove.setAttribute("aria-label", "Quitar " + tool);
      remove.addEventListener("click", () => setTool(tool, false));
      chip.appendChild(remove);
      el.toolsExtra.appendChild(chip);
    }
    el.toolsExtra.hidden = extras.length === 0;
  }

  function setTool(tool, on) {
    const has = tools.indexOf(tool) !== -1;
    if (on && !has) tools.push(tool);
    else if (!on && has) tools = tools.filter((item) => item !== tool);
    else return;
    renderTools();
    changed();
  }

  function addTool() {
    if (!inited) return;
    const value = el.toolAdd.value.trim();
    el.toolAdd.value = "";
    if (!value || tools.indexOf(value) !== -1) return;
    tools.push(value);
    renderTools();
    changed();
  }

  /* -------------------------------- modelo -------------------------------- */

  function renderModelOptions() {
    el.model.textContent = "";
    el.model.appendChild(option("", "(heredado)"));
    el.model.appendChild(option("inherit", "inherit (hereda del principal)"));
    for (const entry of state.models) {
      const label = entry.mapped ? entry.alias + " → " + entry.mapped : entry.alias;
      el.model.appendChild(option(entry.alias, label));
    }
    el.model.appendChild(option(CUSTOM, "Otro…"));
  }

  /** Selecciona el valor; si no es alias ni inherit, cae en «Otro…» con el id en el input. */
  function applyModel(value) {
    const model = String(value || "").trim();
    const known =
      model === "" ||
      model === "inherit" ||
      state.models.some((entry) => entry.alias === model);
    el.model.value = known ? model : CUSTOM;
    el.modelCustom.value = known ? "" : model;
    showCustom(!known);
    renderModelHint();
  }

  function showCustom(on) {
    el.modelCustom.hidden = !on;
    if (el.modelCustomRow) el.modelCustomRow.hidden = !on;
  }

  function currentModel() {
    return el.model.value === CUSTOM ? el.modelCustom.value.trim() : el.model.value;
  }

  function renderModelHint() {
    const model = currentModel();
    let text;
    if (el.model.value === CUSTOM) {
      text = model
        ? "«" + model + "» se enviará tal cual al proveedor."
        : "Escribe el id completo del modelo.";
    } else if (!model) {
      text = "Omitido, hereda el modelo del subagente y, si no hay, el principal.";
    } else if (model === "inherit") {
      text = "inherit: hereda el modelo del principal aunque el subagente tenga otro.";
    } else {
      const entry = state.models.find((item) => item.alias === model);
      text =
        entry && entry.mapped
          ? entry.alias + " → " + entry.mapped + " (mapeo de tu settings.json)."
          : model + " se envía tal cual: el CLI resuelve el alias.";
    }
    el.modelHint.textContent = text;
  }

  /* ------------------------------- permisos ------------------------------- */

  function renderPermissionHint() {
    const mode = el.permission.value;
    const risky = mode === "bypassPermissions" || mode === "dontAsk";
    if (risky) {
      el.permissionHint.textContent =
        mode + " no pregunta nada: el subagente actúa sin confirmación.";
    } else if (!mode) {
      el.permissionHint.textContent = "Omitido, hereda el modo del principal.";
    } else {
      el.permissionHint.textContent =
        mode + ": el CLI aplica el comportamiento normal de ese modo.";
    }
    el.permissionHint.classList.toggle("warn", risky);
  }

  /* -------------------------------- colores ------------------------------- */

  function renderColors() {
    if (!state) return;
    el.colors.textContent = "";
    for (const name of state.colors) {
      const chip = node("button", "color c-" + name);
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(color === name));
      chip.appendChild(node("span", "dot"));
      chip.appendChild(node("span", "color-name", name));
      chip.addEventListener("click", () => setColor(name));
      el.colors.appendChild(chip);
    }
  }

  function setColor(next) {
    color = next;
    renderColors();
    changed();
  }

  /* -------------------------------- estado -------------------------------- */

  function renderCount() {
    const chars = el.prompt.value.length;
    el.promptCount.textContent = chars + " caracteres · ~" + Math.round(chars / 4) + " tokens";
  }

  function renderSave() {
    el.save.disabled = !inited || hasError || cleanAfterSave;
  }

  function splitSkills(text) {
    const out = [];
    for (const raw of String(text || "").split(/[\n,]+/)) {
      const item = raw.trim();
      if (item && out.indexOf(item) === -1) out.push(item);
    }
    return out;
  }

  /** Lo que se manda al host: todos los campos, los vacíos tal cual. */
  function collect() {
    const fields = {
      description: el.description.value.trim(),
      tools: tools.slice(),
      model: currentModel(),
      color: color,
      permissionMode: el.permission.value,
      effort: el.effort.value,
      skills: splitSkills(el.skills.value),
      memory: el.memory.value,
      isolation: el.isolation.value,
      omitClaudeMd: !!el.omitClaudeMd.checked,
      background: !!el.background.checked,
    };
    const turns = el.maxTurns.value.trim();
    if (turns) fields.maxTurns = turns;
    const scope = scopeAllowed(el.scope.value) ? el.scope.value : "global";
    return { name: el.name.value.trim(), scope: scope, fields, prompt: el.prompt.value };
  }

  function postValidate() {
    if (!inited) return;
    vscode.postMessage({ type: "validate", payload: collect() });
  }

  /** Cambio del usuario: marca sucio y revalida tras la pausa. */
  function changed() {
    if (!inited) return;
    cleanAfterSave = false;
    if (!dirty) {
      dirty = true;
      vscode.postMessage({ type: "dirty", value: true });
    }
    renderSave();
    clearTimeout(timer);
    timer = setTimeout(postValidate, 250);
  }

  /* ------------------------------ mensajes del host ----------------------- */

  function applyInit(payload) {
    if (!payload) return;
    state = payload;
    tools = (payload.fields.tools || []).slice();
    color = payload.fields.color || "";

    el.name.value = payload.name || "";
    applyScope(payload.scope, payload.hasProject !== false);
    state.scope = el.scope.value === "global" ? "global" : "project";
    el.description.value = payload.fields.description || "";
    selectValue(el.permission, payload.fields.permissionMode || "");
    selectValue(el.effort, payload.fields.effort || "");
    el.maxTurns.value =
      payload.fields.maxTurns === undefined || payload.fields.maxTurns === null
        ? ""
        : String(payload.fields.maxTurns);
    selectValue(el.memory, payload.fields.memory || "");
    selectValue(el.isolation, payload.fields.isolation || "");
    el.skills.value = (payload.fields.skills || []).join("\n");
    el.background.checked = !!payload.fields.background;
    el.omitClaudeMd.checked = !!payload.fields.omitClaudeMd;
    el.prompt.value = payload.prompt || "";
    el.preview.textContent = payload.preview || "";

    renderHead();
    renderTools();
    renderModelOptions();
    applyModel(payload.fields.model || "");
    renderColors();
    renderCount();
    renderPermissionHint();

    inited = true;
    dirty = false;
    cleanAfterSave = false;
    renderSave();
    postValidate();
  }

  function applyValidation(message) {
    el.preview.textContent = message.preview || "";
    const issues = message.issues || [];
    hasError = false;
    el.issues.textContent = "";
    for (const issue of issues) {
      if (issue.level === "error") hasError = true;
      el.issues.appendChild(node("li", issue.level || "info", issue.message));
    }
    if (issues.length === 0) {
      el.issues.appendChild(node("li", "ok", "Sin problemas."));
    }
    renderSave();
  }

  function applySaved(message) {
    const ok = !!message.ok;
    el.banner.hidden = false;
    el.banner.classList.toggle("ok", ok);
    el.banner.classList.toggle("error", !ok);
    el.banner.textContent = message.message || (ok ? "Guardado." : "No se pudo guardar.");
    if (!ok) return;
    clearTimeout(timer);
    dirty = false;
    cleanAfterSave = true;
    if (message.file && state) state.filePath = message.file;
    if (state) {
      // El modo pasa a edición y el nombre se refresca también al renombrar.
      state.mode = "edit";
      state.name = el.name.value.trim();
    }
    renderHead();
    renderSave();
    vscode.postMessage({ type: "dirty", value: false });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "init") applyInit(message.payload);
    else if (message.type === "validation") applyValidation(message);
    else if (message.type === "saved") applySaved(message);
  });

  /* --------------------------------- eventos ------------------------------ */

  function onField(event) {
    if (!inited) return;
    const target = event && event.target;
    if (target === el.scope) {
      if (!scopeAllowed(el.scope.value)) el.scope.value = "global";
      state.scope = el.scope.value === "global" ? "global" : "project";
      renderHead();
    }
    if (target === el.model) {
      const custom = el.model.value === CUSTOM;
      if (!custom) el.modelCustom.value = "";
      showCustom(custom);
      renderModelHint();
    }
    if (target === el.modelCustom) renderModelHint();
    if (target === el.permission) renderPermissionHint();
    if (target === el.prompt) renderCount();
    changed();
  }

  for (const field of [
    el.name,
    el.description,
    el.scope,
    el.model,
    el.modelCustom,
    el.permission,
    el.effort,
    el.maxTurns,
    el.memory,
    el.isolation,
    el.skills,
    el.background,
    el.omitClaudeMd,
    el.prompt,
  ]) {
    if (!field) continue;
    field.addEventListener("input", onField);
    field.addEventListener("change", onField);
  }

  el.toolsAll.addEventListener("click", () => {
    if (!inited) return;
    for (const tool of state.toolsCatalog) {
      if (tools.indexOf(tool) === -1) tools.push(tool);
    }
    renderTools();
    changed();
  });

  el.toolsRead.addEventListener("click", () => {
    if (!inited) return;
    tools = READ_ONLY.slice();
    renderTools();
    changed();
  });

  el.toolAddBtn.addEventListener("click", addTool);

  el.toolAdd.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addTool();
  });

  el.colorNone.addEventListener("click", () => {
    if (!inited) return;
    color = "";
    renderColors();
    changed();
  });

  el.save.addEventListener("click", () => {
    if (!inited) return;
    vscode.postMessage({ type: "save", payload: collect() });
  });

  el.cancel.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  el.openRaw.addEventListener("click", () => vscode.postMessage({ type: "openRaw" }));
  el.delete.addEventListener("click", () => vscode.postMessage({ type: "delete" }));

  el.banner.setAttribute("aria-live", "polite");
  el.issues.setAttribute("aria-live", "polite");
  el.save.disabled = true;

  // El prompt es Markdown: se ve coloreado sin dejar de editarse como texto plano.
  window.MdEditor?.attachTextarea(el.prompt);

  vscode.postMessage({ type: "ready" });
})();
