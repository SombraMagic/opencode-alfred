/* Lógica del panel: comunica con la extensión y refleja el estado. */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const textIn = $("text");
  const speakBtn = $("speak");
  const statusEl = $("status");

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

  // ── Peticiones a la extensión ───────────────────────────
  function post(msg) {
    vscode.postMessage(msg);
  }

  // La rueda dentada abre la pestaña central con todos los ajustes.
  $("btn-config").addEventListener("click", () => post({ type: "openSettings" }));

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

    post({ type: "speak", text: texto });
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

  /**
   * Iconos de las actividades del sistema (imagen, dictado, Ollama). Son
   * constantes de este fichero: del host solo llega el nombre, nunca el SVG.
   */
  const ICONS = {
    imagen:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<rect x="3" y="5" width="18" height="14" rx="2"/>' +
      '<circle cx="8.5" cy="10" r="1.5"/>' +
      '<path d="M4 17l5-5 4 4 3-3 4 4"/>' +
      "</svg>",
    dictado:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<rect x="9" y="3" width="6" height="11" rx="3"/>' +
      '<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/>' +
      '<path d="M12 18v3"/>' +
      '<path d="M9 21h6"/>' +
      "</svg>",
    ollama:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<rect x="6" y="6" width="12" height="12" rx="2"/>' +
      '<path d="M9.5 9.5h5v5h-5z"/>' +
      '<path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>' +
      "</svg>",
  };

  /** Icono válido del contrato; cualquier otra cosa se ignora. */
  function resolveIcon(value) {
    return typeof value === "string" && Object.hasOwn(ICONS, value) ? value : "";
  }

  /** Envoltura del icono; el SVG entra después (siempre desde ICONS). */
  function iconSpan(icon) {
    const span = document.createElement("span");
    span.className = "agent-icon";
    span.innerHTML = ICONS[icon];
    return span;
  }

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
    // Actividad del sistema (imagen, dictado, Ollama): tarjeta aparte, con icono.
    if (agent.icon) {
      el.classList.add("extra");
      el.insertBefore(iconSpan(agent.icon), label);
    }
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
      icon: agent.icon,
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
            {
              name: a.name,
              streaming: Boolean(a.streaming),
              color: resolveColor(a.color),
              icon: resolveIcon(a.icon),
            },
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
      // Icono nuevo o que desaparece: se cambia en su sitio, sin recrear la tarjeta
      // (recrear reiniciaría el canvas y la estela).
      if (card.icon !== agent.icon) {
        card.icon = agent.icon;
        card.el.classList.toggle("extra", Boolean(agent.icon));
        const span = card.el.querySelector(".agent-icon");
        if (agent.icon) {
          if (span) span.innerHTML = ICONS[agent.icon];
          else card.el.insertBefore(iconSpan(agent.icon), card.el.firstChild);
        } else if (span) {
          span.remove();
        }
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

  // ── Monitor del equipo (CPU, RAM, GPU, VRAM) ────────────
  // Llega una muestra cada 2 s: se guarda una firma de lo ya pintado para no
  // tocar el DOM cuando no cambió nada.
  const SM_STALE_MS = 15000;
  let smSignature = "";
  // La temperatura de CPU necesita permisos: mientras no haya lectura, el propio
  // dato es el botón que los pide. `smBusy` mantiene los puntos suspensivos
  // mientras el host eleva el proceso, y `smCpuPending` guarda lo que tocaría pintar.
  let smBusy = false;
  let smCpuPending = "—";

  const smCpu = {
    cell: $("sm-cpu-temp").closest(".sysmon-cell"),
    value: $("sm-cpu-temp"),
    load: $("sm-cpu-load"),
    fill: $("sm-cpu-bar").firstElementChild,
  };
  const smRam = {
    cell: $("sm-ram-total").closest(".sysmon-cell"),
    value: $("sm-ram-total"),
    load: $("sm-ram-load"),
    fill: $("sm-ram-bar").firstElementChild,
  };
  const smGpu = {
    cell: $("sm-gpu-temp").closest(".sysmon-cell"),
    value: $("sm-gpu-temp"),
    load: $("sm-gpu-load"),
    fill: $("sm-gpu-bar").firstElementChild,
  };
  // La celda de VRAM comparte el `title` con la de GPU: el nombre es uno solo.
  const smVram = {
    cell: $("sm-vram-total").closest(".sysmon-cell"),
    value: $("sm-vram-total"),
    load: $("sm-vram-load"),
    fill: $("sm-vram-bar").firstElementChild,
  };

  /** Número usable o null: el helper puede mandar huecos por campo. */
  const smNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  /** Temperatura: "52°". */
  function smTemp(v) {
    const n = smNum(v);
    return n == null ? "—" : Math.round(n) + "°";
  }

  /** Carga: "23%". */
  function smLoad(v) {
    const n = smNum(v);
    return n == null ? "—" : Math.max(0, Math.min(100, Math.round(n))) + "%";
  }

  /** Bytes en GB con coma decimal: "32 GB", "7,8 GB". */
  function smGb(v) {
    const n = smNum(v);
    if (n == null || n <= 0) return "—";
    const gb = n / 1073741824;
    return (gb < 10 ? gb.toFixed(1).replace(".", ",") : String(Math.round(gb))) + " GB";
  }

  /** Escribe el valor; el guion es estado apagado, no un valor normal. */
  function smWrite(el, text) {
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("off", text === "—");
  }

  /** Porcentaje de un par usado/total; sin total no hay barra. */
  function smRatio(used, total) {
    const u = smNum(used);
    const t = smNum(total);
    return u == null || !t ? null : (u / t) * 100;
  }

  /** Carga, ancho de la barra y estado apagado de una celda. */
  function smPaintLoad(cell, loadText) {
    smWrite(cell.load, loadText);
    const pct = loadText === "—" ? 0 : parseFloat(loadText);
    const width = pct + "%";
    if (cell.fill.style.width !== width) cell.fill.style.width = width;
    cell.cell.classList.toggle("off", loadText === "—");
  }

  /** Pinta una celda: valor, carga, ancho de la barra y estado apagado. */
  function smPaintCell(cell, value, loadText) {
    smWrite(cell.value, value);
    smPaintLoad(cell, loadText);
  }

  /** `title` del modelo de GPU en las dos celdas que lo comparten. */
  function smPaintTitle(name) {
    const text = typeof name === "string" ? name.trim() : "";
    for (const cell of [smGpu.cell, smVram.cell]) {
      if (text) {
        if (cell.title !== text) cell.title = text;
      } else if (cell.hasAttribute("title")) {
        cell.removeAttribute("title");
      }
    }
  }

  /**
   * Temperatura de CPU en un solo sitio: valor, guion apagado y afordancia de
   * botón. Solo el "—" se puede pulsar; con un número no se ofrece nada.
   */
  function smPaintCpuTemp(text) {
    if (smCpu.value.textContent !== text) smCpu.value.textContent = text;
    smCpu.value.classList.toggle("off", text === "—");
    const pedir = text === "—";
    smCpu.value.classList.toggle("can-pedir", pedir);
    if (pedir) {
      smCpu.value.title = "Pedir permisos para leer la temperatura de la CPU";
      smCpu.value.setAttribute("role", "button");
      smCpu.value.setAttribute("tabindex", "0");
      smCpu.value.removeAttribute("aria-disabled");
    } else {
      if (smCpu.value.hasAttribute("title")) smCpu.value.removeAttribute("title");
      smCpu.value.removeAttribute("role");
      smCpu.value.removeAttribute("tabindex");
      smCpu.value.removeAttribute("aria-disabled");
    }
  }

  /** Pide los permisos; con "…" o con valor numérico el gesto no hace nada. */
  function smPedirTemp() {
    if (smBusy || !smCpu.value.classList.contains("can-pedir")) return;
    post({ type: "sysmonElevate" });
  }

  // Un solo oyente, enlazado al cargar: el campo se repinta, pero no se reengancha.
  smCpu.value.addEventListener("click", smPedirTemp);
  smCpu.value.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    smPedirTemp();
  });
  // El HTML nace con el "—" y sin muestra no habría afordancia: se sincroniza una vez.
  smPaintCpuTemp(smCpuPending);

  /** Pinta el monitor; sin muestra fresca queda todo en guiones. */
  function paintSysmon(data) {
    const at = smNum(data?.at);
    const fresh = at != null && Date.now() - at <= SM_STALE_MS ? data : null;
    const cpu = fresh?.cpu ?? {};
    const ram = fresh?.ram ?? {};
    const gpu = fresh?.gpu ?? {};

    const cpuTemp = smTemp(cpu.temp);
    const cpuLoad = fresh ? smLoad(cpu.load) : "—";
    const ramTotal = fresh ? smGb(ram.total) : "—";
    const ramLoad = fresh ? smLoad(smRatio(ram.used, ram.total)) : "—";
    const gpuTemp = smTemp(gpu.temp);
    const gpuLoad = fresh ? smLoad(gpu.load) : "—";
    const vramTotal = fresh ? smGb(gpu.vramTotal) : "—";
    const vramLoad = fresh ? smLoad(smRatio(gpu.vramUsed, gpu.vramTotal)) : "—";
    const gpuName = typeof gpu.name === "string" ? gpu.name.trim() : "";

    // Lo que tocaría pintar en la temperatura de CPU: con el UAC abierto el
    // campo sigue en "…" y solo se guarda el valor pendiente.
    smCpuPending = cpuTemp;

    // El `at` cambia siempre: la firma va con lo que se ve.
    const signature = [cpuTemp, cpuLoad, ramTotal, ramLoad, gpuTemp, gpuLoad, vramTotal, vramLoad, gpuName].join("|");
    if (signature === smSignature) return;
    smSignature = signature;

    if (!smBusy) smPaintCpuTemp(cpuTemp);
    smPaintLoad(smCpu, cpuLoad);
    smPaintCell(smRam, ramTotal, ramLoad);
    smPaintCell(smGpu, gpuTemp, gpuLoad);
    smPaintCell(smVram, vramTotal, vramLoad);
    smPaintTitle(gpuName);
  }

  // ── Mensajes desde la extensión ─────────────────────────
  /**
   * Reproducción pedida por el MCP: el panel no la lanzó, así que el estado
   * vuelve a EN LÍNEA al acabar. Sin la línea de lectura no hay reloj que pintar.
   */
  let mcpTimer = 0;
  function markMcpPlayback(ms) {
    clearTimeout(mcpTimer);
    mcpTimer = setTimeout(() => {
      if (!speaking) setStatus("EN LÍNEA");
    }, Math.max(0, ms));
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg?.type) {
      case "agents":
        renderAgents(msg.agents);
        break;

      case "sysmon":
        paintSysmon(msg.data);
        break;

      case "sysmonBusy":
        // Pidiendo permisos: "…" en el dato y sin afordancia, que no se pida dos
        // veces. Al acabar se repinta lo último que tocaba (— o la temperatura).
        smBusy = msg.on === true;
        smPaintCpuTemp(smBusy ? "…" : smCpuPending);
        break;

      case "envelope":
        // Llamada directa al ecualizador (equalizer.js).
        window.VOZEqualizer?.envelope(msg);
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
        markMcpPlayback((msg.durationMs || 0) - (msg.ageMs || 0));
        break;

      case "done":
        speaking = false;
        speakBtn.disabled = false;
        $("speak-label").textContent = "TRANSCRIBIR";
        setStatus("EN LÍNEA");
        window.VOZEqualizer?.idle();
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

  // Avisar a la extensión de que el panel ya escucha y puede recibir datos.
  post({ type: "ready" });
})();
