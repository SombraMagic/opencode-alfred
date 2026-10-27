/* Conectores — alta, credenciales y catálogo de modelos de cada proveedor de opencode. */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    sub: document.getElementById("sub"),
    search: document.getElementById("search"),
    refresh: document.getElementById("refresh"),
    close: document.getElementById("close"),
    all: document.getElementById("all"),
    allCount: document.getElementById("all-count"),
    configured: document.getElementById("configured"),
    confCount: document.getElementById("conf-count"),
    detail: document.getElementById("detail"),
    models: document.getElementById("models"),
    modelsCount: document.getElementById("models-count"),
    notice: document.getElementById("notice"),
    noticeText: document.getElementById("notice-text"),
    noticeX: document.getElementById("notice-x"),
  };

  // «CLAVE DE API» etc. es el nombre que se pinta; el label de opencode va de subtítulo.
  const METHOD_LABEL = {
    key: "CLAVE DE API",
    oauth: "INICIAR SESIÓN",
    external: "CREDENCIALES EXTERNAS",
    command: "COMANDO",
    env: "VARIABLE DE ENTORNO",
  };

  const ATTEMPT_TEXT = {
    pending: "Pendiente",
    complete: "Completado",
    failed: "Falló",
    expired: "Caducado",
    cancelled: "Cancelado",
  };

  const ATTEMPT_DONE = {
    complete: "Autorización completada.",
    failed: "No se pudo completar la autorización.",
    expired: "El intento ha caducado. Vuelve a iniciarlo.",
    cancelled: "Intento cancelado.",
  };

  let data = null;
  let search = "";
  // Solo el primer payload siembra el buscador: los repintados no pisan lo que se escribe.
  let searchInited = false;
  let saveTimer = 0;
  // Formulario abierto: {id, methodID}. Se cierra al cambiar de conector.
  let openMethod = null;
  // Respuestas no secretas del formulario abierto, para sobrevivir a un repintado.
  let draft = {};
  // Intentos por conector: sobreviven al cambio de selección.
  const attempts = new Map();

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function post(action) {
    vscode.postMessage({ type: "action", action });
  }

  function empty(text) {
    return node("div", "empty", text);
  }

  function plural(count, one, many) {
    return count + " " + (count === 1 ? one : many);
  }

  function selectedConnector() {
    if (!data) return null;
    return (data.connectors || []).find((c) => c.id === data.selected) || null;
  }

  /** Solo http/https: nada de esquemas que abran otra cosa. */
  function safeUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  // ── Aviso ───────────────────────────────────────────────
  function showNotice(level, text) {
    if (!text) return;
    el.notice.hidden = false;
    el.notice.className = "notice " + (level === "error" ? "error" : "info");
    el.noticeText.textContent = text;
  }

  el.noticeX.addEventListener("click", () => {
    el.notice.hidden = true;
  });

  // ── Buscador ────────────────────────────────────────────
  function persistView() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      post({ type: "persistView", search: el.search.value });
    }, 300);
  }

  el.search.addEventListener("input", () => {
    search = el.search.value;
    persistView();
    if (data) renderAll();
  });

  // ── Columna TODOS ───────────────────────────────────────
  function dotClass(connector) {
    if (!connector.configured) return "dot idle";
    return connector.enabled ? "dot on" : "dot off";
  }

  function renderAll() {
    const list = data.connectors || [];
    const query = search.trim().toLowerCase();
    const shown = query
      ? list.filter((c) => (c.name + " " + c.id).toLowerCase().includes(query))
      : list;

    el.allCount.textContent = query
      ? shown.length + "/" + list.length
      : String(list.length);

    el.all.textContent = "";
    if (shown.length === 0) {
      el.all.appendChild(
        empty(query ? "Sin coincidencias." : "No hay conectores disponibles.")
      );
      return;
    }

    for (const connector of shown) {
      const row = node("button", "conn-row" + (connector.id === data.selected ? " sel" : ""));
      row.type = "button";
      const state = !connector.configured
        ? "sin configurar"
        : connector.enabled
          ? "activo"
          : "apagado";
      row.title = (connector.providerId || connector.id) + " · " + state;
      row.setAttribute("aria-pressed", String(connector.id === data.selected));
      row.appendChild(node("span", dotClass(connector)));
      row.appendChild(node("span", "conn-name", connector.name));
      row.appendChild(node("span", "conn-count", plural(connector.modelCount || 0, "modelo", "modelos")));
      row.addEventListener("click", () => post({ type: "select", id: connector.id }));
      el.all.appendChild(row);
    }
  }

  // ── Columna CONFIGURADOS ────────────────────────────────
  function renderConfigured() {
    const conf = (data.connectors || []).filter((c) => c.configured);
    el.confCount.textContent = String(conf.length);
    el.configured.textContent = "";

    if (conf.length === 0) {
      el.configured.appendChild(empty("Ningún conector configurado."));
      return;
    }

    for (const connector of conf) {
      const row = node("div", "conf-row");
      row.appendChild(node("span", dotClass(connector)));

      const name = node("button", "conf-name", connector.name);
      name.type = "button";
      name.title = connector.providerId || connector.id;
      name.addEventListener("click", () => post({ type: "select", id: connector.id }));
      row.appendChild(name);

      // Sin toggleable (p. ej. un conector fijo del host) no se ofrece el interruptor.
      if (connector.toggleable) {
        const sw = node("button", "switch" + (connector.enabled ? " on" : ""));
        sw.type = "button";
        sw.setAttribute("aria-pressed", String(connector.enabled));
        sw.setAttribute(
          "aria-label",
          (connector.enabled ? "Desactivar " : "Activar ") + connector.name
        );
        sw.title = connector.enabled ? "Desactivar" : "Activar";
        const track = node("span", "switch-track");
        track.appendChild(node("span", "switch-thumb"));
        sw.appendChild(track);
        sw.addEventListener("click", () =>
          post({ type: "toggle", id: connector.id, on: !connector.enabled })
        );
        row.appendChild(sw);
      }

      // Límites de consumo: casilla aparte, solo para los conectores que los exponen.
      if (connector.limitsSupported === true) {
        const limits = node("button", "switch limits" + (connector.limitsOn ? " on" : ""));
        limits.type = "button";
        limits.setAttribute("aria-pressed", String(!!connector.limitsOn));
        const ayuda = "Mostrar límites de consumo de " + connector.name;
        limits.setAttribute("aria-label", ayuda);
        limits.title = ayuda;
        limits.appendChild(node("span", "limits-box"));
        limits.addEventListener("click", () =>
          post({ type: "toggleLimits", id: connector.id, on: !connector.limitsOn })
        );
        row.appendChild(limits);
      }

      const remove = node("button", "remove", "✕");
      remove.type = "button";
      remove.title = "Eliminar configuración";
      remove.setAttribute("aria-label", "Eliminar la configuración de " + connector.name);
      remove.addEventListener("click", () => post({ type: "remove", id: connector.id }));
      row.appendChild(remove);

      el.configured.appendChild(row);
    }
  }

  // ── Formularios ─────────────────────────────────────────
  function valueFor(field) {
    if (Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key];
    return field.default;
  }

  function fieldLabel(field) {
    const label = node("span", "field-label");
    label.appendChild(document.createTextNode(field.title || field.key));
    if (field.required) label.appendChild(node("span", "req", " *"));
    return label;
  }

  function applyInput(field, input) {
    if (field.required) input.required = true;
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.minLength !== undefined) input.minLength = field.minLength;
    if (field.maxLength !== undefined) input.maxLength = field.maxLength;
    // El `pattern` de opencode no es el de HTML (allí casa una parte, aquí todo el valor):
    // se deja validar al servidor para no bloquear valores válidos.
    if (field.minimum !== undefined) input.min = String(field.minimum);
    if (field.maximum !== undefined) input.max = String(field.maximum);
  }

  /** Un control por campo, con su valor inicial. Devuelve lo necesario para leerlo. */
  function buildField(field) {
    const wrap = node("div", "field");
    wrap.hidden = false;

    if (field.type === "boolean") {
      const label = node("label", "check");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!valueFor(field);
      label.appendChild(input);
      label.appendChild(node("span", null, field.title || field.key));
      wrap.appendChild(label);
      if (field.description) wrap.appendChild(node("div", "field-desc", field.description));
      return { field, wrap, input };
    }

    if (field.type === "multiselect") {
      wrap.appendChild(fieldLabel(field));
      const opts = node("div", "opts");
      const boxes = [];
      const current = valueFor(field);
      const values = Array.isArray(current) ? current.map(String) : [];
      for (const opt of field.options || []) {
        const label = node("label", "opt");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = opt.value;
        box.checked = values.includes(String(opt.value));
        label.appendChild(box);
        label.appendChild(node("span", null, opt.label));
        if (opt.description) label.title = opt.description;
        opts.appendChild(label);
        boxes.push(box);
      }
      wrap.appendChild(opts);
      if (field.description) wrap.appendChild(node("div", "field-desc", field.description));
      return { field, wrap, boxes };
    }

    if (field.type === "external") {
      wrap.appendChild(fieldLabel(field));
      if (field.description) wrap.appendChild(node("div", "field-desc", field.description));
      const href = safeUrl(field.url);
      if (href) {
        const open = node("button", "btn", "ABRIR");
        open.type = "button";
        open.addEventListener("click", () => post({ type: "openUrl", url: href }));
        wrap.appendChild(open);
      }
      return { field, wrap };
    }

    wrap.appendChild(fieldLabel(field));
    let input;
    if (field.type === "string" && field.options && field.options.length) {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "—";
      input.appendChild(blank);
      for (const opt of field.options) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.description) option.title = opt.description;
        input.appendChild(option);
      }
      const current = valueFor(field);
      input.value = current === undefined ? "" : String(current);
    } else {
      input = document.createElement("input");
      input.type = field.type === "number" || field.type === "integer" ? "number" : "text";
      if (input.type === "number") input.step = field.type === "integer" ? "1" : "any";
      const current = valueFor(field);
      if (current !== undefined && current !== null) input.value = String(current);
    }
    applyInput(field, input);
    wrap.appendChild(input);
    if (field.description) wrap.appendChild(node("div", "field-desc", field.description));
    return { field, wrap, input };
  }

  function readValue(entry) {
    const field = entry.field;
    if (field.type === "boolean") return entry.input.checked;
    if (field.type === "multiselect") {
      return (entry.boxes || []).filter((b) => b.checked).map((b) => b.value);
    }
    if (field.type === "external") return undefined;
    const raw = entry.input.value;
    if (field.type === "number" || field.type === "integer") {
      if (raw.trim() === "") return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    return raw;
  }

  /** Compara con el valor actual del formulario: si no coincide, el campo no aplica. */
  function conditionOk(when, entries) {
    const target = entries.find((e) => e.field.key === when.key);
    if (!target) return false;
    const current = readValue(target);
    const same =
      typeof current === "boolean" && typeof when.value === "boolean"
        ? current === when.value
        : String(current) === String(when.value);
    return when.op === "neq" ? !same : same;
  }

  function updateConditions(entries) {
    for (const entry of entries) {
      const visible = !entry.field.when || conditionOk(entry.field.when, entries);
      entry.wrap.hidden = !visible;
      const controls = entry.input ? [entry.input] : entry.boxes || [];
      for (const control of controls) {
        control.required = visible && !!entry.field.required && entry.field.type !== "multiselect";
      }
    }
  }

  /** Respuesta del método: hidden con su default, visibles con su valor, condiciones respetadas. */
  function collect(fields, entries) {
    const answer = {};
    for (const field of fields) {
      if (field.hidden) {
        if (field.default !== undefined) answer[field.key] = field.default;
        continue;
      }
      const entry = entries.find((e) => e.field === field);
      if (!entry || entry.wrap.hidden || field.type === "external") continue;
      const value = readValue(entry);
      if (value === undefined) continue;
      if (typeof value === "string" && value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      answer[field.key] = value;
    }
    return answer;
  }

  function captureDraft(entries) {
    const next = {};
    for (const entry of entries) {
      const field = entry.field;
      if (field.hidden || field.type === "external" || entry.wrap.hidden) continue;
      const value = readValue(entry);
      if (value !== undefined && value !== "") next[field.key] = value;
    }
    draft = next;
  }

  function buildForm(fields, submitLabel, onSubmit, secretKey) {
    const form = document.createElement("form");
    form.className = "form";

    const entries = [];
    let secretInput = null;

    // La clave de API no viaja en `answer`: tiene su propio campo en la acción.
    if (secretKey) {
      const wrap = node("div", "field");
      wrap.appendChild(fieldLabel({ key: "key", title: "CLAVE DE API", required: true }));
      secretInput = document.createElement("input");
      secretInput.type = "password";
      secretInput.required = true;
      secretInput.autocomplete = "off";
      secretInput.placeholder = "Pega la clave";
      secretInput.setAttribute("aria-label", "Clave de API");
      wrap.appendChild(secretInput);
      form.appendChild(wrap);
    }

    for (const field of fields) {
      if (field.hidden) continue;
      const entry = buildField(field);
      entries.push(entry);
      form.appendChild(entry.wrap);
    }

    updateConditions(entries);

    form.addEventListener("input", () => {
      if (secretInput) secretInput.setCustomValidity("");
      updateConditions(entries);
      captureDraft(entries);
    });
    form.addEventListener("change", () => {
      updateConditions(entries);
      captureDraft(entries);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (secretInput) {
        // `required` no ve una clave de espacios: se corta aquí antes de postearla.
        const empty = secretInput.value.trim() === "";
        secretInput.setCustomValidity(empty ? "La clave no puede estar vacía." : "");
        if (empty) {
          secretInput.reportValidity();
          secretInput.focus();
          return;
        }
      }
      if (!form.reportValidity()) return;
      const answer = collect(fields, entries);
      onSubmit(answer, secretInput ? secretInput.value.trim() : "");
      captureDraft(entries);
    });

    const actions = node("div", "form-actions");
    const submit = node("button", "btn primary", submitLabel);
    submit.type = "submit";
    actions.appendChild(submit);
    form.appendChild(actions);
    return form;
  }

  function renderEnv(method) {
    const box = node("div", "form-box");
    if (method.label) box.appendChild(node("div", "method-sub", method.label));
    const names = method.envNames || [];
    if (names.length) {
      const list = node("ul", "files");
      for (const name of names) {
        const item = document.createElement("li");
        item.appendChild(node("code", null, name));
        list.appendChild(item);
      }
      box.appendChild(list);
    }
    box.appendChild(
      node(
        "div",
        "form-note",
        "Se configura en el servidor: estas variables se leen del entorno y no se pueden guardar desde aquí."
      )
    );
    return box;
  }

  function renderMethod(c) {
    const method = (c.methods || []).find((m) => m.id === openMethod.methodID);
    if (!method) {
      openMethod = null;
      return null;
    }
    const baseFields = (method.fields || []).filter((f) => f.type !== "external");
    const externalFields = (method.fields || []).filter((f) => f.type === "external");

    if (method.type === "env") return renderEnv(method);

    const box = node("div", "form-box");
    if (method.label) box.appendChild(node("div", "method-sub", method.label));

    if (method.type === "command") {
      for (const field of externalFields) {
        box.appendChild(node("div", "field-desc", field.title || field.key));
        if (field.description) box.appendChild(node("div", "field-desc", field.description));
      }
      const actions = node("div", "form-actions");
      const run = node("button", "btn primary", "EJECUTAR");
      run.type = "button";
      run.addEventListener("click", () =>
        post({ type: "startCommand", id: c.id, methodID: method.id })
      );
      actions.appendChild(run);
      box.appendChild(actions);
      return box;
    }

    if (method.type === "external") {
      // El método externo también trae formulario (perfil de AWS, proyecto de GCP…).
      box.appendChild(
        buildForm(method.fields || [], "CONECTAR", (answer) =>
          post({ type: "connectExternal", id: c.id, methodID: method.id, answer })
        )
      );
      return box;
    }

    if (method.type === "key") {
      box.appendChild(
        buildForm(
          baseFields,
          "CONECTAR",
          (answer, key) => post({ type: "connectKey", id: c.id, key, answer }),
          true
        )
      );
      return box;
    }

    if (method.type === "oauth") {
      box.appendChild(
        buildForm(baseFields, "INICIAR SESIÓN", (answer) =>
          post({ type: "startOauth", id: c.id, methodID: method.id, answer })
        )
      );
      return box;
    }

    return box;
  }

  // ── Intento de autorización ─────────────────────────────
  function renderAttempt(c) {
    const attempt = attempts.get(c.id);
    if (!attempt) return null;

    const status = ATTEMPT_TEXT[attempt.status] || attempt.status || "Pendiente";
    const box = node("div", "attempt " + (attempt.status || "pending"));
    box.appendChild(node("div", "attempt-status", "INTENTO · " + status));

    const message = attempt.message || (attempt.status !== "pending" ? ATTEMPT_DONE[attempt.status] : "");
    if (message) box.appendChild(node("div", "attempt-msg", message));

    const href = safeUrl(attempt.url);
    if (href) {
      const row = node("div", "attempt-url");
      row.appendChild(node("span", "attempt-url-text", attempt.url));
      const open = node("button", "btn", "ABRIR");
      open.type = "button";
      open.setAttribute("aria-label", "Abrir la dirección de autorización");
      open.addEventListener("click", () => post({ type: "openUrl", url: href }));
      row.appendChild(open);
      box.appendChild(row);
    }

    if (attempt.instructions) {
      box.appendChild(node("pre", "attempt-instructions", attempt.instructions));
    }

    if (attempt.status === "pending" && attempt.mode === "code") {
      const form = document.createElement("form");
      form.className = "attempt-code";
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.placeholder = "Pega el código de autorización";
      input.setAttribute("aria-label", "Código de autorización");
      form.appendChild(input);
      const complete = node("button", "btn primary", "COMPLETAR");
      complete.type = "submit";
      form.appendChild(complete);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!input.value.trim()) {
          input.focus();
          return;
        }
        post({
          type: "completeOauth",
          id: c.id,
          attemptID: attempt.attemptID,
          code: input.value.trim(),
        });
      });
      box.appendChild(form);
    }

    if (attempt.status === "pending") {
      const actions = node("div", "form-actions");
      const cancel = node("button", "btn", "CANCELAR");
      cancel.type = "button";
      cancel.addEventListener("click", () =>
        post({
          type: "cancelAttempt",
          id: c.id,
          attemptID: attempt.attemptID,
          kind: attempt.kind,
        })
      );
      actions.appendChild(cancel);
      box.appendChild(actions);
    }
    return box;
  }

  // ── Detalle ─────────────────────────────────────────────
  function connectionType(connection) {
    return connection.type === "env" ? "ENTORNO" : "CREDENCIAL";
  }

  function renderDetail() {
    el.detail.textContent = "";
    const c = selectedConnector();
    if (!c) {
      el.detail.appendChild(empty("Selecciona un conector."));
      return;
    }

    const head = node("div", "detail-head");
    head.appendChild(node("span", "detail-name", c.name));
    const state = !c.configured
      ? "Sin configurar"
      : c.enabled
        ? "Configurado y activo"
        : "Configurado y apagado";
    head.appendChild(
      node(
        "span",
        "chip " + (c.configured ? (c.enabled ? "on" : "warn") : "off"),
        state.toUpperCase()
      )
    );
    el.detail.appendChild(head);
    el.detail.appendChild(node("div", "detail-state", c.providerId || c.id));

    const attempt = renderAttempt(c);
    if (attempt) el.detail.appendChild(attempt);

    if (c.connections && c.connections.length) {
      const sect = node("div", "sect");
      sect.appendChild(node("h3", "sect-title", "CONEXIONES"));
      for (const connection of c.connections) {
        const line = node("div", "conn-line");
        line.appendChild(node("span", "chip", connectionType(connection)));
        line.appendChild(node("span", "conn-label", connection.label));
        if (connection.method) line.appendChild(node("span", "conn-status", connection.method));
        if (connection.status) line.appendChild(node("span", "conn-status", connection.status));
        if (connection.message) line.appendChild(node("span", "conn-msg", connection.message));
        sect.appendChild(line);
      }
      el.detail.appendChild(sect);
    }

    if (c.configFiles && c.configFiles.length) {
      const sect = node("div", "sect");
      sect.appendChild(node("h3", "sect-title", "FICHEROS DE CONFIGURACIÓN"));
      const list = node("ul", "files");
      for (const file of c.configFiles) {
        const item = document.createElement("li");
        item.appendChild(node("code", null, file));
        list.appendChild(item);
      }
      sect.appendChild(list);
      el.detail.appendChild(sect);
    }

    const alta = node("div", "sect");
    alta.appendChild(node("h3", "sect-title", c.configured ? "AÑADIR CUENTA" : "CONECTAR"));
    const methods = c.methods || [];
    if (methods.length === 0) {
      alta.appendChild(node("div", "form-note", "Este conector no declara métodos de alta."));
    } else {
      const row = node("div", "methods");
      for (const method of methods) {
        const open = openMethod && openMethod.id === c.id && openMethod.methodID === method.id;
        const button = node("button", "method" + (open ? " on" : ""));
        button.type = "button";
        button.setAttribute("aria-pressed", String(open));
        button.appendChild(
          node("span", "method-label", METHOD_LABEL[method.type] || method.type)
        );
        if (method.label) button.appendChild(node("span", "method-sub", method.label));
        button.addEventListener("click", () => {
          if (open) {
            openMethod = null;
          } else {
            openMethod = { id: c.id, methodID: method.id };
            draft = {};
          }
          renderDetail();
        });
        row.appendChild(button);
      }
      alta.appendChild(row);

      if (openMethod && openMethod.id === c.id) {
        const box = renderMethod(c);
        if (box) alta.appendChild(box);
      }
    }
    el.detail.appendChild(alta);
  }

  // ── Columna MODELOS ─────────────────────────────────────
  function usd(value) {
    const fixed = value < 1 ? value.toFixed(3) : value.toFixed(2);
    return "$" + fixed.replace(/0+$/, "").replace(/\.$/, "");
  }

  function tokens(value) {
    if (!value) return "—";
    if (value >= 1000000) {
      return (Math.round(value / 100000) / 10).toFixed(1).replace(".", ",") + " M";
    }
    if (value >= 1000) return Math.round(value / 1000) + " K";
    return String(value);
  }

  function modelCard(model) {
    const card = node("article", "model-card");

    const head = node("div", "model-head");
    head.appendChild(node("span", "model-name", model.name || model.id));
    head.appendChild(node("span", "model-id", model.id));
    card.appendChild(head);

    if (model.description) {
      const desc = node("p", "model-desc", model.description);
      desc.title = model.description;
      card.appendChild(desc);
    }

    const cost = model.cost || {};
    const parts = [
      ["ENTRADA", cost.input],
      ["SALIDA", cost.output],
      ["CACHÉ LECTURA", cost.cacheRead],
      ["CACHÉ ESCRITURA", cost.cacheWrite],
    ].filter(([, value]) => typeof value === "number");
    const prices = node("div", "model-prices");
    prices.title = "USD por millón de tokens";
    if (parts.length === 0) {
      prices.appendChild(node("span", "price-none", "—"));
    } else if (model.free || parts.every(([, value]) => value === 0)) {
      prices.appendChild(node("span", "price-free", "GRATIS"));
    } else {
      for (const [label, value] of parts) {
        const price = node("span", "price");
        price.appendChild(node("span", "price-l", label));
        price.appendChild(node("span", "price-v", usd(value)));
        prices.appendChild(price);
      }
    }
    card.appendChild(prices);

    const meta = node("div", "model-meta");
    const context = node("span", null, "CONTEXTO ");
    context.appendChild(node("span", "val", tokens(model.context)));
    meta.appendChild(context);
    if (model.output) {
      const output = node("span", null, "SALIDA ");
      output.appendChild(node("span", "val", tokens(model.output)));
      meta.appendChild(output);
    }
    card.appendChild(meta);

    const chips = node("div", "model-chips");
    if (model.free) chips.appendChild(node("span", "chip on", "FREE"));
    const status = model.status ? String(model.status).toUpperCase() : "";
    if (status === "BETA" || status === "ALPHA" || status === "DEPRECATED") {
      chips.appendChild(
        node("span", "chip" + (status === "DEPRECATED" ? " bad" : " warn"), status)
      );
    }
    if (model.tools) chips.appendChild(node("span", "chip", "TOOLS"));
    if (model.reasoning) chips.appendChild(node("span", "chip", "RAZONA"));
    if (model.vision) chips.appendChild(node("span", "chip", "VISIÓN"));
    if (chips.children.length) card.appendChild(chips);

    return card;
  }

  function renderModelsColumn() {
    const c = selectedConnector();
    const models = (data && data.models) || [];
    el.models.textContent = "";
    el.modelsCount.textContent = c ? String(models.length) : "";

    if (!c) {
      const box = empty("Sin modelos.");
      box.appendChild(node("span", "hint", "Selecciona un conector para ver su catálogo."));
      el.models.appendChild(box);
      return;
    }
    if (models.length === 0) {
      const box = empty("Este conector no ofrece modelos.");
      box.appendChild(node("span", "hint", "No publica catálogo de modelos."));
      el.models.appendChild(box);
      return;
    }
    for (const model of models) el.models.appendChild(modelCard(model));
  }

  // ── Aplicar datos ───────────────────────────────────────
  function apply(payload) {
    if (!payload) return;
    const previous = data ? data.selected : null;
    data = payload;

    if (!searchInited) {
      search = typeof payload.search === "string" ? payload.search : "";
      el.search.value = search;
      searchInited = true;
    }

    if (previous !== null && previous !== payload.selected) {
      openMethod = null;
      draft = {};
    }

    el.sub.textContent =
      "opencode · " +
      plural(payload.configuredCount || 0, "configurado", "configurados");

    renderAll();
    renderConfigured();
    renderDetail();
    renderModelsColumn();

    if (payload.note) showNotice("info", payload.note);
  }

  el.refresh.addEventListener("click", () => post({ type: "refresh" }));
  el.close.addEventListener("click", () => post({ type: "close" }));

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;

    if (message.type === "connectors") {
      apply(message.payload);
      return;
    }

    if (message.type === "attempt") {
      const attempt = message.payload;
      if (!attempt || !attempt.id) return;
      const previous = attempts.get(attempt.id);
      // El estado que llega del sondeo no repite URL ni instrucciones: se conservan.
      const merged =
        previous && previous.attemptID === attempt.attemptID
          ? { ...previous, ...attempt }
          : attempt;
      attempts.set(attempt.id, merged);
      const same =
        previous &&
        previous.attemptID === merged.attemptID &&
        previous.status === merged.status &&
        previous.message === merged.message;
      if (!same && data && merged.id === data.selected) renderDetail();
      return;
    }

    if (message.type === "notice") {
      showNotice(message.level, message.text);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
