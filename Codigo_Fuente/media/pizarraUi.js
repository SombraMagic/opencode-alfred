/* Pizarra — capa INTERFACES: widgets de wireframe puros.
   Aquí no hay DOM al cargar: solo cuentas y pintura sobre un `ctx` que llega por parámetro.
   `pizarra.js` aporta el contexto, el zoom y el estado; esto no los conoce.

   Widget: { id, kind, parent, x, y, w, h, title, text, placeholder, items: [],
             active, options: [], checked: [], variant, align, icon, src, disabled }
   `x`/`y` son relativas a la caja útil del padre y el orden del array es el z-order.
   `parent` a null (o ausente) cuelga de la escena.

   Se puede cargar con `require` en node para comprobarla sin navegador. */
(function () {
  "use strict";

  /** Widgets de la paleta, en su orden. `group` separa contenedores de controles. */
  const KINDS = [
    { kind: "container", group: "contenedor", label: "Contenedor" },
    { kind: "window", group: "contenedor", label: "Ventana" },
    { kind: "tabs-h", group: "contenedor", label: "Pestañas H" },
    { kind: "tabs-v", group: "contenedor", label: "Pestañas V" },
    { kind: "accordion", group: "contenedor", label: "Acordeón" },
    { kind: "menu", group: "control", label: "Menú" },
    { kind: "label", group: "control", label: "Etiqueta" },
    { kind: "input", group: "control", label: "Campo" },
    { kind: "textarea", group: "control", label: "Área de texto" },
    { kind: "choice", group: "control", label: "Casilla/Radio" },
    { kind: "button", group: "control", label: "Botón" },
    { kind: "icon", group: "control", label: "Icono" },
    { kind: "image", group: "control", label: "Imagen" },
  ];

  /** Tamaño con el que nace cada widget al soltarlo. */
  const SIZES = {
    container: { w: 240, h: 160 },
    window: { w: 320, h: 220 },
    "tabs-h": { w: 360, h: 240 },
    "tabs-v": { w: 360, h: 240 },
    accordion: { w: 320, h: 200 },
    menu: { w: 160, h: 140 },
    label: { w: 160, h: 24 },
    input: { w: 200, h: 28 },
    textarea: { w: 240, h: 80 },
    choice: { w: 200, h: 44 },
    button: { w: 120, h: 32 },
    icon: { w: 32, h: 32 },
    image: { w: 160, h: 120 },
  };

  // Estilo desnudo: nada del tema, solo tinta y papel.
  const INK = "#111111";
  const PAPER = "#ffffff";
  const SOFT = "#f0f0f0";
  const MUTE = "#888888";
  const OFF = "#bbbbbb";
  const FONT = "12px sans-serif";
  const FONT_SM = "11px sans-serif";

  /** Alto de la barra de título de `window`. */
  const TITLE_H = 28;
  /** Alto de la tira de `tabs-h`. */
  const STRIP_H = 26;
  /** Ancho de la tira de `tabs-v`. */
  const STRIP_V = 110;
  /** Alto de fila de `menu` y `choice`. */
  const ROW_H = 22;
  /** Alto de fila de `accordion`. */
  const ACC_H = 26;

  /** Glifos de reserva para los nombres de icono habituales. */
  const GLYPHS = {
    user: "☺", search: "⌕", menu: "≡", close: "✕", plus: "+", minus: "−",
    check: "✓", star: "★", home: "⌂", gear: "⚙", mail: "✉", lock: "⚿",
    info: "i", warning: "!", play: "▶",
  };

  // Estado de pintado de la llamada en curso (draw es síncrono).
  let ZOOM = 1;
  let FINE = true;
  let LW = 1;
  /** Imágenes ya decodificadas que pasa el llamador en `draw`, por `src` del widget. */
  let IMGS = null;

  // ── Utilidades de cuenta ───────────────────────────────────

  function num(v, d) {
    return typeof v === "number" && isFinite(v) ? v : d;
  }

  function count(list) {
    return Array.isArray(list) ? list.length : 0;
  }

  /** Índice declarado o -1: cualquier cosa que no sea un entero >= 0 no marca nada. */
  function idx(v) {
    return typeof v === "number" && v >= 0 ? Math.floor(v) : -1;
  }

  function find(nodes, id) {
    const all = nodes || [];
    for (let i = 0; i < all.length; i++) {
      if (all[i] && all[i].id === id) return all[i];
    }
    return null;
  }

  // ── Caja útil ──────────────────────────────────────────────

  /**
   * Caja útil de un widget: el hijo se coloca dentro y ahí van sus coordenadas.
   * `window` deja la barra de título arriba, `tabs-*` su tira y `accordion` sus filas.
   * Ningún lado baja de 1.
   */
  function contentBox(node) {
    const n = node || {};
    const w = num(n.w, 0);
    const h = num(n.h, 0);
    let dx = 0;
    let dy = 0;
    let cw = w;
    let ch = h;
    if (n.kind === "window") {
      dy = TITLE_H;
      ch = h - TITLE_H;
    } else if (n.kind === "tabs-h") {
      dy = STRIP_H;
      ch = h - STRIP_H;
    } else if (n.kind === "tabs-v") {
      dx = STRIP_V;
      cw = w - STRIP_V;
    } else if (n.kind === "accordion") {
      dy = ACC_H * count(n.items);
      ch = h - dy;
    }
    return { dx: dx, dy: dy, w: Math.max(1, cw), h: Math.max(1, ch) };
  }

  /** Hijos directos en el orden del array; `id` nulo devuelve las raíces. */
  function children(nodes, id) {
    const key = id == null ? null : id;
    const out = [];
    const all = nodes || [];
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (!n) continue;
      const p = n.parent == null ? null : n.parent;
      if (p === key) out.push(n);
    }
    return out;
  }

  /** Caja absoluta: suma las cajas útiles de los ancestros sobre el `x`/`y` relativo. */
  function place(nodes, node) {
    if (!node) return { x: 0, y: 0, w: 0, h: 0 };
    let x = num(node.x, 0);
    let y = num(node.y, 0);
    let cur = node;
    let guard = 0;
    while (cur && cur.parent != null && guard++ < 64) {
      const p = find(nodes, cur.parent);
      if (!p) break;
      const cb = contentBox(p);
      x += cb.dx + num(p.x, 0);
      y += cb.dy + num(p.y, 0);
      cur = p;
    }
    return { x: x, y: y, w: num(node.w, 0), h: num(node.h, 0) };
  }

  /** Orden de pintado plano: padre antes que sus hijos, array en orden. */
  function paintOrder(nodes) {
    const all = nodes || [];
    const ids = {};
    for (let i = 0; i < all.length; i++) if (all[i]) ids[all[i].id] = true;
    const out = [];
    const walk = function (n, depth) {
      if (depth > 64) return;
      out.push(n);
      const kids = n.id == null ? [] : children(all, n.id);
      for (let k = 0; k < kids.length; k++) walk(kids[k], depth + 1);
    };
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (!n) continue;
      if (n.parent == null || !ids[n.parent]) walk(n, 0);
    }
    return out;
  }

  // ── Golpe y simulación de clic ─────────────────────────────

  /**
   * Índice de pestaña de una coordenada local: `lx` en `tabs-h`, `ly` en `tabs-v`.
   * `vertical` solo elige el lado del widget que se reparte entre las pestañas.
   */
  function tabAt(n, coord, vertical) {
    const m = count(n.items);
    if (m <= 0) return 0;
    const span = vertical ? num(n.h, 1) / m : num(n.w, 1) / m;
    const i = Math.floor(coord / Math.max(1, span));
    return i < 0 ? 0 : i >= m ? m - 1 : i;
  }

  /** Qué parte del widget cae en unas coordenadas locales: body, title, tab:i, row:i o check:i. */
  function partAt(n, lx, ly) {
    const k = n.kind;
    if (k === "window") return ly < TITLE_H ? "title" : "body";
    if (k === "tabs-h") {
      if (ly >= STRIP_H) return "body";
      return "tab:" + tabAt(n, lx, false);
    }
    if (k === "tabs-v") {
      if (lx >= STRIP_V) return "body";
      // La tira va de arriba abajo: manda la `y` local.
      return "tab:" + tabAt(n, ly, true);
    }
    if (k === "accordion") {
      const rows = count(n.items);
      if (rows <= 0 || ly >= ACC_H * rows) return "body";
      return "row:" + Math.max(0, Math.min(rows - 1, Math.floor(ly / ACC_H)));
    }
    if (k === "menu") {
      const rows = count(n.items);
      const i = Math.floor(ly / ROW_H);
      return i >= 0 && i < rows ? "row:" + i : "body";
    }
    if (k === "choice") {
      const rows = count(n.options);
      const i = Math.floor(ly / ROW_H);
      return i >= 0 && i < rows ? "check:" + i : "body";
    }
    return "body";
  }

  /** Golpe en coordenadas absolutas: el último pintado es el primero en recibirlo. */
  function hit(nodes, x, y) {
    const order = paintOrder(nodes);
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      const b = place(nodes, n);
      if (b.w <= 0 || b.h <= 0) continue;
      if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
      return { node: n, part: partAt(n, x - b.x, y - b.y) };
    }
    return null;
  }

  /**
   * Simulación de diseño de un clic: muta el nodo y lo devuelve.
   * `tab:i` activa la pestaña; `row:i` resalta/abre (misma fila → -1);
   * `check:i` alterna la marca (en radio deja solo esa). `body`/`title` no hacen nada.
   */
  function click(node, part) {
    if (!node || !part) return node;
    const cut = part.indexOf(":");
    if (cut < 0) return node;
    const family = part.slice(0, cut);
    const i = parseInt(part.slice(cut + 1), 10);
    if (!isFinite(i) || i < 0) return node;
    if (family === "tab") {
      node.active = i;
    } else if (family === "row") {
      node.active = idx(node.active) === i ? -1 : i;
    } else if (family === "check") {
      if (node.variant === "radio") {
        node.checked = [i];
      } else {
        const list = Array.isArray(node.checked) ? node.checked.slice() : [];
        const at = list.indexOf(i);
        if (at >= 0) list.splice(at, 1);
        else list.push(i);
        list.sort(function (a, b) {
          return a - b;
        });
        node.checked = list;
      }
    }
    return node;
  }

  /** Asas de redimensionado sobre la caja del nodo, en el orden del reloj desde arriba. */
  function handlePoints(node) {
    const x = num(node && node.x, 0);
    const y = num(node && node.y, 0);
    const w = num(node && node.w, 0);
    const h = num(node && node.h, 0);
    const mx = x + w / 2;
    const my = y + h / 2;
    return [
      { part: "nw", x: x, y: y },
      { part: "n", x: mx, y: y },
      { part: "ne", x: x + w, y: y },
      { part: "e", x: x + w, y: my },
      { part: "se", x: x + w, y: y + h },
      { part: "s", x: mx, y: y + h },
      { part: "sw", x: x, y: y + h },
      { part: "w", x: x, y: my },
    ];
  }

  // ── Pintura ────────────────────────────────────────────────

  function fillBox(ctx, x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  function frame(ctx, x, y, w, h, color) {
    ctx.strokeStyle = color || INK;
    ctx.lineWidth = LW;
    ctx.strokeRect(x, y, w, h);
  }

  function line(ctx, x1, y1, x2, y2, color) {
    ctx.strokeStyle = color || INK;
    ctx.lineWidth = LW;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  /** Círculo relleno; sin `arc` en el contexto cae a un cuadrado. */
  function dot(ctx, cx, cy, r, color) {
    ctx.fillStyle = color || INK;
    if (!ctx.arc) {
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      return;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Círculo hueco (radio de `choice`). */
  function ring(ctx, cx, cy, r, color) {
    if (!ctx.arc) {
      frame(ctx, cx - r, cy - r, r * 2, r * 2, color);
      return;
    }
    ctx.strokeStyle = color || INK;
    ctx.lineWidth = LW;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Rectángulo redondeado; sin curvas en el contexto cae a rectángulo seco. */
  function shape(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (!ctx.quadraticCurveTo) {
      ctx.rect(x, y, w, h);
      return;
    }
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /** Recorte aproximado por caracteres: el wireframe no necesita medir de verdad. */
  function cut(str, w) {
    const max = Math.max(1, Math.floor(w / 6.6));
    return str.length > max ? str.slice(0, Math.max(1, max - 1)) + "…" : str;
  }

  /** Texto centrado vertical en `y`; `x` es el borde izquierdo del hueco de ancho `w`. */
  function text(ctx, str, x, y, w, color, font, align) {
    if (!FINE || str == null || str === "" || w < 2) return;
    const s = cut(String(str), w);
    ctx.fillStyle = color || INK;
    ctx.font = font || FONT;
    ctx.textBaseline = "middle";
    ctx.textAlign = align || "left";
    ctx.fillText(s, align === "center" ? x + w / 2 : align === "right" ? x + w : x, y);
  }

  function paintContainer(ctx, n, x, y, w, h, ink) {
    frame(ctx, x, y, w, h, ink);
    if (n.title) text(ctx, n.title, x + 4, y + 9, w - 8, ink, FONT_SM, "left");
  }

  function paintWindow(ctx, n, x, y, w, h, ink) {
    const soft = n.disabled ? PAPER : SOFT;
    fillBox(ctx, x, y, w, h, PAPER);
    fillBox(ctx, x, y, w, TITLE_H, soft);
    frame(ctx, x, y, w, h, ink);
    line(ctx, x, y + TITLE_H, x + w, y + TITLE_H, ink);
    if (FINE) {
      dot(ctx, x + 11, y + TITLE_H / 2, 3, ink);
      dot(ctx, x + 21, y + TITLE_H / 2, 3, ink);
      dot(ctx, x + 31, y + TITLE_H / 2, 3, ink);
    }
    text(ctx, n.title, x + 40, y + TITLE_H / 2, Math.max(2, w - 80), ink, FONT_SM, "center");
  }

  function paintTabsH(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const m = items.length;
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    fillBox(ctx, x, y, w, h, PAPER);
    fillBox(ctx, x, y, w, STRIP_H, soft);
    const tw = m > 0 ? w / m : w;
    for (let i = 0; i < m; i++) {
      const tx = x + i * tw;
      if (i === act) fillBox(ctx, tx + LW, y + LW, Math.max(1, tw - LW * 2), STRIP_H, PAPER);
      frame(ctx, tx, y, tw, STRIP_H, ink);
      text(ctx, items[i], tx + 4, y + STRIP_H / 2, Math.max(2, tw - 8), ink, FONT_SM, "center");
    }
    // cuerpo, con la línea de arriba abierta bajo la pestaña activa
    frame(ctx, x, y + STRIP_H, w, Math.max(1, h - STRIP_H), ink);
    if (act >= 0 && act < m) {
      fillBox(ctx, x + act * tw + LW, y + STRIP_H - LW, Math.max(1, tw - LW * 2), LW * 2, PAPER);
    }
  }

  function paintTabsV(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const m = items.length;
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    fillBox(ctx, x, y, w, h, PAPER);
    fillBox(ctx, x, y, STRIP_V, h, soft);
    const th = m > 0 ? h / m : h;
    for (let i = 0; i < m; i++) {
      const ty = y + i * th;
      if (i === act) fillBox(ctx, x + LW, ty + LW, STRIP_V - LW * 2, Math.max(1, th - LW * 2), PAPER);
      frame(ctx, x, ty, STRIP_V, th, ink);
      text(ctx, items[i], x + 8, ty + th / 2, STRIP_V - 14, ink, FONT_SM, "left");
    }
    frame(ctx, x + STRIP_V, y, Math.max(1, w - STRIP_V), h, ink);
    if (act >= 0 && act < m) {
      fillBox(ctx, x + STRIP_V - LW, y + act * th + LW, LW * 2, Math.max(1, th - LW * 2), PAPER);
    }
  }

  function paintAccordion(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const rows = items.length;
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    fillBox(ctx, x, y, w, h, PAPER);
    frame(ctx, x, y, w, h, ink);
    for (let i = 0; i < rows; i++) {
      const ry = y + i * ACC_H;
      if (ry + ACC_H > y + h) break;
      if (i === act) fillBox(ctx, x + LW, ry + LW, Math.max(1, w - LW * 2), ACC_H - LW, soft);
      line(ctx, x, ry + ACC_H, x + w, ry + ACC_H, ink);
      text(ctx, i === act ? "▾" : "▸", x + 6, ry + ACC_H / 2, 12, ink, FONT_SM, "left");
      text(ctx, items[i], x + 22, ry + ACC_H / 2, Math.max(2, w - 28), ink, FONT_SM, "left");
    }
    const by = y + rows * ACC_H;
    if (h - rows * ACC_H > 0) frame(ctx, x, by, w, h - rows * ACC_H, ink);
  }

  function paintMenu(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    fillBox(ctx, x, y, w, h, PAPER);
    for (let i = 0; i < items.length; i++) {
      const ry = y + i * ROW_H;
      if (ry + ROW_H > y + h) break;
      if (i === act) fillBox(ctx, x + LW, ry + LW, Math.max(1, w - LW * 2), ROW_H - LW, soft);
      text(ctx, items[i], x + 8, ry + ROW_H / 2, Math.max(2, w - 16), ink, FONT, "left");
      line(ctx, x, ry + ROW_H, x + w, ry + ROW_H, ink);
    }
    frame(ctx, x, y, w, h, ink);
  }

  function paintLabel(ctx, n, x, y, w, h, ink) {
    if (!n.text) return;
    text(ctx, n.text, x, y + h / 2, w, ink, FONT, n.align || "left");
  }

  function paintInput(ctx, n, x, y, w, h, ink) {
    const str = n.text != null && n.text !== "" ? n.text : n.placeholder;
    const color = n.text != null && n.text !== "" ? ink : n.disabled ? OFF : MUTE;
    fillBox(ctx, x, y, w, h, PAPER);
    frame(ctx, x, y, w, h, ink);
    text(ctx, str, x + 8, y + h / 2, Math.max(2, w - 16), color, FONT, "left");
  }

  function paintTextarea(ctx, n, x, y, w, h, ink) {
    const str = n.text != null && n.text !== "" ? n.text : n.placeholder;
    const color = n.text != null && n.text !== "" ? ink : n.disabled ? OFF : MUTE;
    fillBox(ctx, x, y, w, h, PAPER);
    frame(ctx, x, y, w, h, ink);
    text(ctx, str, x + 8, y + Math.min(h / 2, 12), Math.max(2, w - 16), color, FONT, "left");
  }

  function paintChoice(ctx, n, x, y, w, h, ink) {
    const opts = n.options || [];
    const checked = Array.isArray(n.checked) ? n.checked : [];
    const radio = n.variant === "radio";
    for (let i = 0; i < opts.length; i++) {
      const ry = y + i * ROW_H;
      if (ry + ROW_H > y + h) break;
      const cy = ry + ROW_H / 2;
      const cx = x + 6;
      if (radio) {
        ring(ctx, cx + 6, cy, 6, ink);
        if (checked.indexOf(i) >= 0) dot(ctx, cx + 6, cy, 2.5, ink);
      } else {
        frame(ctx, cx, cy - 6, 12, 12, ink);
        if (checked.indexOf(i) >= 0) {
          line(ctx, cx + 2, cy, cx + 5, cy + 3.5, ink);
          line(ctx, cx + 5, cy + 3.5, cx + 10, cy - 3.5, ink);
        }
      }
      text(ctx, opts[i], x + 24, cy, Math.max(2, w - 30), ink, FONT, "left");
    }
  }

  function paintButton(ctx, n, x, y, w, h, ink) {
    const r = 6;
    shape(ctx, x, y, w, h, r);
    if (n.variant === "primary" && !n.disabled) {
      ctx.fillStyle = SOFT;
      ctx.fill();
    } else {
      ctx.fillStyle = PAPER;
      ctx.fill();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = LW;
    ctx.stroke();
    text(ctx, n.text, x + 8, y + h / 2, Math.max(2, w - 16), ink, FONT, "center");
  }

  function paintIcon(ctx, n, x, y, w, h, ink) {
    fillBox(ctx, x, y, w, h, PAPER);
    frame(ctx, x, y, w, h, ink);
    if (!FINE) return;
    const name = n.icon || "";
    const glyph = GLYPHS[name] || name;
    if (!glyph) return;
    const size = Math.max(9, Math.min(22, Math.round(Math.min(w, h) * 0.6)));
    text(ctx, glyph, x + 2, y + h / 2, Math.max(2, w - 4), ink, size + "px sans-serif", "center");
  }

  /** Imagen decodificada de un widget `image`, si el llamador la trae en el mapa de `draw`. */
  function imagenDelMapa(src) {
    if (!IMGS || !src || typeof IMGS.get !== "function") return null;
    const img = IMGS.get(src);
    if (!img || num(img.width, 0) <= 0 || num(img.height, 0) <= 0) return null;
    return img;
  }

  /** `image`: la imagen recortada a la caja (centrada, sin deformar) o el aspa de marcador. */
  function paintImage(ctx, n, x, y, w, h, ink) {
    fillBox(ctx, x, y, w, h, PAPER);
    const img = imagenDelMapa(n.src);
    if (img && ctx.drawImage && ctx.clip) {
      // Recorte tipo «cover»: se queda la parte central de la imagen que llena la caja.
      const k = Math.max(w / img.width, h / img.height);
      const sw = w / k;
      const sh = h / k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
      ctx.restore();
    } else {
      line(ctx, x, y, x + w, y + h, ink);
      line(ctx, x + w, y, x, y + h, ink);
    }
    frame(ctx, x, y, w, h, ink);
  }

  /** Pinta un widget y, debajo, sus hijos desde la caja útil. */
  function paintNode(ctx, nodes, node, ox, oy, depth) {
    if (!node || depth > 64) return;
    const x = ox + num(node.x, 0);
    const y = oy + num(node.y, 0);
    const w = num(node.w, 0);
    const h = num(node.h, 0);
    const ink = node.disabled ? OFF : INK;
    if (w > 0 && h > 0) {
      switch (node.kind) {
        case "window":
          paintWindow(ctx, node, x, y, w, h, ink);
          break;
        case "tabs-h":
          paintTabsH(ctx, node, x, y, w, h, ink);
          break;
        case "tabs-v":
          paintTabsV(ctx, node, x, y, w, h, ink);
          break;
        case "accordion":
          paintAccordion(ctx, node, x, y, w, h, ink);
          break;
        case "menu":
          paintMenu(ctx, node, x, y, w, h, ink);
          break;
        case "label":
          paintLabel(ctx, node, x, y, w, h, ink);
          break;
        case "input":
          paintInput(ctx, node, x, y, w, h, ink);
          break;
        case "textarea":
          paintTextarea(ctx, node, x, y, w, h, ink);
          break;
        case "choice":
          paintChoice(ctx, node, x, y, w, h, ink);
          break;
        case "button":
          paintButton(ctx, node, x, y, w, h, ink);
          break;
        case "icon":
          paintIcon(ctx, node, x, y, w, h, ink);
          break;
        case "image":
          paintImage(ctx, node, x, y, w, h, ink);
          break;
        default:
          paintContainer(ctx, node, x, y, w, h, ink);
          break;
      }
    }
    const cb = contentBox(node);
    const kids = node.id == null ? [] : children(nodes, node.id);
    for (let i = 0; i < kids.length; i++) {
      paintNode(ctx, nodes, kids[i], x + cb.dx, y + cb.dy, depth + 1);
    }
  }

  /** Pinta el árbol entero; el llamador ya aplicó la transformación del zoom. */
  function draw(ctx, nodes, zoom, imagenes) {
    if (!ctx) return;
    ZOOM = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
    FINE = ZOOM >= 0.5;
    LW = 1 / ZOOM;
    // Mapa opcional `src → imagen decodificada` para los widgets `image`; sin él, marcador.
    IMGS = imagenes && typeof imagenes.get === "function" ? imagenes : null;
    const all = nodes || [];
    if (ctx.save) ctx.save();
    const order = paintOrder(all);
    for (let i = 0; i < order.length; i++) {
      // solo las raíces: los hijos los arrastra su padre
      const n = order[i];
      if (n.parent != null && find(all, n.parent)) continue;
      paintNode(ctx, all, n, 0, 0, 0);
    }
    if (ctx.restore) ctx.restore();
  }

  const PZUi = {
    KINDS: KINDS,
    defaults: function (kind) {
      const s = SIZES[kind];
      return s ? { w: s.w, h: s.h } : { w: 120, h: 32 };
    },
    contentBox: contentBox,
    children: children,
    place: place,
    hit: hit,
    click: click,
    draw: draw,
    handlePoints: handlePoints,
  };

  globalThis.PZUi = PZUi;
  if (typeof module !== "undefined") module.exports = PZUi;
})();
