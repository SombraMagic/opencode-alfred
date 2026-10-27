/**
 * Ecualizador esférico: 32 bandas proyectadas sobre una esfera 3D que gira.
 * La rotación se acelera con la envolvente de audio, de modo que el movimiento
 * acompasa el ritmo de la voz.
 */
(function () {
  const canvas = document.getElementById("sphere");
  const ctx = canvas.getContext("2d");
  const BANDS = 32;

  /** Envolvente actual (0..1 por banda). */
  let levels = new Array(BANDS).fill(0);
  /** Forma objetivo de las bandas (0..1), modulada por la energía del momento. */
  let target = new Array(BANDS).fill(0);
  /** Forma fija de la locución. */
  let shape = new Array(BANDS).fill(0);
  /** Serie temporal de energía (0..1) para que el pulso siga a la voz. */
  let energy = [];
  let startedAt = 0;
  let durationMs = 0;
  let rotation = 0;
  let spin = 0;
  let active = false;
  let hue = 190;

  // ── Efectos reactivos ──────────────────────────────────
  /** Energía suavizada, para detectar subidas bruscas (golpes de voz). */
  let smooth = 0;
  let prevGain = 0;
  /** Destello actual (0..1): decae solo. */
  let punch = 0;
  /** Nivel medio de las bandas en el fotograma actual. */
  let levelAvg = 0;
  /** Contador total de estallidos; sirve para la comprobación automática. */
  let bursts = 0;
  let nextBurst = 0;
  /** Ondas expansivas y chispas. Arrays acotados: no crecen sin límite. */
  const rings = [];
  const sparks = [];

  // Estrellas fijas: generador con semilla para que no bailen entre fotogramas.
  let seed = 20261021;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const stars = Array.from({ length: 44 }, () => ({
    x: rand(),
    y: rand(),
    s: 0.7 + rand() * 1.3,
    phase: rand() * 6.28,
  }));

  /** Golpe de voz: anillo que se expande, chispas y destello. */
  function burst(power) {
    bursts++;
    if (rings.length < 10) {
      rings.push({ r: 0.3, life: 1 });
      rings.push({ r: 0.2, life: 0.7 });
    }
    const count = 10 + Math.round(power * 12);
    for (let i = 0; i < count && sparks.length < 110; i++) {
      sparks.push({
        a: rand() * Math.PI * 2,
        r: 0.3 + rand() * 0.05,
        v: 0.005 + rand() * 0.016 * (0.6 + power),
        life: 1,
      });
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 300;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Punto de la esfera con radio según la banda. */
  function spherePoint(i, size) {
    const angle = (i / BANDS) * Math.PI * 2;
    const band = levels[i];
    const base = size * 0.28;
    const radius = base + band * size * 0.16;
    const tilt = 0.55;
    // Rotación en Y y ligera inclinación en X.
    const x = Math.cos(angle + rotation) * radius;
    const z = Math.sin(angle + rotation) * radius;
    const y = z * Math.sin(tilt);
    const zz = z * Math.cos(tilt);
    return { x, y, z: zz, depth: zz };
  }

  function draw() {
    const size = canvas.clientWidth || 300;
    const cx = size / 2;
    const cy = size / 2;

    ctx.clearRect(0, 0, size, size);

    // Estrellas de fondo: laten con la voz.
    ctx.fillStyle = `hsla(${hue}, 90%, 82%, 0.08 + smooth * 0.3)`;
    for (const st of stars) {
      const s = st.s * (0.8 + 0.5 * Math.sin(rotation * 2 + st.phase) + smooth * 0.4);
      ctx.fillRect(st.x * size, st.y * size, s, s);
    }

    // Halo exterior: tenue, para dar profundidad sin tapar las barras.
    const glow = ctx.createRadialGradient(cx, cy, size * 0.05, cx, cy, size * 0.42);
    glow.addColorStop(0, `hsla(${hue}, 100%, 55%, ${0.05 + spin * 0.05})`);
    glow.addColorStop(0.5, `hsla(${hue}, 100%, 50%, ${0.03 + spin * 0.03})`);
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    // Meridianos y paralelos de la esfera base.
    ctx.strokeStyle = `hsla(${hue}, 90%, 60%, 0.22)`;
    ctx.lineWidth = 1;
    for (let m = 0; m < 6; m++) {
      ctx.beginPath();
      for (let a = 0; a <= 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        const r = size * 0.28;
        const x = Math.cos(t) * r;
        const y = Math.sin(t) * r * Math.sin(0.55);
        const p = ctx.isPointInPath ? { x, y } : { x, y };
        if (a === 0) ctx.moveTo(cx + x, cy + y);
        else ctx.lineTo(cx + x, cy + y);
      }
      ctx.stroke();
    }
    for (let p = 1; p < 4; p++) {
      const rr = size * 0.28 * Math.cos((p / 4) * Math.PI);
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1, rr), size * 0.28 * Math.sin(0.55) * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Barras: de atrás hacia delante para que el orden de profundidad sea correcto.
    const points = [];
    for (let i = 0; i < BANDS; i++) points.push({ i, ...spherePoint(i, size) });
    points.sort((a, b) => a.depth - b.depth);

    // La esfera respira: todo el conjunto crece un poco con la voz.
    ctx.save();
    if (levelAvg > 0) {
      const pulse = 1 + levelAvg * 0.09;
      ctx.translate(cx, cy);
      ctx.scale(pulse, pulse);
      ctx.translate(-cx, -cy);
    }

    for (const p of points) {
      const band = levels[p.i];
      const front = (p.depth + size * 0.3) / (size * 0.6);
      const alpha = 0.18 + front * 0.82;
      const h = hue + band * 45;

      const x0 = cx + p.x;
      const y0 = cy + p.y - size * 0.28 * 0.55;
      const x1 = cx + p.x * 1.34;
      const y1 = cy + p.y * 1.34 - size * 0.28 * 0.55;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);

      // Dos pasadas con el mismo trazado: halo ancho + filo brillante.
      ctx.lineCap = "round";
      ctx.strokeStyle = `hsla(${h}, 100%, 60%, ${alpha * 0.22})`;
      ctx.lineWidth = 5 + band * 9;
      ctx.stroke();

      ctx.strokeStyle = `hsla(${h}, 100%, ${58 + band * 25}%, ${alpha})`;
      ctx.lineWidth = 1.4 + band * 3.4;
      ctx.stroke();

      // Punta luminosa: sólo en las bandas fuertes, para que destelle el aro.
      if (band > 0.45) {
        ctx.fillStyle = `hsla(${h + 30}, 100%, 92%, ${Math.min(1, band)})`;
        ctx.beginPath();
        ctx.arc(x1, y1, 1.2 + band * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Ondas y chispas: en modo aditivo para que brillen sobre lo anterior.
    ctx.globalCompositeOperation = "lighter";

    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i];
      g.r += (0.54 - g.r) * 0.08;
      g.life -= 0.03;
      if (g.life <= 0) {
        rings.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = `hsla(${hue + 20}, 100%, 78%, ${g.life * 0.7})`;
      ctx.lineWidth = 1.5 + g.life * 4;
      ctx.beginPath();
      ctx.ellipse(cx, cy, g.r * size, g.r * size * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.r += s.v;
      s.life -= 0.03;
      if (s.life <= 0) {
        sparks.splice(i, 1);
        continue;
      }
      const x = cx + Math.cos(s.a) * s.r * size;
      const y = cy + Math.sin(s.a) * s.r * size * 0.55;
      ctx.fillStyle = `hsla(${hue + 45}, 100%, 90%, ${Math.min(1, s.life * 1.2)})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.6 + s.life * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";

    // Núcleo: se enciende con los golpes de voz.
    const flare = 0.11 + punch * 0.035;
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * flare);
    core.addColorStop(0, `hsla(${hue + 60}, 100%, 85%, ${0.35 + spin * 0.2 + punch * 0.5})`);
    core.addColorStop(1, "transparent");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, size * flare, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `hsla(${hue}, 100%, 70%, ${0.45 + punch * 0.4})`;
    ctx.lineWidth = 1 + punch * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, size * flare, 0, Math.PI * 2);
    ctx.stroke();

    // Barrido: dos arcos de brillo girando por el aro.
    const ga = rotation * 1.7;
    ctx.strokeStyle = `hsla(${hue + 80}, 100%, 88%, ${0.2 + punch * 0.55})`;
    ctx.lineWidth = 2;
    for (const off of [0, Math.PI]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, size * 0.3, size * 0.3 * 0.55, 0, ga + off, ga + off + 0.45);
      ctx.stroke();
    }

    // Picos: doble borde cromático y rayos de luz desde el centro.
    if (punch > 0.08) {
      ctx.globalCompositeOperation = "lighter";
      const split = punch * 4;
      ctx.strokeStyle = `hsla(${hue - 70}, 100%, 70%, ${punch * 0.55})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx - split, cy, size * 0.3, size * 0.3 * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `hsla(${hue + 80}, 100%, 70%, ${punch * 0.55})`;
      ctx.beginPath();
      ctx.ellipse(cx + split, cy, size * 0.3, size * 0.3 * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();

      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + rotation * 2.4;
        const len = size * (0.2 + punch * 0.42);
        ctx.strokeStyle = `hsla(${hue + i * 6}, 100%, 88%, ${punch * 0.3})`;
        ctx.lineWidth = 1 + punch * 3.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len * 0.6);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    // Destello de pantalla en los picos (muy leve, no debe lavar el panel).
    if (punch > 0.02) {
      ctx.fillStyle = `hsla(${hue + 50}, 100%, 88%, ${punch * 0.16})`;
      ctx.fillRect(0, 0, size, size);
    }
  }

  /** Energía de la voz en el instante actual, interpolada de la serie temporal. */
  function currentGain() {
    if (!active) return 0;
    if (!energy.length || durationMs <= 0) return 1;
    const t = Math.min(1, (performance.now() - startedAt) / durationMs);
    const pos = t * (energy.length - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    const a = energy[i] ?? 0;
    const b = energy[Math.min(i + 1, energy.length - 1)] ?? 0;
    return a + (b - a) * f;
  }

  function tick() {
    // La forma de las bandas se multiplica por la energía del momento: así el
    // ecualizador late con la voz en lugar de quedarse en una figura fija.
    const gain = currentGain();
    // Actividad de agentes: panel.js publica window.alfredActivity. Sin voz, la
    // esfera ondula despacio para no quedarse muerta mientras hay trabajo.
    const act = window.alfredActivity;
    const working = act && act.count > 0 && !active ? act : null;
    const ripple = working
      ? Math.min(0.3, 0.1 + working.count * 0.05) * (working.streaming ? 1.1 : 0.8)
      : 0;
    const now = performance.now() * 0.001;
    const speed = working?.streaming ? 2.4 : 1.3;
    let total = 0;
    for (let i = 0; i < BANDS; i++) {
      target[i] = shape[i] * gain;
      levels[i] += (target[i] - levels[i]) * 0.18;
      if (ripple > 0) {
        // Onda que recorre el aro: solo sube el nivel, nunca lo baja.
        const wave = ripple * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * speed + i * 0.55)));
        if (wave > levels[i]) levels[i] += (wave - levels[i]) * 0.2;
      }
      total += levels[i];
    }
    total /= BANDS;
    levelAvg = total;

    // Golpes de voz: energía por encima de la media reciente (no el salto de
    // un fotograma al siguiente: con voz real casi nunca supera el umbral).
    const rise = gain - smooth;
    smooth += (gain - smooth) * 0.12;
    punch = Math.max(punch * 0.93, Math.min(1, Math.max(0, rise) * 5));
    if (rise > 0.06 && gain > 0.3 && performance.now() > nextBurst) {
      burst(gain);
      nextBurst = performance.now() + 70;
    }

    // La rotación sigue a la energía: se acelera con la voz y vuelve suave
    // al ritmo de reposo cuando termina. Sin decaimiento se quedaría
    // acelerada para siempre tras la primera locución.
    const targetSpin = active ? 1 + total * 4 : 1.8;
    spin += (Math.min(targetSpin, 2.8) - spin) * 0.08;
    rotation += 0.006 + spin * 0.02;
    // El matiz oscila en la gama cian-violeta (sin llegar al verde ni al rosa)
    // y se calienta con los picos.
    hue = 230 + Math.sin(rotation * 1.6) * 50 + punch * 25;

    draw();
    requestAnimationFrame(tick);
  }

  // ── API del ecualizador ────────────────────────────────
  // panel.js lo llama directamente. No se usa window.postMessage como bus
  // interno: en el webview de VS Code ese canal no entrega a la misma página.
  window.VOZEqualizer = {
    envelope(msg) {
      shape = (msg?.values ?? []).slice(0, BANDS);
      while (shape.length < BANDS) shape.push(0);
      energy = msg?.energy ?? [];
      durationMs = msg?.durationMs ?? 0;
      // ageMs permite arrancar a mitad cuando la voz ya lleva sonando
      // (el aviso del MCP llega con un pequeño retraso).
      startedAt = performance.now() - (msg?.ageMs ?? 0);
      active = true;
    },
    idle() {
      active = false;
      shape = new Array(BANDS).fill(0);
      target = new Array(BANDS).fill(0);
      energy = [];
      // Sin esto, un destello quedaría encendido en reposo.
      punch = 0;
      smooth = 0;
      prevGain = 0;
    },
    /** Estado interno, para las comprobaciones automáticas. */
    stats() {
      return { bursts, rings: rings.length, sparks: sparks.length, punch, gain: currentGain() };
    },
  };

  // Los mensajes de la extensión también llegan aquí; se enrutan a la API.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg?.type === "envelope") window.VOZEqualizer.envelope(msg);
    else if (msg?.type === "idle" || msg?.type === "stop") window.VOZEqualizer.idle();
  });

  window.addEventListener("resize", resize);
  resize();
  tick();
})();
