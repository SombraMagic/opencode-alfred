/* Lógica del panel: comunica con la extensión y refleja el estado. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const engineSel = $("engine");
  const voiceSel = $("voice");
  const deviceSel = $("device");
  const rateIn = $("rate");
  const pitchIn = $("pitch");
  const volumeIn = $("volume");
  const textIn = $("text");
  const speakBtn = $("speak");
  const statusEl = $("status");
  const timeEl = $("readout-time");
  const engineOut = $("readout-engine");
  const voiceOut = $("readout-voice");

  let speaking = false;
  /** Agentes trabajando, tal como llegaron en el último mensaje `agents`. */
  let agents = [];
  /** Último estado pedido por la voz; la cabecera puede sustituirlo. */
  let baseStatus = { text: "EN LÍNEA", kind: "" };

  // Si no hay voz pero sí agentes, la cabecera manda el número en vuelo.
  function paintStatus() {
    const flight = agents.length > 0 && baseStatus.text === "EN LÍNEA";
    statusEl.textContent = flight ? `${agents.length} EN VUELO` : baseStatus.text;
    const kind = flight ? "busy" : baseStatus.kind;
    statusEl.className = "hud-status" + (kind ? " " + kind : "");
  }

  function setStatus(text, kind) {
    baseStatus = { text, kind };
    paintStatus();
  }

  function updateLabels() {
    $("rate-val").textContent = `${rateIn.value > 0 ? "+" : ""}${rateIn.value}%`;
    $("pitch-val").textContent = `${pitchIn.value > 0 ? "+" : ""}${pitchIn.value}Hz`;
    $("volume-val").textContent = `${volumeIn.value}%`;
  }

  rateIn.addEventListener("input", updateLabels);
  pitchIn.addEventListener("input", updateLabels);
  volumeIn.addEventListener("input", updateLabels);
  updateLabels();

  // ── Peticiones a la extensión ───────────────────────────
  function post(msg) {
    vscode.postMessage(msg);
  }

  engineSel.addEventListener("change", () => {
    engineOut.textContent = engineSel.options[engineSel.selectedIndex]?.text ?? "—";
    post({ type: "setEngine", engine: engineSel.value });
    post({ type: "loadVoices", engine: engineSel.value });
  });

  voiceSel.addEventListener("change", () => {
    voiceOut.textContent = voiceSel.options[voiceSel.selectedIndex]?.text ?? "—";
    post({ type: "setVoice", voice: voiceSel.value });
  });

  deviceSel.addEventListener("change", () => {
    post({ type: "setDevice", device: Number(deviceSel.value) });
  });

  // Al soltar el deslizador se guarda: así el MCP usa los mismos valores y
  // sobreviven a recargar la ventana.
  rateIn.addEventListener("change", () => post({ type: "setRate", rate: Number(rateIn.value) }));
  pitchIn.addEventListener("change", () => post({ type: "setPitch", pitch: Number(pitchIn.value) }));
  volumeIn.addEventListener("change", () => post({ type: "setVolume", volume: Number(volumeIn.value) }));

  speakBtn.addEventListener("click", async () => {
    const texto = textIn.value.trim();
    if (!texto) {
      setStatus("SIN TEXTO", "error");
      textIn.focus();
      return;
    }
    if (speaking) return;

    speaking = true;
    speakBtn.disabled = true;
    $("speak-label").textContent = "REPRODUCIENDO…";
    setStatus("SINTETIZANDO", "busy");

    post({
      type: "speak",
      text: texto,
      engine: engineSel.value,
      rate: Number(rateIn.value),
      pitch: Number(pitchIn.value),
      volume: Number(volumeIn.value),
      device: Number(deviceSel.value),
    });
  });

  const mcpToggle = $("mcp-toggle");
  mcpToggle.addEventListener("click", () => {
    // Mientras el host instala o apaga no se puede volver a pulsar.
    mcpToggle.disabled = true;
    $("mcp-hint").textContent = "instalando…";
    post({ type: "toggleMcp" });
  });

  // ── Agentes en vuelo ───────────────────────────────────
  // Una tarjeta por agente con un display de píxeles que simula la estela del
  // proceso. Se diffa por nombre: recrear los canvas en cada aviso los
  // reiniciaría y perderían la estela.
  const agentsEl = $("agents");
  const cards = new Map();
  const COLS = 24;
  const ROWS = 7;
  const CELL = 4;
  const W = COLS * CELL;
  const H = ROWS * CELL;
  let raf = 0;
  let frames = 0;
  let accent = "#00e5ff";

  /** Paleta de Claude: coincide con los puntos de media/claudeAgent.css. */
  const PALETTE = {
    red: "#e05a5a",
    blue: "#4a9eff",
    green: "#3fb950",
    yellow: "#d4a72c",
    purple: "#a371f7",
    orange: "#f0883e",
    pink: "#f778ba",
    cyan: "#39c5cf",
  };

  /** Color de los píxeles: hex tal cual, nombre de la paleta de Claude o "" → acento. */
  function resolveColor(value) {
    if (typeof value !== "string") return "";
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    const name = value.toLowerCase();
    // hasOwn: un "constructor" o "__proto__" no debe colar como color.
    return Object.hasOwn(PALETTE, name) ? PALETTE[name] : "";
  }

  function makeCard(agent) {
    const el = document.createElement("div");
    el.className = "agent" + (agent.streaming ? " streaming" : "");
    const label = document.createElement("span");
    label.className = "agent-name";
    label.textContent = agent.name;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.className = "agent-meter";
    el.append(label, canvas);
    // El nombre se tiñe con el mismo color que los píxeles; sin color, manda el tema.
    if (agent.color) el.style.setProperty("--agent-color", agent.color);
    // `cols` guarda la historia por columnas (x * ROWS + y) y se pinta como píxeles.
    return {
      el,
      ctx: canvas.getContext("2d"),
      cols: new Uint8Array(COLS * ROWS),
      next: 0,
      streaming: agent.streaming,
      color: agent.color,
    };
  }

  /** Acento del tema actual, para teñir los píxeles. */
  function readAccent() {
    accent = getComputedStyle(document.body).getPropertyValue("--neon").trim() || "#00e5ff";
  }

  function drawCard(card) {
    const { ctx, cols } = card;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = card.color || accent;
    for (let x = 0; x < COLS; x++) {
      // La estela se apaga hacia la izquierda: la columna nueva entra a la derecha.
      const fade = 0.08 + 0.92 * (x / (COLS - 1));
      for (let y = 0; y < ROWS; y++) {
        const v = cols[x * ROWS + y];
        if (!v) continue;
        ctx.globalAlpha = Math.min(1, fade * (0.2 + v * 0.22) * (card.streaming ? 1.15 : 0.85));
        ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Avanza la estela una columna; devuelve si tocaba repintar. */
  function advance(card, now) {
    if (now < card.next) return false;
    card.next = now + (card.streaming ? 55 : 110);
    card.cols.copyWithin(0, ROWS);
    const energy = card.streaming ? 0.9 : 0.5;
    const head = (COLS - 1) * ROWS;
    for (let y = 0; y < ROWS; y++) {
      // Más densidad en el centro: parece un proceso, no ruido.
      const center = 1 - Math.abs(y - (ROWS - 1) / 2) / ROWS;
      const hit = Math.random() < energy * (0.25 + center * 0.75);
      card.cols[head + y] = hit ? 1 + ((Math.random() * 3) | 0) : 0;
    }
    return true;
  }

  function step(now) {
    raf = 0;
    if (!cards.size || document.hidden) return;
    // El tema puede cambiar con las tarjetas puestas: se relee el acento de vez en cuando.
    if (++frames % 30 === 0) readAccent();
    for (const card of cards.values()) if (advance(card, now)) drawCard(card);
    raf = requestAnimationFrame(step);
  }

  function ensureLoop() {
    if (!raf && cards.size && !document.hidden) {
      readAccent();
      raf = requestAnimationFrame(step);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else {
      ensureLoop();
    }
  });

  function renderAgents(list) {
    // Deduplicado por nombre: dos avisos del mismo agente son una tarjeta.
    agents = [
      ...new Map(
        (Array.isArray(list) ? list : [])
          .filter((a) => a && a.name)
          .map((a) => [
            a.name,
            { name: a.name, streaming: Boolean(a.streaming), color: resolveColor(a.color) },
          ]),
      ).values(),
    ];
    const alive = new Set(agents.map((a) => a.name));

    for (const [name, card] of cards) {
      if (alive.has(name)) continue;
      cards.delete(name);
      card.el.classList.add("leaving");
      setTimeout(() => card.el.remove(), 160);
    }

    for (const agent of agents) {
      const card = cards.get(agent.name);
      if (!card) {
        const fresh = makeCard(agent);
        cards.set(agent.name, fresh);
        agentsEl.appendChild(fresh.el);
        continue;
      }
      // Solo se toca el DOM si cambió el ritmo: cada tick es igual al anterior.
      const streaming = Boolean(agent.streaming);
      if (card.streaming !== streaming) {
        card.streaming = streaming;
        card.el.classList.toggle("streaming", streaming);
      }
      // Color nuevo (por ejemplo al editar el `color:` del .md): el siguiente
      // tick ya lo pinta; si no hay bucle porque la vista está oculta, se repinta aquí.
      if (card.color !== agent.color) {
        card.color = agent.color;
        if (agent.color) card.el.style.setProperty("--agent-color", agent.color);
        else card.el.style.removeProperty("--agent-color");
        if (!raf && !document.hidden) drawCard(card);
      }
    }

    // Recolocar sin recrear: insertBefore solo mueve lo que está fuera de sitio.
    // Las tarjetas que se están despidiendo no cuentan como referencia.
    let ref = agentsEl.firstChild;
    const skipLeaving = () => {
      while (ref && ref.classList.contains("leaving")) ref = ref.nextSibling;
    };
    skipLeaving();
    for (const agent of agents) {
      const el = cards.get(agent.name).el;
      if (el === ref) ref = ref.nextSibling;
      else agentsEl.insertBefore(el, ref);
      skipLeaving();
    }

    paintStatus();
    // Gancho que lee equalizer.js: la onda recorre las barras aunque no haya voz.
    window.alfredActivity = {
      count: agents.length,
      streaming: agents.some((a) => a.streaming),
    };
    window.VOZEqualizer?.activity(window.alfredActivity);
    ensureLoop();
  }

  // ── Mensajes desde la extensión ─────────────────────────
  /** Cuenta atrás del tiempo restante; avisa al llegar a cero. */
  function startCountdown(total) {
    const started = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const left = Math.max(0, total - (Date.now() - started));
      const s = Math.floor(left / 1000);
      timeEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      if (left <= 0) {
        clearInterval(timer);
        if (!speaking) {
          setStatus("EN LÍNEA");
          timeEl.textContent = "00:00";
        }
      }
    }, 200);
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case "init": {
        // Vaciar antes de rellenar: pushInitial puede repetirse al mostrar
        // la vista y duplicaría las opciones.
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
        engineOut.textContent = engineSel.options[engineSel.selectedIndex]?.text ?? "—";

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
        voiceOut.textContent = voiceSel.options[voiceSel.selectedIndex]?.text ?? "—";
        break;
      }

      case "agents":
        renderAgents(msg.agents);
        break;

      case "envelope":
        // Llamada directa al ecualizador (equalizer.js).
        window.VOZEqualizer?.envelope(msg);
        break;

      case "speaking":
        // Cuenta atrás del tiempo de reproducción.
        startCountdown(msg.durationMs || 0);
        break;

      case "playback":
        // Reproducción pedida por el agente (MCP): misma animación, pero sin
        // tocar el botón, que no ha sido quien la lanzó.
        window.VOZEqualizer?.envelope({
          values: msg.values,
          energy: msg.energy,
          durationMs: msg.durationMs,
          ageMs: msg.ageMs,
        });
        // Lo que ha dicho queda escrito: TRANSCRIBIR repite la última frase.
        if (msg.text) textIn.value = msg.text;
        setStatus("MCP", "busy");
        startCountdown(Math.max(0, (msg.durationMs || 0) - (msg.ageMs || 0)));
        break;

      case "done":
        speaking = false;
        speakBtn.disabled = false;
        $("speak-label").textContent = "TRANSCRIBIR";
        setStatus("EN LÍNEA");
        window.VOZEqualizer?.idle();
        timeEl.textContent = "00:00";
        break;

      case "error":
        speaking = false;
        speakBtn.disabled = false;
        $("speak-label").textContent = "TRANSCRIBIR";
        setStatus("ERROR", "error");
        window.VOZEqualizer?.idle();
        break;

      case "mcp": {
        const list = Array.isArray(msg.agents) ? msg.agents : [];
        const dot = $("mcp-dot");
        dot.className = "mcp-dot " + (msg.enabled ? "on" : "off");
        mcpToggle.disabled = false;
        // Un aviso del host (error de instalación) manda sobre el estado.
        $("mcp-hint").textContent =
          msg.message ||
          (msg.enabled
            ? "activado · " + list.join(" · ")
            : list.length
              ? "desactivado"
              : "sin agente");
        break;
      }
    }
  });

  let timer;

  // Avisar a la extensión de que el panel ya escucha y puede recibir datos.
  post({ type: "ready" });
})();
