/* Lógica del panel de dictado: micro, bloc y envío del prompt. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const micBtn = $("mic");
  const hfBtn = $("hands-free");
  const stateEl = $("state");
  const hintEl = $("state-hint");
  const levelBar = $("level-bar");
  const nota = $("nota");
  const count = $("count");

  let listening = false;
  let handsFree = false;
  /** Motor de dictado: solo elige el texto de estado al pulsar el micro. */
  let engine = "sapi";

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

  let releaseWatchdog = null;
  let workingWatchdog = null;
  let noticeTimer = null;

  function clearNotice() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    hintEl.classList.remove("warn");
    hintEl.classList.remove("voice");
  }

  function showNotice(state, message) {
    clearNotice();
    setState(state, message);
    hintEl.classList.add("warn");
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      hintEl.classList.remove("warn");
      if (handsFree) {
        setState("listening", engine === "sapi" ? "Habla y haz pausas" : "Grabando por turnos…");
      } else {
        setState("idle", "Pulsar / Manos libres");
      }
    }, 4000);
  }

  function clearReleaseWatchdog() {
    if (releaseWatchdog) {
      clearTimeout(releaseWatchdog);
      releaseWatchdog = null;
    }
  }

  function startReleaseWatchdog() {
    clearReleaseWatchdog();
    releaseWatchdog = setTimeout(() => {
      releaseWatchdog = null;
      showNotice("idle", "El dictado no respondió. Prueba de nuevo.");
    }, 4000);
  }

  function clearWorkingWatchdog() {
    if (workingWatchdog) {
      clearTimeout(workingWatchdog);
      workingWatchdog = null;
    }
  }

  function resetWorkingWatchdog() {
    clearWorkingWatchdog();
    workingWatchdog = setTimeout(() => {
      workingWatchdog = null;
      showNotice("idle", "La transcripción tarda demasiado.");
    }, 120000);
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
    // El micro manda: con MANOS LIBRES puesto, lo apaga en vez de dictar encima.
    if (handsFree) {
      setHandsFree(false);
      post({ type: "handsFree", on: false });
      return;
    }
    if (listening) return;
    clearReleaseWatchdog();
    clearNotice();
    listening = true;
    syncMic();
    setState("listening", engine === "sapi" ? "Habla ahora" : "Grabando…");
    post({ type: "start" });
  }

  function release() {
    if (!listening) return;
    listening = false;
    syncMic();
    clearNotice();
    post({ type: "stop" });
    setState("idle", "Procesando…");
    startReleaseWatchdog();
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
  micBtn.addEventListener("pointerleave", (e) => {
    if (e.pointerId != null && typeof micBtn.hasPointerCapture === "function" && micBtn.hasPointerCapture(e.pointerId)) {
      return;
    }
    release();
  });
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

  window.addEventListener("blur", () => {
    if (listening) release();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && listening) release();
  });

  // ── Manos libres: un clic escucha, otro clic para ───────
  function setHandsFree(on) {
    handsFree = on;
    hfBtn.classList.toggle("on", on);
    hfBtn.setAttribute("aria-checked", String(on));
    syncMic();
    clearReleaseWatchdog();
    clearWorkingWatchdog();
    clearNotice();
    if (on) {
      setState("listening", engine === "sapi" ? "Habla y haz pausas" : "Grabando por turnos…");
    } else if (!listening) {
      showNotice("idle", "Manos libres desactivado.");
    }
  }

  hfBtn.addEventListener("click", () => {
    setHandsFree(!handsFree);
    post({ type: "handsFree", on: handsFree });
  });

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
        // Los <span> del resaltado (media/mdEditor.js) solo envuelven texto: se baja.
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
    // CRLF guardado con el pegando antiguo: se normaliza al restaurar.
    const parts = String(texto ?? "").replace(/\r\n?/g, "\n").split(/\[\[(img|file):([^\]]+)\]\]/);
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

  /** Inserta texto pegado en el cursor; execCommand("insertText") no es fiable en el webview. */
  function insertPlainText(text) {
    // Windows pega con CRLF y `pre-wrap` pinta el CR y el LF por separado: línea doble.
    insertNodeAtCaret(document.createTextNode(String(text).replace(/\r\n?/g, "\n")));
    updateCount();
    saveNoteSoon();
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
      if (text) insertPlainText(text);
      else {
        // Portapapeles que no pueblan getData: se le pide al item de cadena.
        const item = [...data.items].find((i) => i.kind === "string");
        if (item) item.getAsString((s) => s && insertPlainText(s));
      }
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

  // VS Code solo entrega un arrastre de ficheros con Mayús pulsada: se escucha en
  // toda la sección para que valga cualquier punto del bloc, el pie incluido.
  // Sin preventDefault en dragover, un <img> soltado se quedaría sin data-path.
  const noteCol = nota.closest(".note");
  noteCol.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    noteCol.classList.add("dragging");
  });
  noteCol.addEventListener("dragleave", (e) => {
    // Solo al salir de verdad del bloc, no al pasar de un hijo a otro.
    if (!noteCol.contains(e.relatedTarget)) noteCol.classList.remove("dragging");
  });
  noteCol.addEventListener("drop", async (e) => {
    e.preventDefault();
    noteCol.classList.remove("dragging");
    const dt = e.dataTransfer;
    if (!dt) return;

    const paths = pathsFromUriList(dt.getData("text/uri-list"));
    if (paths.length) {
      for (const path of paths) addFileChip(path);
      afterFiles(paths.length);
      return;
    }

    const files = Array.from(dt.files ?? []);
    if (!files.length) {
      // Arrastre de texto: no es un adjunto y no se avisa.
      if (dt.types.includes("text/plain")) return;
      setState("idle", "Suelta el fichero con Mayús, o pulsa ADJUNTAR.");
      return;
    }
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
  // Soltar exige Mayús: el diálogo nativo es la vía que siempre funciona.
  $("attach").addEventListener("click", () => post({ type: "pickFiles" }));
  $("idea").addEventListener("click", () => post({ type: "idea" }));
  $("abrir-pizarra").addEventListener("click", () => post({ type: "pizarra" }));
  $("subir-pizarra").addEventListener("click", () => post({ type: "subirPizarra" }));

  /** Texto que viaja al terminal: cada token se vuelve la ruta entrecomillada. Los saltos de línea viajan reales. */
  function promptText() {
    return serialize()
      .replace(/\[\[img:([^\]]+)\]\]/g, (_match, path) => `[imagen: "${decodePath(path)}"]`)
      .replace(/\[\[file:([^\]]+)\]\]/g, (_match, path) => `[fichero: "${decodePath(path)}"]`);
  }

  $("send").addEventListener("click", () => post({ type: "sendPrompt", text: promptText() }));
  $("copiar").addEventListener("click", () => post({ type: "copyPrompt", text: promptText() }));

  // ── Mensajes de la extensión ────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case "init": {
        engine = msg.engine;
        // El bloc se recupera al reabrir el panel o VS Code. `pushInitial` se
        // repite al volver a ser visible: no pisar lo escrito desde el último guardado.
        attachmentsDir = String(msg.attachmentsDir ?? "");
        if (msg.note != null && !notePendiente && msg.note !== serialize()) setNote(msg.note);
        clearReleaseWatchdog();
        clearWorkingWatchdog();
        clearNotice();
        setState("idle", "Pulsar / Manos libres");
        break;
      }
      case "state": {
        clearReleaseWatchdog();
        const nextState = msg.state;
        const message = msg.message;

        if (nextState === "working") {
          clearNotice();
          listening = false;
          syncMic();
          resetWorkingWatchdog();
          setState("working", message || "Transcribiendo…");
          break;
        }

        clearWorkingWatchdog();

        if (nextState === "listening") {
          clearNotice();
          listening = true;
          syncMic();
          setState("listening", message || (engine === "sapi" ? "Habla ahora" : "Grabando…"));
          break;
        }

        if (nextState === "error") {
          listening = false;
          syncMic();
          showNotice("error", message || "Error en dictado.");
          break;
        }

        if (nextState === "idle") {
          listening = false;
          syncMic();
          if (message) {
            showNotice("idle", message);
          } else {
            clearNotice();
            if (handsFree) {
              setState("listening", engine === "sapi" ? "Habla y haz pausas" : "Grabando por turnos…");
            } else {
              setState("idle", "Pulsar / Manos libres");
            }
          }
          break;
        }

        setState(nextState, message);
        break;
      }
      case "text":
        clearReleaseWatchdog();
        if (workingWatchdog) resetWorkingWatchdog();
        insert(msg.text);
        break;
      case "handsFree":
        setHandsFree(Boolean(msg.on));
        break;
      case "level": {
        levelBar.style.width = `${Math.min(100, Math.round((msg.value ?? 0) * 100))}%`;
        if (handsFree && typeof msg.voice === "boolean" && !noticeTimer) {
          hintEl.textContent = msg.voice ? "Voz detectada…" : "Escuchando…";
          hintEl.classList.toggle("voice", msg.voice);
        }
        break;
      }
      case "engine":
        engine = msg.engine;
        break;
      case "images": {
        for (const chip of nota.querySelectorAll("[data-path]")) {
          const src = msg.images?.[chip.dataset.path];
          if (src) chip.replaceWith(imageChip(chip.dataset.path, src));
        }
        updateCount();
        break;
      }
      case "pizarraImage": {
        // La extensión ya escribió el PNG: aquí solo se pinta el chip, como al pegar.
        // Sin path o src no hay nada que insertar (el host avisa por su lado).
        if (!msg.path || !msg.src) break;
        insertNodeAtCaret(imageChip(String(msg.path), String(msg.src)));
        updateCount();
        saveNoteSoon();
        break;
      }
      case "files": {
        // Rutas elegidas en el diálogo nativo: se adjuntan tal cual, sin copiarlas.
        const paths = Array.isArray(msg.paths) ? msg.paths : [];
        if (!paths.length) break;
        for (const path of paths) addFileChip(String(path));
        afterFiles(paths.length);
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
        showNotice("error", msg.message || "No se pudo guardar el adjunto.");
        break;
      }
    }
  });

  updateCount();
  // El bloc colorea el Markdown con spans inline; el texto plano que serializa
  // y las rutas de los chips salen igual (solo se sustituyen nodos de texto).
  window.MdEditor?.attachEditable(nota);
  post({ type: "ready" });
})();
