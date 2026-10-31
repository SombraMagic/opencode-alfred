/* ALFRED // GENERADOR DE IMÁGENES — ComfyUI y OpenAI.
   El host manda `state` y la webview solo acumula los ajustes locales (modelo, tamaño,
   LoRAs y fuerza) hasta GENERAR. Ningún mensaje sale sin acción del usuario. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const el = {
    dot: $("gen-dot"),
    provider: $("provider"),
    url: $("url"),
    port: $("port"),
    connect: $("btn-connect"),
    fieldPort: $("field-port"),
    fieldKey: $("field-key"),
    key: $("key"),
    keyDot: $("key-dot"),
    saveKey: $("btn-save-key"),
    status: $("status"),
    message: $("message"),
    share: $("share"),
    shareLabel: document.querySelector("label.gen-share"),
    shareNote: $("share-note"),
    prompt: $("prompt"),
    model: $("model"),
    modelRow: $("model-row"),
    modelReload: $("btn-model-reload"),
    modelInput: $("model-input"),
    width: $("width"),
    height: $("height"),
    steps: $("steps"),
    cfg: $("cfg"),
    sizeHint: $("size-hint"),
    sizeOpenaiHint: $("size-openai-hint"),
    blockSeed: $("block-seed"),
    seed: $("seed"),
    seedBtn: $("btn-seed"),
    seedRandom: $("seed-random"),
    loras: $("loras"),
    loraPick: $("lora-pick"),
    loraAdd: $("btn-lora-add"),
    blockLoras: $("block-loras"),
    blockSource: $("block-source"),
    sourcePick: $("btn-source-pick"),
    sourceWrap: $("source-wrap"),
    sourceThumb: $("source-thumb"),
    sourceClear: $("btn-source-clear"),
    denoise: $("denoise"),
    negative: $("negative"),
    generate: $("btn-generate"),
    progress: $("progress"),
    preview: $("preview"),
    previewEmpty: $("preview-empty"),
    previewMeta: $("preview-meta"),
    save: $("btn-save"),
    copy: $("btn-copy"),
    history: $("history"),
    clearHistory: $("btn-clear-history"),
    folder: $("btn-folder"),
  };

  const MAX_LORAS = 8;
  const HINT_NEGATIVO = "OpenAI no usa prompt negativo";

  let state = null;
  /** Modelo de ComfyUI elegido a mano: sobrevive a los repintados. */
  let modeloComfy = "";
  /** Id de modelo de OpenAI o de un servicio compatible; se puede teclear. */
  let modeloOpenai = "";
  /** LoRAs elegidas a mano: `[{ name, weight }]`. */
  let loras = [];
  /** Miniatura del historial abierta a mano; se suelta cuando llega otra `current`. */
  let pin = null;
  /** Último `state.current.file` recibido. */
  let visto = "";
  /** Generación en curso: lo mueven el `state` completo y los mensajes `progress`. */
  let ocupado = false;
  let claveModelos = "";
  let claveLoras = "";
  let claveHistorial = "";
  let claveFuente = "";
  let clavePreview = "";
  /** Los ajustes recordados se siembran una sola vez: después manda lo que haya escrito. */
  let prefsSembradas = false;

  function act(action) {
    vscode.postMessage({ type: "action", action });
  }

  function setText(nodo, valor) {
    const texto = valor == null ? "" : String(valor);
    if (nodo.textContent !== texto) {
      nodo.textContent = texto;
    }
  }

  /** Reescribe solo si cambió y nadie está escribiendo ahí. */
  function setValue(input, valor) {
    const texto = valor == null ? "" : String(valor);
    if (input.value === texto || document.activeElement === input) {
      return;
    }
    input.value = texto;
  }

  /** Número del campo, acotado; vacío o inválido devuelve el defecto. */
  function num(input, defecto, min, max) {
    if (input.value === "") {
      return defecto;
    }
    const valor = Number(input.value);
    if (!Number.isFinite(valor)) {
      return defecto;
    }
    return Math.min(max, Math.max(min, valor));
  }

  /** Semilla de 32 bits sin signo. */
  function semillaAzar() {
    return Math.floor(Math.random() * 4294967296);
  }

  /** Con ALEATORIA marcada el campo se apaga, pero sigue enseñando la última semilla. */
  function pintarSemilla() {
    el.seed.disabled = el.seedRandom.checked;
  }

  /** Entero del campo, acotado; redondea lo tecleado con decimales. */
  function entero(input, defecto, min, max) {
    return Math.round(num(input, defecto, min, max));
  }

  /** Ajustes recordados por el host: pisan solo en el primer `state`. */
  function sembrarPrefs(prefs) {
    if (typeof prefs.model === "string" && prefs.model) {
      modeloComfy = prefs.model;
    }
    if (typeof prefs.openaiModel === "string" && prefs.openaiModel) {
      modeloOpenai = prefs.openaiModel;
      // El campo viaja exista el proveedor que exista: lo enviado después lo devuelve tal cual.
      setValue(el.modelInput, modeloOpenai);
    }
    for (const [input, valor] of [
      [el.width, prefs.width],
      [el.height, prefs.height],
      [el.steps, prefs.steps],
      [el.cfg, prefs.cfg],
      [el.seed, prefs.seed],
    ]) {
      if (Number.isFinite(valor)) {
        input.value = String(valor);
      }
    }
    el.seedRandom.checked = prefs.seedRandom === true;
    pintarSemilla();
  }

  /** Manda el formulario completo: el host guarda qué hay ahora, no lo que llegó antes. */
  function enviarPrefs() {
    act({
      type: "setPrefs",
      prefs: {
        // Si el catálogo aún no ha llegado, no se borra el modelo que ya había.
        model: modeloComfy || (state && state.prefs ? state.prefs.model : ""),
        openaiModel: el.modelInput.value.trim() || (state && state.prefs ? state.prefs.openaiModel : ""),
        width: entero(el.width, 512, 64, 2048),
        height: entero(el.height, 512, 64, 2048),
        steps: entero(el.steps, 20, 1, 150),
        cfg: Math.round(num(el.cfg, 7, 1, 30) * 100) / 100,
        seed: entero(el.seed, 0, 0, 4294967295),
        seedRandom: el.seedRandom.checked,
      },
    });
  }

  /** Modelo con el que se generaría ahora: el de ComfyUI o el texto de OpenAI. */
  function modeloElegido() {
    const comfy = !state || state.provider !== "openai";
    return comfy ? modeloComfy : el.modelInput.value.trim();
  }

  /** Generación en curso: botón apagado y el aviso del host al lado. */
  function setBusy(busy, progress) {
    ocupado = busy === true;
    el.generate.disabled = ocupado;
    setText(el.progress, progress);
  }

  /** «1200 × 800» de una imagen del host. */
  function medidas(imagen) {
    if (!imagen || !imagen.width || !imagen.height) {
      return "";
    }
    return imagen.width + " × " + imagen.height;
  }

  function rellenar(select, valores, vacio) {
    select.textContent = "";
    if (!valores.length) {
      const opcion = document.createElement("option");
      opcion.value = "";
      opcion.textContent = vacio;
      select.appendChild(opcion);
      select.disabled = true;
      return;
    }
    for (const valor of valores) {
      const opcion = document.createElement("option");
      opcion.value = valor;
      opcion.textContent = valor;
      select.appendChild(opcion);
    }
    select.disabled = false;
  }

  // ── LoRAs ──────────────────────────────────────────────
  function pintarLoras() {
    el.loras.textContent = "";
    loras.forEach((lora, indice) => {
      const fila = document.createElement("div");
      fila.className = "gen-lora";

      const nombre = document.createElement("span");
      nombre.className = "gen-lora-name";
      nombre.textContent = lora.name;
      nombre.title = lora.name;

      const peso = document.createElement("input");
      peso.className = "gen-input gen-lora-weight";
      peso.type = "number";
      peso.min = "0";
      peso.max = "2";
      peso.step = "0.05";
      peso.value = String(lora.weight);
      peso.title = "Peso de la LoRA (0 a 2)";
      peso.setAttribute("aria-label", "Peso de " + lora.name);
      peso.addEventListener("input", () => {
        const valor = Number(peso.value);
        if (Number.isFinite(valor)) {
          lora.weight = valor;
        }
      });

      const quitar = document.createElement("button");
      quitar.type = "button";
      quitar.className = "gen-icon-btn";
      quitar.title = "Quitar la LoRA";
      quitar.setAttribute("aria-label", "Quitar la LoRA " + lora.name);
      quitar.innerHTML =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
      quitar.addEventListener("click", () => {
        loras.splice(indice, 1);
        pintarLoras();
      });

      fila.appendChild(nombre);
      fila.appendChild(peso);
      fila.appendChild(quitar);
      el.loras.appendChild(fila);
    });

    const lleno = loras.length >= MAX_LORAS;
    el.loraAdd.disabled = lleno || el.loraPick.disabled || !el.loraPick.value;
    el.loraAdd.title = lleno ? "Máximo de " + MAX_LORAS + " LoRAs" : "Añadir la LoRA elegida";
    el.loraAdd.setAttribute("aria-label", el.loraAdd.title);
  }

  // ── Historial y vista previa ───────────────────────────
  function pintarHistorial(lista) {
    const clave = lista.map((item) => item.file).join("\u0000");
    if (clave === claveHistorial) {
      return;
    }
    claveHistorial = clave;
    el.history.textContent = "";
    if (pin && !lista.some((item) => item.file === pin.file)) {
      pin = null;
    }
    for (const item of lista) {
      // La × va al lado del botón, no dentro: dos botones anidados no son válidos.
      const celda = document.createElement("div");
      celda.className = "gen-hist-cell";
      celda.dataset.file = item.file;

      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "gen-hist-item";
      const tamano = medidas(item);
      boton.title = tamano || item.file;
      boton.setAttribute("aria-label", "Ver " + item.file + (tamano ? ", " + tamano : ""));
      const imagen = document.createElement("img");
      imagen.src = item.url;
      imagen.alt = "";
      boton.appendChild(imagen);
      boton.addEventListener("click", () => {
        pin = { url: item.url, file: item.file, width: item.width, height: item.height };
        pintarActual();
      });

      const borrar = document.createElement("button");
      borrar.type = "button";
      borrar.className = "gen-hist-del";
      borrar.title = "Borrar la imagen";
      borrar.setAttribute("aria-label", "Borrar " + item.file);
      borrar.innerHTML =
        '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
      borrar.addEventListener("click", () => act({ type: "deleteImage", file: item.file }));

      celda.appendChild(boton);
      celda.appendChild(borrar);
      el.history.appendChild(celda);
    }
  }

  function marcarHistorial() {
    const visible = pin ? pin.file : state && state.current ? state.current.file : "";
    for (const celda of el.history.children) {
      const activo = celda.dataset.file === visible;
      celda.classList.toggle("on", activo);
      const boton = celda.firstElementChild;
      if (boton) {
        boton.setAttribute("aria-pressed", activo ? "true" : "false");
      }
    }
  }

  /** Imagen que se enseña: la elegida a mano o la del host. */
  function actual() {
    if (pin) {
      return pin;
    }
    return state && state.current ? state.current : null;
  }

  function pintarActual() {
    const imagen = actual();
    const url = imagen ? imagen.url : "";
    if (url !== clavePreview) {
      clavePreview = url;
      if (url) {
        el.preview.src = url;
      } else {
        el.preview.removeAttribute("src");
      }
    }
    el.preview.hidden = !url;
    el.previewEmpty.hidden = !!url;
    setText(el.previewMeta, medidas(imagen));
    el.save.disabled = !imagen;
    el.copy.disabled = !imagen;
    marcarHistorial();
  }

  // ── Estado completo ────────────────────────────────────
  function render(next) {
    const archivo = next.current ? next.current.file : "";
    if (archivo !== visto) {
      // Llegó otra imagen: la miniatura elegida a mano deja de mandar.
      pin = null;
      visto = archivo;
    }
    state = next;

    if (!prefsSembradas && next.prefs && typeof next.prefs === "object") {
      prefsSembradas = true;
      sembrarPrefs(next.prefs);
    }

    const comfy = next.provider !== "openai";
    el.dot.classList.toggle("on", next.connected === true);

    if (el.provider.value !== next.provider) {
      el.provider.value = next.provider;
    }
    setValue(el.url, comfy ? next.url : next.openaiUrl);
    setValue(el.port, next.port);

    // Con OpenAI o compatible la URL manda y el puerto no pinta nada; el sondeo
    // tampoco: CONECTAR solo valida y guarda.
    el.fieldPort.hidden = !comfy;
    el.fieldKey.hidden = comfy;
    el.url.placeholder = comfy ? "http://127.0.0.1" : "URL base del servicio compatible con OpenAI";
    el.url.title = comfy
      ? "Dirección del servidor de ComfyUI, con http:// o https://"
      : "URL base del servicio compatible con OpenAI";
    el.connect.title = comfy
      ? "Probar la conexión con ComfyUI"
      : "Guardar la URL del servicio compatible con OpenAI";
    el.connect.setAttribute("aria-label", el.connect.title);

    setText(el.status, next.status);
    setText(el.message, next.message);

    // Compartido con los agentes: el check solo confirma lo que dice el host; si lo
    // rechaza, el `state` vuelve con `share:false` y se desmarca solo.
    const compartido = next.share === true;
    el.share.checked = compartido;
    el.shareLabel.classList.toggle("on", compartido);
    setText(el.shareNote, compartido ? "COMPARTIDO" : "");

    // La clave guardada nunca se escribe en el campo: solo se avisa con el punto.
    el.keyDot.classList.toggle("on", next.hasKey === true);
    el.keyDot.title = next.hasKey ? "Clave guardada" : "Sin clave guardada";
    el.key.placeholder = next.hasKey ? "clave guardada" : "clave";

    const modelos = Array.isArray(next.models)
      ? next.models.filter((nombre) => typeof nombre === "string")
      : [];
    if (comfy) {
      const claveM = modelos.join("\u0000");
      if (claveM !== claveModelos) {
        claveModelos = claveM;
        rellenar(el.model, modelos, "Sin modelos");
      }
      if (modelos.length && !modelos.includes(modeloComfy)) {
        modeloComfy = modelos[0];
      }
      if (modelos.length) {
        el.model.value = modeloComfy;
      }
    } else {
      // Abierto a cualquier id: el datalist solo sugiere los oficiales.
      if (!modeloOpenai) {
        modeloOpenai = !modelos.length || modelos.includes("gpt-image-1") ? "gpt-image-1" : modelos[0];
      }
      setValue(el.modelInput, modeloOpenai);
    }
    el.model.hidden = !comfy;
    el.modelRow.hidden = !comfy;
    el.modelReload.hidden = !comfy;
    el.modelInput.hidden = comfy;

    const disponibles = Array.isArray(next.loras)
      ? next.loras.filter((nombre) => typeof nombre === "string")
      : [];
    const claveL = disponibles.join("\u0000");
    if (claveL !== claveLoras) {
      claveLoras = claveL;
      rellenar(el.loraPick, disponibles, "Sin LoRAs");
      pintarLoras();
    }

    el.blockLoras.hidden = !comfy;
    el.blockSource.hidden = !comfy;
    el.blockSeed.hidden = !comfy;
    el.sizeOpenaiHint.hidden = comfy;

    const fuente = next.source;
    const urlFuente = fuente ? fuente.url : "";
    if (urlFuente !== claveFuente) {
      claveFuente = urlFuente;
      if (urlFuente) {
        el.sourceThumb.src = urlFuente;
      } else {
        el.sourceThumb.removeAttribute("src");
      }
    }
    el.sourceWrap.hidden = !urlFuente;

    // Con imagen de partida el tamaño lo pone ella: los campos se apagan. Solo en
    // ComfyUI: OpenAI ignora esa imagen y sí usa el tamaño.
    const tamanoFuente = comfy && !!urlFuente;
    el.width.disabled = tamanoFuente;
    el.height.disabled = tamanoFuente;
    el.sizeHint.hidden = !tamanoFuente;

    el.negative.disabled = !comfy;
    el.negative.placeholder = comfy ? "Lo que no quieres que salga" : HINT_NEGATIVO;

    setBusy(next.busy === true, next.progress);

    pintarHistorial(Array.isArray(next.history) ? next.history : []);
    pintarActual();
  }

  // ── Envíos ─────────────────────────────────────────────
  el.provider.addEventListener("change", () => {
    act({ type: "setProvider", provider: el.provider.value });
  });

  el.connect.addEventListener("click", () => {
    if (state && state.provider === "openai") {
      // Servicio compatible: el host valida y guarda la URL, no hay nada que sondear.
      // Sin esquema el host la descarta en silencio: se completa igual que en ComfyUI.
      const escrito = el.url.value.trim();
      const url = !escrito ? "" : /^https?:\/\//i.test(escrito) ? escrito : "http://" + escrito;
      act({ type: "setOpenAIURL", url });
      return;
    }
    const puerto = Number(el.port.value);
    // El host exige una URL con esquema: un «127.0.0.1» seco se descarta sin aviso.
    const escrito = el.url.value.trim();
    const url = !escrito ? "" : /^https?:\/\//i.test(escrito) ? escrito : "http://" + escrito;
    act({
      type: "setServer",
      url,
      port: Number.isFinite(puerto) && puerto > 0 ? puerto : 8188,
    });
    act({ type: "connect" });
  });

  el.saveKey.addEventListener("click", () => {
    const clave = el.key.value.trim();
    if (!clave) {
      el.key.focus();
      return;
    }
    act({ type: "setKey", key: clave });
    // La clave no se queda en el DOM: el punto verde confirma que se guardó.
    el.key.value = "";
  });

  el.model.addEventListener("change", () => {
    modeloComfy = el.model.value;
    enviarPrefs();
  });

  el.modelReload.addEventListener("click", () => act({ type: "reloadModels" }));

  el.modelInput.addEventListener("input", () => {
    modeloOpenai = el.modelInput.value.trim();
  });

  // El `input` de arriba mantiene el modelo en memoria; `change` es el que persiste.
  el.modelInput.addEventListener("change", enviarPrefs);

  for (const input of [el.width, el.height, el.steps, el.cfg, el.seed]) {
    input.addEventListener("change", enviarPrefs);
  }

  el.seedRandom.addEventListener("change", () => {
    pintarSemilla();
    enviarPrefs();
  });

  el.share.addEventListener("change", () => {
    // GENERAR no depende de esto: solo se avisa al host de que los agentes pueden usar
    // el generador, y con qué modelo se generaría ahora.
    act({ type: "setShare", on: el.share.checked, model: modeloElegido() });
  });

  el.seedBtn.addEventListener("click", () => {
    // El dado sortea y deja el campo listo: suelta ALEATORIA para que se respete.
    el.seed.value = String(semillaAzar());
    el.seedRandom.checked = false;
    pintarSemilla();
    enviarPrefs();
  });

  el.loraPick.addEventListener("change", () => pintarLoras());

  el.loraAdd.addEventListener("click", () => {
    const nombre = el.loraPick.value;
    if (!nombre || loras.length >= MAX_LORAS) {
      return;
    }
    loras.push({ name: nombre, weight: 1 });
    pintarLoras();
  });

  el.sourcePick.addEventListener("click", () => act({ type: "pickSource" }));
  el.sourceClear.addEventListener("click", () => act({ type: "clearSource" }));

  el.generate.addEventListener("click", () => {
    if (!state || ocupado) {
      return;
    }
    const prompt = el.prompt.value.trim();
    if (!prompt) {
      // Sin prompt el host descarta la petición: se señala el campo en vez de no hacer nada.
      el.prompt.focus();
      return;
    }
    const comfy = state.provider !== "openai";
    const elegido = comfy ? modeloComfy : el.modelInput.value.trim();
    if (!elegido) {
      (comfy ? el.model : el.modelInput).focus();
      return;
    }
    // Con ALEATORIA la semilla se sortea en cada GENERAR y queda a la vista.
    let semilla = 0;
    if (comfy) {
      semilla = el.seedRandom.checked
        ? semillaAzar()
        : Math.min(4294967295, Math.max(0, Math.floor(Number(el.seed.value) || 0)));
      el.seed.value = String(semilla);
    }
    act({
      type: "generate",
      prompt,
      negative: el.negative.value,
      model: elegido,
      seed: semilla,
      width: num(el.width, 512, 64, Number.MAX_SAFE_INTEGER),
      height: num(el.height, 512, 64, Number.MAX_SAFE_INTEGER),
      loras: comfy
        ? loras.map((lora) => ({
            name: lora.name,
            weight: Math.min(2, Math.max(0, Number(lora.weight) || 0)),
          }))
        : [],
      denoise: num(el.denoise, 0.6, 0.1, 1),
      steps: entero(el.steps, 20, 1, 150),
      cfg: Math.round(num(el.cfg, 7, 1, 30) * 100) / 100,
    });
  });

  el.save.addEventListener("click", () => {
    const imagen = actual();
    if (imagen) {
      act({ type: "saveAs", file: imagen.file });
    }
  });

  el.copy.addEventListener("click", () => {
    const imagen = actual();
    if (imagen) {
      act({ type: "copy", file: imagen.file });
    }
  });

  el.clearHistory.addEventListener("click", () => act({ type: "clearHistory" }));

  el.folder.addEventListener("click", () => act({ type: "openFolder" }));

  window.addEventListener("message", (event) => {
    const mensaje = event.data;
    if (!mensaje) {
      return;
    }
    if (mensaje.type === "state" && mensaje.state) {
      render(mensaje.state);
      return;
    }
    // Un agente pidió una imagen desde el MCP: los dos campos se rellenan y el `state`
    // que llega detrás trae la imagen y el historial. La webview no manda nada.
    if (mensaje.type === "agentShot") {
      el.prompt.value = String(mensaje.prompt ?? "");
      el.negative.value = String(mensaje.negative ?? "");
      return;
    }
    // Mensaje ligero de una generación en curso: no trae prompts, modelo ni imágenes.
    if (mensaje.type === "progress") {
      setBusy(mensaje.busy === true, mensaje.progress);
    }
  });

  vscode.postMessage({ type: "ready" });
  pintarSemilla();
})();
