/**
 * Ecualizador de barras pixeladas del panel de voz.
 * Canvas de resolución fija (128×72) escalado por CSS con píxeles duros, como
 * los medidores de las tarjetas de agentes. Fuego plano, sin degradados. En
 * reposo pinta un solo fotograma y no deja ningún requestAnimationFrame vivo:
 * CPU cero.
 */
(function () {
  const COLS = 32;
  const ROWS = 18;
  const CELL = 4;
  const W = COLS * CELL;
  const H = ROWS * CELL;
  /** Cadencia: la voz a 30 fps; la onda a la mitad, que así se mueve más suave. */
  const VOZ_MS = 33;
  const ONDA_MS = 66;
  /** Tope de la caída: a 0,9 por fotograma el nivel tarda más de 0,9 s en bajar
      de 0,01, y esta marca es la que fija el final real. */
  const CAIDA_MS = 900;

  /** Paleta de fuego, de la base a la punta. La celda superior va en blanco. */
  const FIRE = ["#e03000", "#ff6a00", "#ffa000", "#ffd166"];
  const TIP = "#fff3c4";

  /** Ventana de centro (las barras nacen en el medio y mueren en los bordes) y
      temblor fijo por columna. Se calculan una sola vez al cargar. */
  const wind = new Float32Array(COLS);
  const jitter = new Float32Array(COLS);
  for (let i = 0; i < COLS; i++) {
    wind[i] = 0.03 + 0.97 * Math.pow(Math.cos(((i - (COLS - 1) / 2) / COLS) * Math.PI), 1.6);
    // Semilla determinista: mismo dibujo en cada arranque, sin Math.random.
    const ruido = (((Math.sin(i * 12.9898) * 43758.5453) % 1) + 1) % 1;
    jitter[i] = 0.85 + 0.3 * ruido;
  }

  const canvas = document.getElementById("equalizer");
  const ctx = canvas.getContext("2d");

  /** Niveles actuales, objetivo y forma de la locución (0..1 por banda). */
  const levels = new Float32Array(COLS);
  const target = new Float32Array(COLS);
  const shape = new Float32Array(COLS);

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

  /** Celda de la rejilla, con un píxel de separación como en los medidores. */
  function cell(x, row) {
    ctx.fillRect(x * CELL + 1, row * CELL + 1, CELL - 2, CELL - 2);
  }

  function start() {
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

  function advance(now) {
    if (mode === "voice") {
      // Sin duración no hay aviso de fin: se corta igualmente pasado un margen
      // para no dejar el bucle eterno.
      const fin = durationMs > 0 ? durationMs : 15000;
      if (now - startedAt > fin + 300) {
        fallUntil = now + CAIDA_MS;
        mode = "fall";
      } else {
        const gain = currentGain(now);
        for (let i = 0; i < COLS; i++) target[i] = shape[i] * gain * wind[i];
      }
    }

    if (mode === "wave") {
      // Onda que viaja del centro a los lados: el retardo por distancia es lo
      // que hace que se mueva sola en vez de latir en bloque.
      const t = now * 0.001;
      const centro = (COLS - 1) / 2;
      const amp = 0.5 + Math.min(0.25, actCount * 0.05);
      for (let i = 0; i < COLS; i++) {
        target[i] =
          amp * wind[i] * (0.55 + 0.45 * Math.sin(t * 2 - Math.abs(i - centro) * 0.35)) * jitter[i];
      }
    }

    if (mode === "fall") {
      let max = 0;
      for (let i = 0; i < COLS; i++) {
        levels[i] *= 0.9;
        if (levels[i] > max) max = levels[i];
      }
      if (max < 0.01 || now >= fallUntil) {
        levels.fill(0);
        target.fill(0);
        // Si los agentes siguen en marcha, el ecualizador vuelve a la onda.
        mode = actCount > 0 ? "wave" : "standby";
        return;
      }
    }

    // Ataque rápido y caída lenta, sin redondear: la barra no salta de celda.
    if (mode === "voice" || mode === "wave") {
      for (let i = 0; i < COLS; i++) {
        const delta = target[i] - levels[i];
        if (delta > 0) levels[i] += delta * 0.35;
        else levels[i] += delta * 0.12;
      }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    if (mode === "standby") {
      // Reposo: brasa fija, determinista, sin animación. Único fotograma.
      for (let x = 0; x < COLS; x++) {
        ctx.fillStyle = FIRE[0];
        ctx.globalAlpha = 0.35;
        cell(x, ROWS - 1);
        ctx.globalAlpha = 0.1 + 0.1 * ((jitter[x] - 0.85) / 0.3);
        cell(x, ROWS - 2);
        if (jitter[x] > 1.03) {
          ctx.globalAlpha = 0.07;
          cell(x, ROWS - 3);
        }
      }
      ctx.globalAlpha = 1;
      return;
    }

    // Cuerpo: crece de abajo arriba y el color sube con la altura.
    for (let x = 0; x < COLS; x++) {
      const total = levels[x] * ROWS;
      const body = Math.min(ROWS, Math.floor(total));
      const frac = total - body;
      ctx.globalAlpha = 1;
      for (let r = 0; r < body; r++) {
        ctx.fillStyle = FIRE[Math.min(FIRE.length - 1, Math.floor((r / ROWS) * FIRE.length))];
        cell(x, ROWS - 1 - r);
      }
      if (total > 0.03) {
        // La celda superior siempre es blanca, y asoma ya con la fracción antes
        // de que la columna llegue a una celda entera: así la barra no aparece
        // de golpe al cruzar la primera.
        const tipRow = Math.min(ROWS - 1, body);
        ctx.fillStyle = TIP;
        ctx.globalAlpha = body >= ROWS ? 1 : 0.25 + 0.75 * frac;
        cell(x, ROWS - 1 - tipRow);
      }
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
      // Caída y después el fotograma de reposo, sin bucle.
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
        target.fill(0);
        mode = "standby";
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
  draw();
})();
