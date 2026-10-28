/**
 * Ecualizador de barras pixeladas del panel de voz.
 * Canvas de resolución fija (128×56) escalado por CSS con píxeles duros, como
 * los medidores de las tarjetas de agentes. En reposo pinta un solo fotograma
 * y no deja ningún requestAnimationFrame vivo: CPU cero.
 */
(function () {
  const COLS = 32;
  const ROWS = 14;
  const CELL = 4;
  const W = COLS * CELL;
  const H = ROWS * CELL;
  /** Cadencia: la voz va a 20 fps, la onda de agentes a 8 y la caída a 20. */
  const VOZ_MS = 50;
  const ONDA_MS = 125;
  const CAIDA_MS = 250;

  const canvas = document.getElementById("equalizer");
  const ctx = canvas.getContext("2d");

  /** Niveles actuales, objetivo y forma de la locución (0..1 por banda). */
  const levels = new Float32Array(COLS);
  const target = new Float32Array(COLS);
  const shape = new Float32Array(COLS);
  /** Altura del pico de cada columna (0..1): aguanta y después cae. */
  const peaks = new Float32Array(COLS);

  let accent = "#00e5ff";
  let peakColor = "#ff2d95";

  /** Id del rAF pendiente (0 = ninguno). */
  let raf = 0;
  let frames = 0;
  /** Modo del bucle: reposo, onda de agentes, voz o caída final. */
  let mode = "standby";
  let last = 0;
  let startedAt = 0;
  let durationMs = 0;
  let energy = [];
  let fallUntil = 0;
  let actCount = 0;
  let actStreaming = false;

  function readPalette() {
    const style = getComputedStyle(document.body);
    accent = style.getPropertyValue("--neon").trim() || "#00e5ff";
    peakColor = style.getPropertyValue("--magenta").trim() || "#ff2d95";
  }

  function start() {
    readPalette();
    // last a 0 fuerza el primer fotograma sin esperar a la cadencia.
    last = 0;
    if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
  }

  /** Energía de la voz en el instante actual, interpolada de la serie temporal. */
  function currentGain(now) {
    if (!energy.length || durationMs <= 0) return 1;
    const t = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
    const pos = t * (energy.length - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    const a = energy[i] ?? 0;
    const b = energy[Math.min(i + 1, energy.length - 1)] ?? 0;
    return a + (b - a) * f;
  }

  /** Los picos suben con la barra, aguantan un fotograma de cada tres y caen. */
  function updatePeaks() {
    const decay = frames % 3 === 0;
    for (let i = 0; i < COLS; i++) {
      const h = levels[i];
      if (h >= peaks[i]) peaks[i] = h;
      else if (decay) peaks[i] = Math.max(h, peaks[i] - 0.05);
    }
  }

  function advance(now) {
    if (mode === "voice") {
      // Sin duración no hay aviso de fin: se corta igualmente pasado un margen
      // para no dejar el bucle eterno a 20 fps.
      const fin = durationMs > 0 ? durationMs : 15000;
      if (now - startedAt > fin + 300) {
        fallUntil = now + CAIDA_MS;
        mode = "fall";
      } else {
        const gain = currentGain(now);
        for (let i = 0; i < COLS; i++) {
          target[i] = shape[i] * gain;
          levels[i] += (target[i] - levels[i]) * 0.18;
        }
      }
    }

    if (mode === "wave") {
      // Onda que recorre las columnas mientras hay agentes trabajando.
      const t = now * 0.001;
      const amp = 0.16 + Math.min(0.24, actCount * 0.04);
      const speed = actStreaming ? 2.6 : 1.6;
      for (let i = 0; i < COLS; i++) {
        target[i] = amp * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * speed + i * 0.55)));
        levels[i] += (target[i] - levels[i]) * 0.25;
      }
    }

    if (mode === "fall") {
      for (let i = 0; i < COLS; i++) levels[i] *= 0.6;
      if (now >= fallUntil) {
        levels.fill(0);
        peaks.fill(0);
        // Si los agentes siguen en marcha, el ecualizador vuelve a la onda.
        mode = actCount > 0 ? "wave" : "standby";
        return;
      }
    }

    updatePeaks();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    if (mode === "standby") {
      // Reposo: solo la fila de abajo, tenue. Es el único fotograma que se pinta.
      // Se relee la paleta aquí (una vez por reposo) para seguir un cambio de tema.
      readPalette();
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.5;
      for (let x = 0; x < COLS; x++) ctx.fillRect(x * CELL + 1, (ROWS - 1) * CELL + 1, CELL - 2, CELL - 2);
      ctx.globalAlpha = 1;
      return;
    }

    // Cuerpo de las barras: crecen de abajo arriba, con el alfa por tramos.
    ctx.fillStyle = accent;
    for (let x = 0; x < COLS; x++) {
      const rows = Math.min(ROWS, Math.round(levels[x] * ROWS));
      for (let r = 0; r < rows; r++) {
        if (r === rows - 1) ctx.globalAlpha = 1;
        else ctx.globalAlpha = r < rows * 0.45 ? 0.22 : r < rows * 0.8 ? 0.4 : 0.65;
        ctx.fillRect(x * CELL + 1, (ROWS - 1 - r) * CELL + 1, CELL - 2, CELL - 2);
      }
    }

    // Pico: una celda por columna, por encima de la barra.
    ctx.fillStyle = peakColor;
    ctx.globalAlpha = 1;
    for (let x = 0; x < COLS; x++) {
      if (peaks[x] <= 0.04) continue;
      const row = Math.min(ROWS - 1, Math.max(0, ROWS - 1 - Math.round(peaks[x] * ROWS)));
      const top = ROWS - Math.min(ROWS, Math.round(levels[x] * ROWS));
      if (row >= top) continue;
      ctx.fillRect(x * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
    }
    ctx.globalAlpha = 1;
  }

  function tick(now) {
    raf = 0;
    // Con la vista oculta no se programa nada; visibilitychange reanuda.
    if (document.hidden) return;
    if (now - last < (mode === "wave" ? ONDA_MS : VOZ_MS)) {
      raf = requestAnimationFrame(tick);
      return;
    }
    last = now;
    frames++;
    advance(now);
    draw();
    if (mode !== "standby") raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // ── API del ecualizador ────────────────────────────────
  // panel.js lo llama directamente. No se usa window.postMessage como bus
  // interno: en el webview de VS Code ese canal no entrega a la misma página.
  window.VOZEqualizer = {
    envelope(msg) {
      const values = msg?.values ?? [];
      for (let i = 0; i < COLS; i++) {
        const v = Number(values[i]);
        shape[i] = v > 0 ? Math.min(1, v) : 0;
      }
      energy = msg?.energy ?? [];
      durationMs = msg?.durationMs ?? 0;
      // ageMs permite arrancar a mitad cuando la voz ya lleva sonando
      // (el aviso del MCP llega con un pequeño retraso).
      startedAt = performance.now() - (msg?.ageMs ?? 0);
      mode = "voice";
      start();
    },
    idle() {
      // Caída de ~250 ms y después el fotograma de reposo, sin bucle.
      fallUntil = performance.now() + CAIDA_MS;
      mode = "fall";
      start();
    },
    /**
     * Actividad de los agentes: `{count, streaming}`. Se llama en cada sondeo,
     * así que sin cambios no toca nada.
     */
    activity(act) {
      const count = act?.count ?? 0;
      const streaming = Boolean(act?.streaming);
      if (count === actCount && streaming === actStreaming) return;
      actCount = count;
      actStreaming = streaming;
      // La voz manda: la onda espera a que acabe.
      if (mode === "voice" || mode === "fall") return;
      if (count > 0) {
        mode = "wave";
        start();
      } else if (mode === "wave") {
        stopLoop();
        levels.fill(0);
        peaks.fill(0);
        mode = "standby";
        readPalette();
        draw();
      }
    },
    /** Estado interno, para las comprobaciones automáticas. */
    stats() {
      return { mode, frames, active: mode === "voice", columns: COLS };
    },
  };

  // Los mensajes de la extensión también llegan aquí; se enrutan a la API.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "envelope") window.VOZEqualizer.envelope(msg);
    else if (msg?.type === "idle" || msg?.type === "stop") window.VOZEqualizer.idle();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopLoop();
    } else if (mode !== "standby") {
      start();
    } else {
      draw();
    }
  });

  // Estado inicial: un fotograma de reposo y ningún temporizador.
  readPalette();
  draw();
})();
