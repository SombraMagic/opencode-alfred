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
    const text = nota.value.trim();
    const words = text ? text.split(/\s+/).length : 0;
    count.textContent = `${words} palabras · ${nota.value.length} caracteres`;
  }

  /** Inserta el texto dictado en el cursor, sin pegar la frase anterior. */
  function insert(text) {
    const clean = text.trim();
    if (!clean) return;
    const start = nota.selectionStart ?? nota.value.length;
    const end = nota.selectionEnd ?? start;
    const before = nota.value.slice(0, start);
    const sep = before && !/\s$/.test(before) ? " " : "";
    // SAPI devuelve todo en minúsculas: se pone mayúscula al empezar frase.
    const cap = !before.trim() || /[.!?]\s*$/.test(before) ? clean[0].toUpperCase() + clean.slice(1) : clean;
    nota.setRangeText(sep + cap, start, end, "end");
    if (!/\s$/.test(nota.value)) nota.setRangeText(" ", nota.selectionStart, nota.selectionEnd, "end");
    nota.focus();
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
    hfBtn.setAttribute("aria-pressed", String(on));
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
  /** Se guarda solo: al cerrar el panel o VS Code vuelve tal cual. */
  let noteTimer;
  function saveNote() {
    clearTimeout(noteTimer);
    noteTimer = undefined;
    post({ type: "saveNote", text: nota.value });
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
    updateCount();
    saveNoteSoon();
  });
  $("clear").addEventListener("click", () => {
    nota.value = "";
    updateCount();
    saveNoteSoon();
    nota.focus();
  });
  $("send").addEventListener("click", () => post({ type: "sendPrompt", text: nota.value }));

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
        // El bloc se recupera al reabrir el panel o VS Code.
        if (msg.note != null && msg.note !== nota.value) {
          nota.value = String(msg.note);
          updateCount();
        }
        keyState.textContent = msg.hasKey ? "guardada ✓" : "";
        installBtn.textContent = msg.whisperReady ? "LISTO" : "PREPARAR";
        syncRows();
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
      case "whisperReady":
        installBtn.textContent = msg.ready ? "LISTO" : "PREPARAR";
        break;
    }
  });

  updateCount();
  post({ type: "ready" });
})();
