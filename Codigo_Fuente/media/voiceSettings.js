/* Pestaña central de ajustes de voz, micrófono y Whisper. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const engineSel = $("engine");
  const voiceSel = $("voice");
  const deviceSel = $("device");
  const rateIn = $("rate");
  const pitchIn = $("pitch");
  const volumeIn = $("volume");

  const sttSel = $("stt-engine");
  const engineHint = $("engine-hint");
  const langSel = $("language");
  const inputSel = $("input-device");
  const gainIn = $("input-gain");
  const gainVal = $("input-gain-val");
  const whisperGroup = $("whisper-group");
  const cloudGroup = $("cloud-group");
  const denoiseBtn = $("denoise");
  const lockBtn = $("lock-floor");
  const lockLabel = $("lock-label");
  const toleranceIn = $("tolerance");
  const toleranceValue = $("tolerance-value");
  const floorEl = $("floor");
  const whisperSel = $("whisper-model");
  const installBtn = $("install-whisper");
  const cloudUrlIn = $("cloud-url");
  const cloudModelIn = $("cloud-model");
  const keyIn = $("key");
  const keyState = $("key-state");
  const noticeEl = $("notice");

  /** Motor de dictado (sapi/whisper/nube): decide qué ajustes aplican. */
  let sttEngine = "sapi";
  let denoise = true;
  let tolerance = 6;
  let inputGain = 100;
  /** Fondo fijado (dBFS); 0 = automático. */
  let floorDb = 0;
  /** Último fondo medido por el dictado, si ya grabó algo. */
  let measured = null;

  function post(msg) {
    vscode.postMessage(msg);
  }

  /** Aviso de un error del host (por ejemplo, fijar el fondo sin medirlo). */
  function showNotice(text) {
    if (!noticeEl) return;
    noticeEl.textContent = text ?? "";
    noticeEl.hidden = !text;
  }

  function updateLabels() {
    $("rate-val").textContent = `${rateIn.value > 0 ? "+" : ""}${rateIn.value}%`;
    $("pitch-val").textContent = `${pitchIn.value > 0 ? "+" : ""}${pitchIn.value}Hz`;
    $("volume-val").textContent = `${volumeIn.value}%`;
  }

  rateIn.addEventListener("input", updateLabels);
  pitchIn.addEventListener("input", updateLabels);
  volumeIn.addEventListener("input", updateLabels);

  // ── Micrófono del dictado: entrada, volumen, filtro y fondo ──
  /** "−42.3 dB" con signo, como se lee en un medidor. */
  const dbText = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;

  function syncNoise() {
    denoiseBtn.classList.toggle("on", denoise);
    denoiseBtn.setAttribute("aria-pressed", String(denoise));
  }

  /** Muestra el fondo que se está usando y si está fijado. */
  function syncFloor() {
    const locked = Boolean(floorDb);
    if (sttEngine === "sapi") floorEl.textContent = "Con SAPI escucha Windows: entrada, volumen y filtro no se usan.";
    else if (locked) floorEl.textContent = `Fondo fijo ${dbText(floorDb)} · abre ${dbText(floorDb + tolerance)}`;
    else if (measured != null) floorEl.textContent = `Fondo ${dbText(measured)} · abre ${dbText(measured + tolerance)}`;
    else floorEl.textContent = "Habla algo para medir el fondo.";

    lockLabel.textContent = locked ? "FIJADO" : "FIJAR";
    lockBtn.classList.toggle("on", locked);
    lockBtn.setAttribute("aria-pressed", String(locked));
    lockBtn.title = locked
      ? "Vuelve a medir el fondo en cada fragmento"
      : "Fija el último fondo medido por el dictado";
  }

  function syncTolerance() {
    toleranceIn.value = String(tolerance);
    toleranceValue.textContent = `+${tolerance} dB`;
  }

  function syncGain() {
    gainIn.value = String(inputGain);
    gainVal.textContent = `${inputGain}%`;
  }

  /** Grupos de Whisper/nube y controles que no aplican con SAPI. */
  function syncDictado() {
    const sapi = sttEngine === "sapi";
    whisperGroup.style.display = sttEngine === "whisper" ? "" : "none";
    cloudGroup.style.display = sttEngine === "nube" ? "" : "none";
    engineHint.textContent = sttSel.selectedOptions[0]?.dataset.hint ?? "";
    inputSel.disabled = sapi;
    gainIn.disabled = sapi;
    denoiseBtn.disabled = sapi;
    lockBtn.disabled = sapi;
    toleranceIn.disabled = sapi;
    denoiseBtn.title = sapi
      ? "Con SAPI ya filtra Windows. Cambia el motor para usar este filtro."
      : "Quita retumbe y siseo del micrófono antes de transcribir";
    syncNoise();
    syncFloor();
  }

  sttSel.addEventListener("change", () => {
    sttEngine = sttSel.value;
    syncDictado();
    post({ type: "setSttEngine", engine: sttEngine });
  });

  langSel.addEventListener("change", () => post({ type: "setLanguage", language: langSel.value }));

  inputSel.addEventListener("change", () => post({ type: "setInputDevice", device: Number(inputSel.value) }));

  gainIn.addEventListener("input", () => {
    inputGain = Number(gainIn.value);
    gainVal.textContent = `${inputGain}%`;
  });
  gainIn.addEventListener("change", () => post({ type: "setInputGain", value: inputGain }));

  denoiseBtn.addEventListener("click", () => {
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

  // El host contesta con un aviso si aún no hay fondo medido que fijar.
  lockBtn.addEventListener("click", () => post({ type: "lockFloor", on: !floorDb }));

  // ── Whisper y nube ─────────────────────────────────────
  whisperSel.addEventListener("change", () => post({ type: "setWhisperModel", model: whisperSel.value }));
  cloudModelIn.addEventListener("change", () => post({ type: "setCloudModel", model: cloudModelIn.value.trim() }));
  cloudUrlIn.addEventListener("change", () => post({ type: "setCloudUrl", url: cloudUrlIn.value.trim() }));
  $("save-key").addEventListener("click", () => {
    post({ type: "saveKey", key: keyIn.value });
    keyIn.value = "";
  });
  installBtn.addEventListener("click", () => {
    installBtn.disabled = true;
    installBtn.textContent = "PREPARANDO…";
    post({ type: "installWhisper" });
  });

  // ── Motor de voz ───────────────────────────────────────
  engineSel.addEventListener("change", () => {
    post({ type: "setEngine", engine: engineSel.value });
    post({ type: "loadVoices", engine: engineSel.value });
  });

  voiceSel.addEventListener("change", () => post({ type: "setVoice", voice: voiceSel.value }));

  deviceSel.addEventListener("change", () => post({ type: "setDevice", device: Number(deviceSel.value) }));

  // Al soltar el deslizador se guarda: así el MCP usa los mismos valores y
  // sobreviven a recargar la ventana.
  rateIn.addEventListener("change", () => post({ type: "setRate", rate: Number(rateIn.value) }));
  pitchIn.addEventListener("change", () => post({ type: "setPitch", pitch: Number(pitchIn.value) }));
  volumeIn.addEventListener("change", () => post({ type: "setVolume", volume: Number(volumeIn.value) }));

  // ── Mensajes desde la extensión ─────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case "init": {
        // Vaciar antes de rellenar: pushInitial puede repetirse al mostrarse
        // la pestaña y duplicaría las opciones.
        engineSel.innerHTML = "";
        deviceSel.innerHTML = "";
        for (const m of msg.motors) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label + (m.available ? "" : " (no disponible)");
          opt.disabled = !m.available;
          engineSel.appendChild(opt);
        }
        if (msg.engine) engineSel.value = msg.engine;

        for (const d of msg.devices) {
          const opt = document.createElement("option");
          opt.value = String(d.index);
          opt.textContent = d.name + (d.isDefault ? " (por defecto)" : "");
          deviceSel.appendChild(opt);
        }
        if (msg.device >= 0) deviceSel.value = String(msg.device);
        // Los deslizadores vienen de los ajustes: si no, tras recargar
        // marcarían 0 mientras el MCP usa el valor guardado.
        for (const [input, value] of [
          [rateIn, msg.rate],
          [pitchIn, msg.pitch],
          [volumeIn, msg.volume],
        ]) {
          if (typeof value === "number") input.value = String(value);
        }
        updateLabels();

        sttEngine = msg.sttEngine ?? "sapi";
        sttSel.innerHTML = "";
        for (const e of msg.engines ?? []) {
          const opt = document.createElement("option");
          opt.value = e.id;
          opt.textContent = e.label;
          opt.dataset.hint = e.hint ?? "";
          sttSel.appendChild(opt);
        }
        sttSel.value = sttEngine;

        langSel.innerHTML = "";
        for (const l of msg.languages ?? []) {
          const opt = document.createElement("option");
          opt.value = l.id;
          opt.textContent = l.label;
          langSel.appendChild(opt);
        }
        langSel.value = msg.language;

        inputSel.innerHTML = "";
        const auto = document.createElement("option");
        auto.value = "-1";
        auto.textContent = "Predeterminado de Windows";
        inputSel.appendChild(auto);
        for (const d of msg.inputDevices ?? []) {
          const opt = document.createElement("option");
          opt.value = String(d.index);
          opt.textContent = d.name;
          inputSel.appendChild(opt);
        }
        inputSel.value = String(msg.inputDevice ?? -1);
        // El micrófono guardado puede no existir en este equipo: cae al del sistema.
        if (!inputSel.value) inputSel.value = "-1";
        inputGain = msg.inputGain ?? 100;
        syncGain();

        denoise = msg.denoise !== false;
        tolerance = msg.tolerance ?? 6;
        floorDb = msg.noiseFloor ?? 0;
        measured = msg.measuredFloor ?? null;
        syncTolerance();
        syncDictado();

        whisperSel.innerHTML = "";
        for (const m of msg.models ?? []) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label;
          whisperSel.appendChild(opt);
        }
        whisperSel.value = msg.whisperModel;
        cloudUrlIn.value = msg.cloudUrl ?? "";
        cloudModelIn.value = msg.cloudModel ?? "";
        keyState.textContent = msg.hasKey ? "guardada ✓" : "";
        installBtn.disabled = false;
        installBtn.textContent = msg.whisperReady ? "LISTO" : "PREPARAR";
        break;
      }

      case "voices": {
        voiceSel.innerHTML = "";
        for (const v of msg.voices) {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = `${v.name} · ${v.locale}`;
          voiceSel.appendChild(opt);
        }
        if (msg.selected) voiceSel.value = msg.selected;
        break;
      }

      case "floorLock":
        showNotice("");
        floorDb = msg.on ? msg.db : 0;
        syncFloor();
        break;

      case "key":
        keyState.textContent = msg.hasKey ? "guardada ✓" : "";
        break;

      case "cloudUrl":
        // El host normaliza la URL (el vacío vuelve al endpoint por defecto).
        showNotice("");
        cloudUrlIn.value = msg.url ?? "";
        break;

      case "inputDevice":
        inputSel.value = String(msg.device ?? -1);
        if (!inputSel.value) inputSel.value = "-1";
        break;

      case "inputGain":
        inputGain = msg.value ?? 100;
        syncGain();
        break;

      case "whisper":
        $("whisper-hint").textContent = msg.message ?? "";
        // `done` cierra la instalación: los avisos intermedios no sueltan el botón.
        if (msg.done) {
          installBtn.disabled = false;
          installBtn.textContent = msg.ready ? "LISTO" : "PREPARAR";
        }
        break;

      case "error":
        showNotice(msg.message ?? "No se pudo guardar el ajuste.");
        break;
    }
  });

  // Avisar a la extensión de que la pestaña ya escucha y puede recibir datos.
  post({ type: "ready" });
})();
