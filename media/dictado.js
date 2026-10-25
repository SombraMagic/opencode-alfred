/* Lógica del panel de dictado: micro, bloc y envío del prompt. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const engineSel = $("engine");
  const langSel = $("language");
  const whisperSel = $("whisper-model");
  const cloudModelIn = $("cloud-model");
  const keyIn = $("key");
  const keyState = $("key-state");
  const micBtn = $("mic");
  const hfBtn = $("hands-free");
  const noiseBtn = $("denoise");
  const toleranceIn = $("tolerance");
  const toleranceValue = $("tolerance-value");
  const floorEl = $("floor");
  const lockBtn = $("lock-floor");
  const lockLabel = $("lock-label");
  const stateEl = $("state");
  const hintEl = $("state-hint");
  const levelBar = $("level-bar");
  const nota = $("nota");
  const count = $("count");
  const engineHint = $("engine-hint");
  const installBtn = $("install-whisper");

  let listening = false;
  let handsFree = false;
  let engine = "sapi";
  let denoise = true;
  let tolerance = 6;
  /** Fondo fijado (dBFS); 0 = automático. */
  let floorDb = 0;
  /** Último fondo medido, para poder mostrarlo y fijarlo. */
  let measured;
  let hint = "0";

  const STATE_TEXT = {
    idle: "EN ESPERA",
    listening: "ESCUCHANDO",
    working: "TRANSCRIBIENDO",
    error: "ERROR",
  };

  function post(msg) {
    vscode.postMessage(msg);
  }

  function setState(state, message) {
    stateEl.textContent = STATE_TEXT[state] ?? state.toUpperCase();
    stateEl.className = "state" + (state === "idle" ? "" : " " + state);
    if (message) hintEl.textContent = message;
  }

  function updateCount() {
    const raw = nota.innerText;
    const text = raw.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const images = nota.querySelectorAll("[data-path]").length;
    const files = nota.querySelectorAll("[data-file]").length;
    count.textContent =
      `${words} palabras · ${raw.length} caracteres` +
      (images ? ` · ${images} imagen(es)` : "") +
      (files ? ` · ${files} fichero(s)` : "");
  }

  /** Inserta el texto dictado en el cursor, sin pegar la frase anterior. */
  function insert(text) {
    const clean = text.trim();
    if (!clean) return;
    nota.focus();
    const sel = window.getSelection();
    if (!sel) return;
    let range;
    if (sel.rangeCount && nota.contains(sel.anchorNode) && nota.contains(sel.focusNode)) {
      range = sel.getRangeAt(0);
    } else {
      range = document.createRange();
      range.selectNodeContents(nota);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // Texto anterior al cursor: decide la mayúscula inicial y el espacio de separación.
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(nota);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const before = beforeRange.toString();
    const sep = before && !/\s$/.test(before) ? " " : "";
    // SAPI devuelve todo en minúsculas: se pone mayúscula al empezar frase.
    const cap = !before.trim() || /[.!?]\s*$/.test(before) ? clean[0].toUpperCase() + clean.slice(1) : clean;
    // Inserción por Range: execCommand falla con el webview oculto.
    range.deleteContents();
    const nodo = document.createTextNode(sep + cap + (/\s$/.test(cap) ? "" : " "));
    range.insertNode(nodo);
    range.setStartAfter(nodo);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    nota.scrollTop = nota.scrollHeight;
    updateCount();
    saveNoteSoon();
  }

  // ── Micrófono: pulsar y mantener ─────────────────────────
  /** El aro late también durante manos libres. */
  function syncMic() {
    micBtn.classList.toggle("listening", listening || handsFree);
  }

  function press() {
    if (listening || handsFree) return;
    listening = true;
    syncMic();
    setState("listening", engine === "sapi" ? "Habla ahora" : "Grabando…");
    post({ type: "start" });
  }

  function release() {
    if (!listening) return;
    listening = false;
    syncMic();
    post({ type: "stop" });
    if (engine !== "sapi") setState("working", "Transcribiendo…");
    else setState("idle", "Procesando…");
  }

  micBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // Los eventos sintéticos no tienen puntero activo: capturarlo fallaría.
    try {
      micBtn.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: el pointerup seguirá llegando al botón */
    }
    press();
  });
  micBtn.addEventListener("pointerup", release);
  micBtn.addEventListener("pointercancel", release);
  micBtn.addEventListener("pointerleave", release);
  // Teclado: mantener Espacio o Enter también dicta.
  micBtn.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) press();
    }
  });
  micBtn.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      release();
    }
  });

  // ── Manos libres: un clic escucha, otro clic para ───────
  function setHandsFree(on) {
    handsFree = on;
    hfBtn.classList.toggle("on", on);
    hfBtn.setAttribute("aria-checked", String(on));
    syncMic();
    if (on) {
      setState("listening", engine === "sapi" ? "Habla y haz pausas" : "Grabando por turnos…");
    } else if (!listening) {
      setState("idle", "Manos libres desactivado.");
    }
  }

  hfBtn.addEventListener("click", () => {
    setHandsFree(!handsFree);
    post({ type: "handsFree", on: handsFree });
  });

  // ── Filtro de ruido: interruptor, tolerancia y fondo ────
  function syncNoise() {
    noiseBtn.classList.toggle("on", denoise);
    noiseBtn.setAttribute("aria-pressed", String(denoise));
  }

  /** "−42.3 dB" con signo, como se lee en un medidor. */
  const dbText = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;

  /** Muestra el fondo que se está usando y si está fijado. */
  function syncFloor() {
    const locked = Boolean(floorDb);
    if (engine === "sapi") floorEl.textContent = "Con SAPI ya filtra Windows.";
    else if (locked) floorEl.textContent = `Fondo fijo ${dbText(floorDb)} · abre ${dbText(floorDb + tolerance)}`;
    else if (measured != null) floorEl.textContent = `Fondo ${dbText(measured)} · abre ${dbText(measured + tolerance)}`;
    else floorEl.textContent = "Habla algo para medir el fondo.";

    lockLabel.textContent = locked ? "FIJADO" : "FIJAR";
    lockBtn.classList.toggle("on", locked);
    lockBtn.setAttribute("aria-pressed", String(locked));
    // Sin una medida no hay nada que fijar: se avisa, no se deja pulsar.
    lockBtn.disabled = engine === "sapi" || (!locked && measured == null);
    lockBtn.title = locked
      ? "Vuelve a medir el fondo en cada fragmento"
      : measured == null
        ? "Primero habla algo: se fija el último fondo medido"
        : `Fija el fondo en ${dbText(measured)} y deja de ajustarlo solo`;
  }

  function syncTolerance() {
    toleranceIn.value = String(tolerance);
    toleranceValue.textContent = `+${tolerance} dB`;
  }

  noiseBtn.addEventListener("click", () => {
    denoise = !denoise;
    syncNoise();
    post({ type: "setDenoise", on: denoise });
  });

  toleranceIn.addEventListener("input", () => {
    tolerance = Number(toleranceIn.value);
    toleranceValue.textContent = `+${tolerance} dB`;
    syncFloor();
  });
  toleranceIn.addEventListener("change", () => post({ type: "setTolerance", db: tolerance }));

  // El estado lo confirma la extensión: si aún no hay medida, no fija nada.
  lockBtn.addEventListener("click", () => post({ type: "lockFloor", on: !floorDb }));

  // ── Configuración ────────────────────────────────────────
  const configCol = $("config");
  const configToggle = $("config-toggle");

  /** Pinta la columna plegada o desplegada sin avisar a la extensión. */
  function syncConfig(collapsed) {
    configCol.classList.toggle("collapsed", collapsed);
    configToggle.setAttribute("aria-expanded", String(!collapsed));
    configToggle.title = collapsed ? "Desplegar configuración" : "Plegar configuración";
  }

  configToggle.addEventListener("click", () => {
    const collapsed = !configCol.classList.contains("collapsed");
    syncConfig(collapsed);
    post({ type: "saveConfigCollapsed", collapsed });
  });

  function syncRows() {
    const isWhisper = engine === "whisper";
    const isCloud = engine === "nube";
    $("whisper-row").style.display = isWhisper ? "" : "none";
    installBtn.style.display = isWhisper ? "" : "none";
    $("cloud-row").style.display = isCloud ? "" : "none";
    $("key-row").style.display = isCloud ? "" : "none";
    $("save-key").style.display = isCloud ? "" : "none";
    // Con SAPI escucha Windows y ya filtra él: el interruptor se ve, pero no aplica.
    noiseBtn.disabled = engine === "sapi";
    toleranceIn.disabled = engine === "sapi";
    noiseBtn.title =
      engine === "sapi"
        ? "Con SAPI ya filtra Windows. Cambia a Whisper o Nube para usar este filtro."
        : "Quita retumbe y siseo del micrófono antes de transcribir";
    engineHint.textContent = $("engine").selectedOptions[0]?.dataset.hint ?? "";
    syncFloor();
  }

  engineSel.addEventListener("change", () => {
    if (handsFree) {
      setHandsFree(false);
      post({ type: "handsFree", on: false });
    }
    engine = engineSel.value;
    syncRows();
    post({ type: "setEngine", engine });
  });
  langSel.addEventListener("change", () => post({ type: "setLanguage", language: langSel.value }));
  whisperSel.addEventListener("change", () => post({ type: "setWhisperModel", model: whisperSel.value }));
  cloudModelIn.addEventListener("change", () => post({ type: "setCloudModel", model: cloudModelIn.value.trim() }));
  $("save-key").addEventListener("click", () => {
    post({ type: "saveKey", key: keyIn.value });
    keyIn.value = "";
  });
  installBtn.addEventListener("click", () => post({ type: "installWhisper" }));

  // ── Bloc y envío ────────────────────────────────────────
  /** Carpeta de adjuntos que manda la extensión en `init`. */
  let attachmentsDir = "";

  /** Texto del bloc con los tokens `[[img:ruta]]` y `[[file:ruta]]` donde va cada adjunto. */
  function serialize() {
    let text = "";
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue;
        else if (child.nodeName === "BR") {
          // Chrome deja un <br> de relleno al final: no es un salto real.
          if (child !== nota.lastChild) text += "\n";
        } else if (child.nodeName === "DIV" || child.nodeName === "P") {
          // Chromium guarda cada línea pegada en un <div>: sin esto se funden.
          if (text && !text.endsWith("\n")) text += "\n";
          walk(child);
        } else if (child.dataset?.path) text += `[[img:${encodeURIComponent(child.dataset.path)}]]`;
        else if (child.dataset?.file) text += `[[file:${encodeURIComponent(child.dataset.file)}]]`;
        else walk(child);
      }
    };
    walk(nota);
    return text;
  }

  /** El token va escapado para que una ruta con `]` no rompa el separador. */
  function decodePath(token) {
    try {
      return decodeURIComponent(token);
    } catch {
      return token;
    }
  }

  /** Miniatura ya cargada; el clic la abre en un editor. */
  function imageChip(path, src) {
    const img = document.createElement("img");
    img.className = "chip-img";
    img.dataset.path = path;
    img.src = src;
    img.title = path;
    img.alt = "Imagen adjunta";
    // Un solo borrado se lleva el chip entero, como si fuera un carácter.
    img.contentEditable = "false";
    return img;
  }

  /** Chip provisional: la imagen aún se está cargando o falta el fichero. */
  function missingChip(path) {
    const span = document.createElement("span");
    span.className = "chip-missing";
    span.dataset.path = path;
    span.textContent = "imagen";
    // Un solo borrado se lleva el chip entero, como si fuera un carácter.
    span.contentEditable = "false";
    return span;
  }

  /** Solo el nombre visible: la ruta completa no se interpola nunca en HTML. */
  function baseName(path) {
    return String(path).split(/[\\/]/).pop() || String(path);
  }

  /** Chip de un fichero arrastrado; la ruta viaja en `data-file`. */
  function fileChip(path) {
    const span = document.createElement("span");
    span.className = "chip-file";
    span.dataset.file = path;
    span.title = path;
    // Un solo borrado se lleva el chip entero, como si fuera un carácter.
    span.contentEditable = "false";
    // SVG estático: aquí no entra nada que venga del fichero.
    span.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">' +
      '<path d="M6 2.5h7l5 5v14H6z" fill="none" stroke="currentColor" stroke-width="1.6" />' +
      '<path d="M13 2.5v5h5" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>';
    const name = document.createElement("span");
    name.className = "chip-file-name";
    name.textContent = baseName(path);
    span.appendChild(name);
    return span;
  }

  /** Restaura el bloc guardado: texto y tokens `[[img:ruta]]` / `[[file:ruta]]`. */
  function setNote(texto) {
    nota.textContent = "";
    // El tipo viaja como grupo: split devuelve [texto, tipo, ruta, texto, ...].
    const parts = String(texto ?? "").split(/\[\[(img|file):([^\]]+)\]\]/);
    const paths = [];
    for (let i = 0; i < parts.length; i += 3) {
      if (parts[i]) nota.appendChild(document.createTextNode(parts[i]));
      const kind = parts[i + 1];
      if (!kind) continue;
      const path = decodePath(parts[i + 2]);
      if (kind === "file") {
        nota.appendChild(fileChip(path));
      } else {
        nota.appendChild(missingChip(path));
        paths.push(path);
      }
    }
    // La extensión acepta como mucho 8 rutas por petición.
    for (let i = 0; i < paths.length; i += 8) {
      post({ type: "loadImages", paths: paths.slice(i, i + 8) });
    }
    updateCount();
  }

  /** Inserta un nodo en el cursor (o al final si el foco está fuera del bloc). */
  function insertNodeAtCaret(node) {
    const sel = window.getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    // Solo si la selección entera cae dentro del bloc: no borrar nada fuera.
    if (!range || !nota.contains(range.startContainer) || !nota.contains(range.endContainer)) {
      nota.appendChild(node);
      return;
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Lee un fichero como data URL. */
  function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el fichero."));
      reader.readAsDataURL(blob);
    });
  }

  /** Los formatos que el agente no lee se reescalan y se pasan a PNG. */
  async function toPng(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === "function") bitmap.close();
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("No se pudo convertir la imagen.");
    return png;
  }

  /** Nombre acordado con la extensión: img-<base36>-<4 chars>.<ext>. */
  function imageName(ext) {
    return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  }

  const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

  /** Pega imágenes del portapapeles; el resto, como texto plano. */
  nota.addEventListener("paste", async (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const files = [...data.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile());
    if (!files.length) {
      // Nada de HTML: solo el texto, tal cual.
      e.preventDefault();
      const text = data.getData("text/plain");
      if (text) document.execCommand("insertText", false, text);
      return;
    }
    e.preventDefault();
    if (!attachmentsDir) {
      setState("error", "El panel aún no está listo para adjuntar.");
      return;
    }
    const sep = attachmentsDir.includes("\\") ? "\\" : "/";
    for (const file of files) {
      if (!file) continue;
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("La imagen supera los 20 MiB.");
        const blob = IMAGE_TYPES[file.type] ? file : await toPng(file);
        const ext = IMAGE_TYPES[file.type] ?? "png";
        const dataUrl = await readDataUrl(blob);
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const name = imageName(ext);
        const path = attachmentsDir + sep + name;
        insertNodeAtCaret(imageChip(path, dataUrl));
        post({ type: "attach", name, data: base64 });
        updateCount();
        saveNoteSoon();
      } catch (err) {
        setState("error", err instanceof Error ? err.message : "No se pudo adjuntar la imagen.");
      }
    }
    nota.focus();
  });

  // ── Arrastrar ficheros al bloc ──────────────────────────
  /** Rutas de un `text/uri-list` (así llega un arrastre desde el Explorador de VS Code). */
  function pathsFromUriList(list) {
    const out = [];
    for (const line of String(list ?? "").split(/\r?\n/)) {
      const uri = line.trim();
      if (!uri || uri.startsWith("#") || !/^file:/i.test(uri)) continue;
      const raw = decodePath(uri.replace(/^file:\/\//i, ""));
      if (/^\/[a-zA-Z]:/.test(raw)) out.push(raw.slice(1)); // file:///C:/… → C:/…
      else if (raw.startsWith("/")) out.push(raw);          // file:///home/… → /home/…
      else out.push("//" + raw);                            // file://host/… → //host/…
    }
    return out;
  }

  /** Nombre acordado con la extensión: file-<base36>-<4 chars>-<stem>.<ext>. */
  function fileName(original) {
    const name = String(original ?? "");
    const dot = name.lastIndexOf(".");
    const ext = (dot > 0 ? name.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
    const stem = name
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30);
    return `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${stem || "adjunto"}.${ext}`;
  }

  function afterFiles(n) {
    updateCount();
    saveNoteSoon();
    setState("idle", `${n} fichero(s) adjunto(s).`);
  }

  function addFileChip(path) {
    insertNodeAtCaret(fileChip(path));
    insertNodeAtCaret(document.createTextNode(" "));
  }

  // Un <img> soltado tal cual quedaría sin data-path, invisible para serialize().
  nota.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    nota.classList.add("dragging");
  });
  nota.addEventListener("dragleave", (e) => {
    // Solo al salir de verdad del bloc, no al pasar de un hijo a otro.
    if (!nota.contains(e.relatedTarget)) nota.classList.remove("dragging");
  });
  nota.addEventListener("drop", async (e) => {
    e.preventDefault();
    nota.classList.remove("dragging");
    const dt = e.dataTransfer;
    if (!dt) return;

    const paths = pathsFromUriList(dt.getData("text/uri-list"));
    if (paths.length) {
      for (const path of paths) addFileChip(path);
      afterFiles(paths.length);
      return;
    }

    const files = Array.from(dt.files ?? []);
    if (!files.length) return;
    if (!attachmentsDir) {
      setState("error", "El panel aún no está listo para adjuntar.");
      return;
    }
    const sep = attachmentsDir.includes("\\") ? "\\" : "/";
    let n = 0;
    for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("El fichero supera los 20 MiB.");
        const dataUrl = await readDataUrl(file);
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        const name = fileName(file.name);
        addFileChip(attachmentsDir + sep + name);
        post({ type: "attach", name, data: base64 });
        n++;
      } catch (err) {
        setState("error", err instanceof Error ? err.message : "No se pudo adjuntar el fichero.");
      }
    }
    if (n) afterFiles(n);
  });

  // Enter nativo crearía <div>: se usa <br>, que el serializador entiende.
  nota.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
    }
  });

  // Un clic en una miniatura (o en un chip sin fichero) abre su ruta.
  nota.addEventListener("click", (e) => {
    const chip = e.target instanceof Element ? e.target.closest("[data-path]") : null;
    if (chip && nota.contains(chip)) post({ type: "openAttachment", path: chip.dataset.path });
  });

  /** Se guarda solo: al cerrar el panel o VS Code vuelve tal cual. */
  let noteTimer;
  /** Hay tecleo sin guardar: el init repetido no debe pisarlo. */
  let notePendiente = false;
  function saveNote() {
    clearTimeout(noteTimer);
    noteTimer = undefined;
    notePendiente = false;
    post({ type: "saveNote", text: serialize() });
  }
  function saveNoteSoon() {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 250);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveNote();
  });
  window.addEventListener("blur", saveNote);

  nota.addEventListener("input", () => {
    notePendiente = true;
    updateCount();
    saveNoteSoon();
  });
  $("clear").addEventListener("click", () => {
    nota.textContent = "";
    updateCount();
    saveNoteSoon();
    nota.focus();
  });

  /** Texto que viaja al terminal: cada token se vuelve la ruta entrecomillada. */
  function promptText() {
    return serialize()
      .replace(/\[\[img:([^\]]+)\]\]/g, (_match, path) => `[imagen: "${decodePath(path)}"]`)
      .replace(/\[\[file:([^\]]+)\]\]/g, (_match, path) => `[fichero: "${decodePath(path)}"]`)
      .replace(/\s*\r?\n+\s*/g, " ");
  }

  $("send").addEventListener("click", () => post({ type: "sendPrompt", text: promptText() }));

  // ── Mensajes de la extensión ────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case "init": {
        engine = msg.engine;
        engineSel.innerHTML = "";
        for (const e of msg.engines ?? []) {
          const opt = document.createElement("option");
          opt.value = e.id;
          opt.textContent = e.label;
          opt.dataset.hint = e.hint ?? "";
          engineSel.appendChild(opt);
        }
        engineSel.value = msg.engine;

        langSel.innerHTML = "";
        for (const l of msg.languages ?? []) {
          const opt = document.createElement("option");
          opt.value = l.id;
          opt.textContent = l.label;
          langSel.appendChild(opt);
        }
        langSel.value = msg.language;

        whisperSel.innerHTML = "";
        for (const m of msg.models ?? []) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label;
          whisperSel.appendChild(opt);
        }
        whisperSel.value = msg.whisperModel;

        cloudModelIn.value = msg.cloudModel ?? "";
        denoise = msg.denoise !== false;
        tolerance = msg.tolerance ?? 6;
        floorDb = msg.noiseFloor ?? 0;
        syncNoise();
        syncTolerance();
        syncFloor();
        // El bloc se recupera al reabrir el panel o VS Code. `pushInitial` se
        // repite al volver a ser visible: no pisar lo escrito desde el último guardado.
        attachmentsDir = String(msg.attachmentsDir ?? "");
        if (msg.note != null && !notePendiente && msg.note !== serialize()) setNote(msg.note);
        keyState.textContent = msg.hasKey ? "guardada ✓" : "";
        installBtn.textContent = msg.whisperReady ? "LISTO" : "PREPARAR";
        syncRows();
        syncConfig(Boolean(msg.configCollapsed));
        setState("idle", "Mantén el micrófono, o activa MANOS LIBRES");
        break;
      }
      case "state":
        setState(msg.state === "idle" && (listening || handsFree) ? "listening" : msg.state, msg.message);
        break;
      case "text":
        insert(msg.text);
        break;
      case "handsFree":
        setHandsFree(Boolean(msg.on));
        break;
      case "level":
        levelBar.style.width = `${Math.min(100, Math.round((msg.value ?? 0) * 100))}%`;
        break;
      case "engine":
        engine = msg.engine;
        break;
      case "key":
        keyState.textContent = msg.hasKey ? "guardada ✓" : "";
        break;
      case "floor":
        measured = msg.db;
        syncFloor();
        break;
      case "floorLock":
        floorDb = msg.on ? msg.db : 0;
        syncFloor();
        break;
      case "images": {
        for (const chip of nota.querySelectorAll("[data-path]")) {
          const src = msg.images?.[chip.dataset.path];
          if (src) chip.replaceWith(imageChip(chip.dataset.path, src));
        }
        updateCount();
        break;
      }
      case "attachmentError": {
        const name = String(msg.name ?? "");
        if (name) {
          for (const chip of nota.querySelectorAll("[data-path], [data-file]")) {
            const path = chip.dataset.path || chip.dataset.file;
            if (path && path.endsWith(name)) chip.remove();
          }
        }
        updateCount();
        saveNoteSoon();
        setState("error", msg.message || "No se pudo guardar el adjunto.");
        break;
      }
      case "whisperReady":
        installBtn.textContent = msg.ready ? "LISTO" : "PREPARAR";
        break;
    }
  });

  updateCount();
  post({ type: "ready" });
})();
