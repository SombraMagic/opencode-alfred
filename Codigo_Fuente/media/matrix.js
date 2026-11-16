/**
 * Ecualizador Matrix del panel de voz: lluvia de trazos de luz en columnas de ancho fijo,
 * con un resplandor desde abajo y un haz central. Canvas 2D, sin librerías.
 * La voz (`envelope`) sube densidad, velocidad, brillo y altura del resplandor; en reposo
 * llovizna lenta y tenue; con agentes trabajando (`activity`) hay un pulso suave.
 * Encima de esa lluvia cae una capa de gotas del color de cada agente: un emisor por
 * color distinto (dos agentes del mismo color cuentan como uno), con estela corta y
 * velocidad propia. Sin colores no se emiten gotas y las que van cayendo se apagan solas.
 * Los colores base salen de los tokens --matrix y --bg del tema, cacheados por data-theme.
 */
(function () {
  const canvas = document.getElementById("matrix");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const CW = 7; // Ancho de columna en px CSS.
  const MAX_COLS = 48;
  const FRAME_MS = 33; // ~30 fps.
  const DROP_MAX = 120; // Tope duro de gotas vivas: la capa de color no puede encarecerse.
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

  // ── Color por tema ──────────────────────────────────────
  let themeKey = null;
  let pal = null;

  function rgb(hex, fallback) {
    let h = String(hex || "").trim().replace("#", "");
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    if (!/^[0-9a-f]{6}$/i.test(h)) h = fallback;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function palette() {
    const key = document.body?.dataset.theme || "";
    if (pal && key === themeKey) return pal;
    themeKey = key;
    const cs = getComputedStyle(document.body);
    const fg = rgb(cs.getPropertyValue("--matrix"), "2bff9a");
    const bg = rgb(cs.getPropertyValue("--bg"), "05080f");
    const light = (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000 > 140;
    // Cabeza: sobre fondo oscuro, el color aclarado hacia blanco; sobre claro, el color puro.
    const head = light ? fg : fg.map((c) => Math.round(c + (255 - c) * 0.75));
    pal = { fg, bg, head };
    return pal;
  }

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  /** Hex #rrggbb a triplete RGB; cualquier otra cosa devuelve null. */
  function parseHex(raw) {
    const h = String(raw || "").trim().replace("#", "");
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return rgb(h, h);
  }

  // ── Estado ──────────────────────────────────────────────
  let cols = [];
  let W = 0;
  let H = 0;
  let dpr = 1;

  // Voz.
  let shape = [];
  let energy = [];
  let durationMs = 0;
  let startedAt = 0;
  let voiceOn = false;
  let actCount = 0;
  let actStreaming = false;

  // Capa de color por agente: un emisor por color distinto y sus gotas vivas.
  let emitters = [];
  let drops = [];
  let dropSig = "";

  let lvl = 0; // Nivel suavizado de voz, 0..1.
  let raf = 0;
  let last = 0;

  function newCol(c, spread) {
    c.speed = 0.35 + Math.random() * 0.9; // Alturas de lienzo por segundo, a nivel 0.
    c.trail = (0.15 + Math.random() * 0.4) * H;
    c.y = spread ? Math.random() * (H + c.trail) - c.trail : -c.trail;
    c.gate = Math.random(); // Umbral de densidad: la columna llueve si la densidad lo supera.
    c.wait = 0;
    c.big = Math.random() < 0.3;
  }

  /** Colores vivos de los agentes: un emisor por hex distinto. Devuelve si cambiaron. */
  function setColors(list) {
    const want = [];
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const hex = String(raw || "").trim().toLowerCase();
      const c = parseHex(hex);
      if (!c || seen.has(hex)) continue; // Mismo color dos veces cuenta como uno.
      seen.add(hex);
      want.push({ hex, c });
    }
    const sig = want.map((w) => w.hex).join(",");
    if (sig === dropSig) return false;
    dropSig = sig;
    // Los colores que siguen conservan su emisor (y su ritmo); los nuevos entran ya.
    const prev = new Map(emitters.map((e) => [e.hex, e]));
    emitters = want.map(
      (w) => prev.get(w.hex) ?? { hex: w.hex, c: w.c, wait: Math.random() * 0.12 },
    );
    return true;
  }

  /** Gota nueva: x libre, tamaño 2-4 px, estela corta y velocidad propia. */
  function newDrop(c) {
    const s = 2 + Math.round(Math.random() * 2);
    return {
      c,
      x: 4 + Math.random() * Math.max(0, W - 8),
      y: -6 - Math.random() * 40,
      len: 20 + Math.random() * 40,
      vy: 0.22 + Math.random() * 0.45, // Alturas de lienzo por segundo.
      s,
      grad: null, // Se crea en el primer pintado, ya con el transform del lienzo.
    };
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    W = Math.round(r.width);
    H = Math.round(r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const n = Math.min(MAX_COLS, Math.max(4, Math.floor(W / CW)));
    cols = Array.from({ length: n }, () => {
      const c = {};
      newCol(c, true);
      return c;
    });
    start();
  }

  /** Energía de la voz en este instante, interpolada de la serie temporal. */
  function voiceGain(now) {
    if (!energy.length || durationMs <= 0) return 0.7;
    const t = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
    const pos = t * (energy.length - 1);
    const i = Math.floor(pos);
    const a = energy[i] ?? 0;
    const b = energy[Math.min(i + 1, energy.length - 1)] ?? 0;
    return a + (b - a) * (pos - i);
  }

  function density() {
    return 0.4 + 0.6 * lvl + (actCount > 0 ? 0.1 : 0);
  }

  function step(now, dt) {
    let target = 0;
    if (voiceOn) {
      const fin = durationMs > 0 ? durationMs : 15000;
      if (now - startedAt > fin + 300) voiceOn = false;
      else target = Math.min(1, voiceGain(now));
    }
    // Ataque rápido, caída lenta.
    lvl += (target - lvl) * (target > lvl ? 0.35 : 0.08);
    if (lvl < 0.005) lvl = 0;
    if (reduced) return;

    const vel = (0.5 + 2.2 * lvl) * (actStreaming ? 1.15 : 1);
    for (const c of cols) {
      if (c.wait > 0) {
        c.wait -= dt;
        continue;
      }
      c.y += c.speed * vel * H * dt;
      if (c.y - c.trail > H) {
        newCol(c, false);
        if (c.gate > density()) c.wait = 0.3 + Math.random() * 1.5;
      }
    }

    // Capa de color: cada emisor suelta una gota cada 180-260 ms; con N colores el
    // ritmo total escala con N. Al tope de gotas vivas se deja de emitir.
    for (const e of emitters) {
      e.wait -= dt;
      if (e.wait > 0) continue;
      e.wait = 0.18 + Math.random() * 0.08;
      if (drops.length < DROP_MAX) drops.push(newDrop(e.c));
    }
    // Sin colores no hay emisores: las gotas que quedan terminan de caer y se descartan.
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.y += d.vy * H * dt;
      if (d.y - d.len > H) drops.splice(i, 1);
    }
  }

  function draw(now) {
    const p = palette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = rgba(p.bg, 1);
    ctx.fillRect(0, 0, W, H);

    // Pulso suave de los agentes, distinto de la voz.
    const pulse = actCount > 0 && !reduced ?0.5 + 0.5 * Math.sin(now * 0.0025) : 0;
    const glow = Math.min(1, 0.16 + 0.84 * lvl + pulse * 0.18);

    // Resplandor desde abajo, elíptico y centrado: su altura crece con la voz.
    const gh = H * (0.35 + 0.6 * lvl);
    ctx.save();
    ctx.translate(W / 2, H);
    ctx.scale(1, gh / (W * 0.8));
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.8);
    g.addColorStop(0, rgba(p.fg, 0.8 * glow));
    g.addColorStop(0.45, rgba(p.fg, 0.28 * glow));
    g.addColorStop(1, rgba(p.fg, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-W, -W, 2 * W, W);
    ctx.restore();

    // Haz central: halo ancho y tenue, más un núcleo fino e intenso.
    const bh = H * (0.5 + 0.48 * lvl);
    g = ctx.createLinearGradient(0, H, 0, H - bh);
    g.addColorStop(0, rgba(p.head, 0.9 * glow));
    g.addColorStop(1, rgba(p.fg, 0));
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(W / 2 - W * (0.03 + 0.04 * lvl), H - bh, W * (0.06 + 0.08 * lvl), bh);
    ctx.globalAlpha = 1;
    ctx.fillRect(W / 2 - 1, H - bh, 2, bh);

    // Lluvia.
    const dens = density();
    const bright = 0.55 + 0.45 * Math.max(lvl, pulse * 0.4);
    const x0 = (W - cols.length * CW) / 2;
    cols.forEach((c, i) => {
      if (c.wait > 0 || c.gate > dens) return;
      const band = shape.length ? shape[Math.floor((i / cols.length) * shape.length)] || 0 : 0;
      const a = Math.min(1, bright * (0.7 + 0.6 * band));
      const x = x0 + i * CW + CW / 2;
      const top = c.y - c.trail;
      g = ctx.createLinearGradient(0, top, 0, c.y);
      g.addColorStop(0, rgba(p.fg, 0));
      g.addColorStop(1, rgba(p.fg, 0.75 * a));
      ctx.fillStyle = g;
      ctx.fillRect(x - 0.75, top, 1.5, c.trail);
      // Cabeza: cuadradito brillante.
      ctx.fillStyle = rgba(p.head, Math.min(1, a + 0.2));
      const s = c.big ? 4 : 3;
      ctx.fillRect(x - s / 2, c.y - s / 2, s, s);
    });

    // Gotas de color por agente, encima de la lluvia base: estela corta y cabeza cuadrada.
    if (drops.length) {
      const alpha = 0.55 + 0.45 * lvl;
      for (const d of drops) {
        if (!d.grad) {
          d.grad = ctx.createLinearGradient(0, -d.len, 0, 0);
          d.grad.addColorStop(0, rgba(d.c, 0));
          d.grad.addColorStop(1, rgba(d.c, alpha));
        }
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.fillStyle = d.grad;
        ctx.fillRect(-1, -d.len, 2, d.len);
        ctx.fillStyle = rgba(d.c, 0.95);
        ctx.fillRect(-d.s / 2, -d.s / 2, d.s, d.s);
        ctx.restore();
      }
    }
  }

  function tick(now) {
    raf = 0;
    if (document.hidden) return;
    if (now - last < FRAME_MS) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const dt = Math.min(0.1, (now - (last || now - FRAME_MS)) / 1000);
    last = now;
    step(performance.now(), dt);
    draw(now);
    // Con movimiento reducido y sin voz basta un fotograma (el pulso de agentes no late).
    if (!reduced || voiceOn || lvl > 0) raf = requestAnimationFrame(tick);
  }

  function start() {
    last = 0;
    if (!raf && !document.hidden && W) raf = requestAnimationFrame(tick);
  }

  // ── API para panel.js ───────────────────────────────────
  window.VOZMatrix = {
    envelope(msg) {
      shape = (msg?.values ?? []).map((v) => (Number(v) > 0 ? Math.min(1, Number(v)) : 0));
      energy = (msg?.energy ?? []).map((v) => Number(v) || 0);
      durationMs = msg?.durationMs ?? 0;
      startedAt = performance.now() - (msg?.ageMs ?? 0);
      voiceOn = true;
      start();
    },
    idle() {
      voiceOn = false;
      start();
    },
    /** `{count, streaming, colors}`; panel.js lo llama en cada sondeo. */
    activity(act) {
      const count = act?.count ?? 0;
      const streaming = Boolean(act?.streaming);
      const colorsChanged = setColors(act?.colors);
      if (count === actCount && streaming === actStreaming && !colorsChanged) return;
      actCount = count;
      actStreaming = streaming;
      start();
    },
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) start();
  });
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener("resize", resize);
  // Invalida la paleta al cambiar de tema (theme.js escribe data-theme).
  window.addEventListener("message", (e) => {
    if (e.data?.type === "theme") {
      pal = null;
      start();
    }
  });
  resize();
})();
