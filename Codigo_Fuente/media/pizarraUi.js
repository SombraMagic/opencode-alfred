/* Pizarra — capa INTERFACES: widgets de wireframe puros.
   Aquí no hay DOM al cargar: solo cuentas y pintura sobre un `ctx` que llega por parámetro.
   `pizarra.js` aporta el contexto, el zoom y el estado; esto no los conoce.

   Widget: { id, kind, parent, x, y, w, h, title, text, placeholder, items: [],
             active, options: [], checked: [], variant, align, icon, src, disabled }
   `x`/`y` son relativas a la caja útil del padre y el orden del array es el z-order.
   `parent` a null (o ausente) cuelga de la escena.

   Personalización, plana junto a lo anterior: `fill` (`"auto"`, `"none"` o `#rrggbb`),
   `stroke` (`#rrggbb` o `"none"`), `titleColor` (`#rrggbb`), `titleSize` (8..48),
   `orientation` (`"h"`/`"v"`, solo `menu`), `icons` y `scroll` (booleanos, solo `list`).

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
    { kind: "list", group: "control", label: "Lista" },
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
    list: { w: 220, h: 160 },
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

  /** Círculo aproximado con cuatro curvas, en coordenadas de 24×24. */
  function circulo(cx, cy, r) {
    return [
      ["M", cx - r, cy],
      ["Q", cx - r, cy - r, cx, cy - r],
      ["Q", cx + r, cy - r, cx + r, cy],
      ["Q", cx + r, cy + r, cx, cy + r],
      ["Q", cx - r, cy + r, cx - r, cy],
    ];
  }

  /**
   * Glifos de los iconos de la rejilla (`PZFlow.ICONS` en el panel, aquí sin cargarlo).
   * Un valor de texto se pinta como glifo; una lista de trazos, con `trazaIcono` en 24×24.
   */
  const GLYPHS = {
    user: "☺", search: "⌕", menu: "≡", close: "✕", plus: "+", minus: "−",
    check: "✓", star: "★", home: "⌂", gear: "⚙", mail: "✉", lock: "⚿",
    info: "i", warning: "!", play: "▶",
    key: [circulo(8, 12, 4.5), [["M", 12, 12], ["L", 20, 12]], [["M", 17, 12], ["L", 17, 16]], [["M", 20, 12], ["L", 20, 15]]],
    database: [
      [["M", 4, 7], ["Q", 4, 4, 12, 4], ["Q", 20, 4, 20, 7], ["Q", 20, 10, 12, 10], ["Q", 4, 10, 4, 7]],
      [["M", 4, 7], ["L", 4, 17], ["Q", 4, 20, 12, 20], ["Q", 20, 20, 20, 17], ["L", 20, 7]],
      [["M", 4, 13.5], ["Q", 4, 16.5, 12, 16.5], ["Q", 20, 16.5, 20, 13.5]],
    ],
    cloud: [
      [
        ["M", 7, 17],
        ["Q", 4, 17, 4, 14],
        ["Q", 4, 11, 7, 11],
        ["Q", 8, 7, 12, 7],
        ["Q", 16, 7, 16, 11],
        ["Q", 20, 11, 20, 14],
        ["Q", 20, 17, 17, 17],
        ["Z"],
      ],
    ],
    api: [
      [["M", 4, 8], ["L", 4, 16]],
      [["M", 20, 8], ["L", 20, 16]],
      [["M", 8, 12], ["L", 16, 12]],
      [["M", 13, 9], ["L", 16, 12], ["L", 13, 15]],
    ],
    clock: [circulo(12, 12, 8), [["M", 12, 7], ["L", 12, 12], ["L", 16, 14]]],
    doc: [
      [["M", 6, 3], ["L", 14, 3], ["L", 18, 7], ["L", 18, 21], ["L", 6, 21], ["Z"]],
      [["M", 14, 3], ["L", 14, 7], ["L", 18, 7]],
      [["M", 9, 12], ["L", 15, 12]],
      [["M", 9, 16], ["L", 13, 16]],
    ],
    globe: [circulo(12, 12, 8), [["M", 4, 12], ["L", 20, 12]], [["M", 12, 4], ["Q", 7.5, 12, 12, 20], ["Q", 16.5, 12, 12, 4]]],
    terminal: [
      [["M", 3, 5], ["L", 21, 5], ["L", 21, 19], ["L", 3, 19], ["Z"]],
      [["M", 7, 9], ["L", 10, 12], ["L", 7, 15]],
      [["M", 13, 15], ["L", 17, 15]],
    ],
  };

  // Estado de pintado de la llamada en curso (draw es síncrono).
  let ZOOM = 1;
  let FINE = true;
  let LW = 1;
  /** Ayudas de edición (etiqueta vacía): en pantalla sí, al exportar el PNG no. */
  let HINTS = false;
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

  // ── Anidado: quién puede contener y quién entra dónde ─────

  /** Tipos que pueden contener hijos. El resto (label, button, list, menu, input...) nunca. */
  const HOST_KINDS = ["container", "window", "tabs-h", "tabs-v", "accordion"];

  /** Tope de anidado: el mismo `MAX_UI_DEPTH` de `src/pizarra/ui.ts`. */
  const MAX_DEPTH = 8;

  /** `true` si el widget puede contener hijos. */
  function hosts(node) {
    return !!node && HOST_KINDS.indexOf(node.kind) >= 0;
  }

  /** Número de ancestros: la raíz tiene 0. */
  function depthOf(nodes, node) {
    let d = 0;
    let cur = node;
    // El tope de vueltas es el mismo que el de `place`: un ciclo no cuelga el panel.
    while (cur && cur.parent != null && d < 64) {
      const p = find(nodes, cur.parent);
      if (!p) break;
      d += 1;
      cur = p;
    }
    return d;
  }

  /** Caja útil en absoluto: donde se coloca un hijo y a lo que van relativas sus `x`/`y`. */
  function contentRect(nodes, node) {
    if (!node) return { x: 0, y: 0, w: 0, h: 0 };
    const b = place(nodes, node);
    const cb = contentBox(node);
    return { x: b.x + cb.dx, y: b.y + cb.dy, w: cb.w, h: cb.h };
  }

  /** El widget y todo lo que cuelga de él: nadie se mete dentro de sí mismo ni de un hijo. */
  function rama(nodes, node) {
    const ids = {};
    if (!node) return ids;
    const all = nodes || [];
    const pila = [node.id];
    while (pila.length) {
      const id = pila.pop();
      if (ids[id]) continue;
      ids[id] = true;
      for (let i = 0; i < all.length; i++) {
        if (all[i] && all[i].parent === id) pila.push(all[i].id);
      }
    }
    return ids;
  }

  /**
   * Contenedor hospedable más cercano bajo el punto: parte del golpe y sube por `parent`.
   * `excluir` veta ese widget y su rama; los vetados se saltan en el golpe, no valen como
   * tapadera. `null` si no hay ninguno.
   *
   * Aquí no sirve `hit`: al arrastrar, el widget sigue al puntero y siempre está encima, así
   * que el golpe devolvería el que se mueve y su rama vetada taparía el destino de debajo.
   */
  function hostAt(nodes, x, y, excluir) {
    const vetado = excluir ? rama(nodes, excluir) : null;
    const order = paintOrder(nodes);
    // Mismo criterio que `hit`: el último pintado es el primero en recibir el golpe.
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      if (vetado && vetado[n.id]) continue;
      const b = place(nodes, n);
      if (b.w <= 0 || b.h <= 0) continue;
      if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) continue;
      let cur = n;
      let guard = 0;
      while (cur && guard++ < 64) {
        if (hosts(cur) && !(vetado && vetado[cur.id])) return cur;
        cur = cur.parent == null ? null : find(nodes, cur.parent);
      }
    }
    return null;
  }

  /**
   * Reparenta conservando la posición: `x`/`y` absolutos del punto donde se suelta.
   * Con `host` nulo el widget vuelve a la raíz y se queda con coordenadas absolutas; dentro,
   * quedan relativas a la caja útil del contenedor y nunca por debajo de 0.
   */
  function adopt(nodes, node, host, x, y) {
    if (!node) return;
    if (host && rama(nodes, node)[host.id]) return;
    const util = host ? contentRect(nodes, host) : null;
    node.parent = host ? host.id : null;
    node.x = host ? Math.max(0, num(x, 0) - util.x) : num(x, 0);
    node.y = host ? Math.max(0, num(y, 0) - util.y) : num(y, 0);
  }

  /** Saca el widget a la raíz sin moverlo de donde se ve. */
  function detach(nodes, node) {
    if (!node) return;
    const caja = place(nodes, node);
    adopt(nodes, node, null, caja.x, caja.y);
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
      if (rows <= 0) return "body";
      // `orientation: "h"` reparte las entradas en columnas: manda la `x` y no la fila.
      // Mismo ancho que `paintMenu` (`w / entradas`), sin suelo de 1 px: con 9 entradas en 8 px
      // el suelo desalineaba el golpe de la pintura.
      if (n.orientation === "h") {
        const ancho = Math.max(0.000001, num(n.w, 1) / rows);
        const col = Math.floor(lx / ancho);
        return col >= 0 && col < rows ? "row:" + col : "body";
      }
      const i = Math.floor(ly / ROW_H);
      return i >= 0 && i < rows ? "row:" + i : "body";
    }
    if (k === "choice") {
      const rows = count(n.options);
      const i = Math.floor(ly / ROW_H);
      return i >= 0 && i < rows ? "check:" + i : "body";
    }
    if (k === "list") {
      // Misma fila que pinta `paintList`: el alto manda y lo que sobra por abajo es `body`.
      const rows = count(n.items);
      if (rows <= 0) return "body";
      const i = Math.floor(ly / ROW_H);
      // Una fila que `paintList` no llega a pintar porque el widget la corta no se golpea.
      return i >= 0 && i < rows && (i + 1) * ROW_H <= num(n.h, 1) ? "row:" + i : "body";
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
    // Sin color no se rellena: `fill:"none"` deja ver lo de debajo.
    if (!color) return;
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

  /** Recorte aproximado por caracteres, con la métrica proporcional al cuerpo del texto. */
  function cut(str, w, font) {
    const m = /(\d+(?:\.\d+)?)px/.exec(font || FONT);
    const size = m ? parseFloat(m[1]) : 12;
    // 6,6 px por carácter es la métrica de 12 px.
    const max = Math.max(1, Math.floor(w / (6.6 * (size / 12))));
    return str.length > max ? str.slice(0, Math.max(1, max - 1)) + "…" : str;
  }

  /** Texto centrado vertical en `y`; `x` es el borde izquierdo del hueco de ancho `w`. */
  function text(ctx, str, x, y, w, color, font, align) {
    if (!FINE || str == null || str === "" || w < 2) return;
    const s = cut(String(str), w, font || FONT);
    ctx.fillStyle = color || INK;
    ctx.font = font || FONT;
    ctx.textBaseline = "middle";
    ctx.textAlign = align || "left";
    ctx.fillText(s, align === "center" ? x + w / 2 : align === "right" ? x + w : x, y);
  }

  // ── Personalización del widget ─────────────────────────────

  function isHex(v) {
    return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
  }

  /** Relleno: `none` no rellena, un hex manda y `auto` deja el de su tipo (`auto`). */
  function fillOf(n, auto) {
    if (n.fill === "none") return null;
    // Apagado: todo gris claro, los colores declarados no cuentan.
    return !n.disabled && isHex(n.fill) ? n.fill : auto;
  }

  /** Relleno de la marca de activo: el de siempre; con `fill:"none"` no se pinta nada. */
  function markFill(n, auto) {
    return n.fill === "none" ? null : auto;
  }

  /** Tinta de los trazos: el hex declarado o la de siempre (el apagado no lo hereda). */
  function strokeOf(n, ink) {
    return !n.disabled && isHex(n.stroke) ? n.stroke : ink;
  }

  /**
   * Marco exterior: `stroke:"none"` lo quita. Un tipo que no lo lleva (`drawn` falso)
   * solo lo estrena si se pide un color distinto del de tinta: el saneado siempre manda
   * un hex, y con el de por defecto el widget tiene que verse como siempre.
   */
  function outerFrame(ctx, n, x, y, w, h, ink, drawn) {
    if (n.stroke === "none") return;
    if (!drawn && (!isHex(n.stroke) || n.stroke.toLowerCase() === INK)) return;
    frame(ctx, x, y, w, h, strokeOf(n, ink));
  }

  /** Tinta del texto propio del widget; `disabled` la aplasta. */
  function titleInk(n, ink) {
    return !n.disabled && isHex(n.titleColor) ? n.titleColor : ink;
  }

  /** Cuerpo del texto propio: `titleSize` entre 8 y 48; sin él, el de siempre. */
  function fontOf(n, base) {
    const size = Math.round(num(n.titleSize, base));
    return (size < 8 ? 8 : size > 48 ? 48 : size) + "px sans-serif";
  }

  /** Marco discontinuo fino de las ayudas de edición. */
  function dashedBox(ctx, x, y, w, h, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = LW;
    if (ctx.setLineDash) ctx.setLineDash([4, 4]);
    ctx.strokeRect(x, y, w, h);
    if (ctx.setLineDash) ctx.setLineDash([]);
  }

  function paintContainer(ctx, n, x, y, w, h, ink) {
    fillBox(ctx, x, y, w, h, fillOf(n, null));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    if (n.title) text(ctx, n.title, x + 4, y + 9, w - 8, titleInk(n, ink), fontOf(n, 11), "left");
  }

  function paintWindow(ctx, n, x, y, w, h, ink) {
    const soft = n.disabled ? PAPER : SOFT;
    const fg = strokeOf(n, ink);
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    fillBox(ctx, x, y, w, TITLE_H, fillOf(n, soft));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    line(ctx, x, y + TITLE_H, x + w, y + TITLE_H, fg);
    if (FINE) {
      dot(ctx, x + 11, y + TITLE_H / 2, 3, fg);
      dot(ctx, x + 21, y + TITLE_H / 2, 3, fg);
      dot(ctx, x + 31, y + TITLE_H / 2, 3, fg);
    }
    text(ctx, n.title, x + 40, y + TITLE_H / 2, Math.max(2, w - 80), titleInk(n, ink), fontOf(n, 11), "center");
  }

  function paintTabsH(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const m = items.length;
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    const fg = strokeOf(n, ink);
    const mark = markFill(n, PAPER);
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    fillBox(ctx, x, y, w, STRIP_H, fillOf(n, soft));
    const tw = m > 0 ? w / m : w;
    for (let i = 0; i < m; i++) {
      const tx = x + i * tw;
      if (i === act) fillBox(ctx, tx + LW, y + LW, Math.max(1, tw - LW * 2), STRIP_H, mark);
      // los tabiques de la tira son detalle interno: se trazan siempre
      frame(ctx, tx, y, tw, STRIP_H, fg);
      text(ctx, items[i], tx + 4, y + STRIP_H / 2, Math.max(2, tw - 8), titleInk(n, ink), fontOf(n, 11), "center");
    }
    // cuerpo, con la línea de arriba abierta bajo la pestaña activa
    outerFrame(ctx, n, x, y + STRIP_H, w, Math.max(1, h - STRIP_H), ink, true);
    if (act >= 0 && act < m) {
      fillBox(ctx, x + act * tw + LW, y + STRIP_H - LW, Math.max(1, tw - LW * 2), LW * 2, mark);
    }
  }

  function paintTabsV(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const m = items.length;
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    const fg = strokeOf(n, ink);
    const mark = markFill(n, PAPER);
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    fillBox(ctx, x, y, STRIP_V, h, fillOf(n, soft));
    const th = m > 0 ? h / m : h;
    for (let i = 0; i < m; i++) {
      const ty = y + i * th;
      if (i === act) fillBox(ctx, x + LW, ty + LW, STRIP_V - LW * 2, Math.max(1, th - LW * 2), mark);
      frame(ctx, x, ty, STRIP_V, th, fg);
      text(ctx, items[i], x + 8, ty + th / 2, STRIP_V - 14, titleInk(n, ink), fontOf(n, 11), "left");
    }
    outerFrame(ctx, n, x + STRIP_V, y, Math.max(1, w - STRIP_V), h, ink, true);
    if (act >= 0 && act < m) {
      fillBox(ctx, x + STRIP_V - LW, y + act * th + LW, LW * 2, Math.max(1, th - LW * 2), mark);
    }
  }

  function paintAccordion(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const rows = items.length;
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    const fg = strokeOf(n, ink);
    const mark = markFill(n, soft);
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    for (let i = 0; i < rows; i++) {
      const ry = y + i * ACC_H;
      if (ry + ACC_H > y + h) break;
      if (i === act) fillBox(ctx, x + LW, ry + LW, Math.max(1, w - LW * 2), ACC_H - LW, mark);
      line(ctx, x, ry + ACC_H, x + w, ry + ACC_H, fg);
      text(ctx, i === act ? "▾" : "▸", x + 6, ry + ACC_H / 2, 12, titleInk(n, ink), fontOf(n, 11), "left");
      text(ctx, items[i], x + 22, ry + ACC_H / 2, Math.max(2, w - 28), titleInk(n, ink), fontOf(n, 11), "left");
    }
    const by = y + rows * ACC_H;
    if (h - rows * ACC_H > 0) frame(ctx, x, by, w, h - rows * ACC_H, fg);
  }

  function paintMenu(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    const fg = strokeOf(n, ink);
    const mark = markFill(n, soft);
    const tcol = titleInk(n, ink);
    const font = fontOf(n, 12);
    const horizontal = n.orientation === "h";
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    if (items.length === 0) {
      // Menú vacío: una fila con su raya corta para que se vea y se pueda seleccionar.
      const ry = y + (horizontal ? h / 2 : Math.min(ROW_H, h) / 2);
      const rx0 = x + Math.min(8, w / 2);
      line(ctx, rx0, ry, Math.max(rx0 + 1, x + Math.min(w - 4, 40)), ry, fg);
    } else if (horizontal) {
      // Raya horizontal: una columna por entrada, el ancho repartido. Mismo reparto que el
      // golpe de `partAt`, así con muchas entradas en una caja estrecha no se desalinean.
      const cw = Math.max(0.000001, w / items.length);
      for (let i = 0; i < items.length; i++) {
        const cx = x + i * cw;
        if (i === act) fillBox(ctx, cx + LW, y + LW, Math.max(1, cw - LW * 2), Math.max(1, h - LW * 2), mark);
        if (i > 0) line(ctx, cx, y + LW, cx, y + h - LW, fg);
        text(ctx, items[i], cx + 4, y + h / 2, Math.max(2, cw - 8), tcol, font, "center");
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        const ry = y + i * ROW_H;
        if (ry + ROW_H > y + h) break;
        if (i === act) fillBox(ctx, x + LW, ry + LW, Math.max(1, w - LW * 2), ROW_H - LW, mark);
        text(ctx, items[i], x + 8, ry + ROW_H / 2, Math.max(2, w - 16), tcol, font, "left");
        line(ctx, x, ry + ROW_H, x + w, ry + ROW_H, fg);
      }
    }
    outerFrame(ctx, n, x, y, w, h, ink, true);
  }

  /** Ancho del carril de la barra de desplazamiento simulada de `list`. */
  const SCROLL_W = 6;

  function paintList(ctx, n, x, y, w, h, ink) {
    const items = n.items || [];
    const act = idx(n.active);
    const soft = n.disabled ? PAPER : SOFT;
    const mark = markFill(n, soft);
    const tcol = titleInk(n, ink);
    const font = fontOf(n, 12);
    const fg = strokeOf(n, ink);
    const conIconos = n.icons === true;
    const carril = n.scroll === true;
    // El carril come del borde derecho del texto y le deja 8 px de margen.
    const ancho = Math.max(2, w - (carril ? SCROLL_W + 8 : 0));
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    if (items.length === 0) {
      // Lista vacía: la caja sola y, como ayuda de edición, la palabra que la nombra.
      if (HINTS) text(ctx, "lista", x + 4, y + h / 2, Math.max(2, w - 8), MUTE, font, "center");
      return;
    }
    const lado = Math.min(14, ROW_H - 8);
    for (let i = 0; i < items.length; i++) {
      const ry = y + i * ROW_H;
      if (ry + ROW_H > y + h) break;
      if (i === act) fillBox(ctx, x + LW, ry + LW, Math.max(1, w - LW * 2), ROW_H - LW, mark);
      let tx = x + 8;
      if (conIconos) {
        const glifo = GLYPHS[n.icon];
        if (Array.isArray(glifo)) trazaIcono(ctx, glifo, x + 8, ry + (ROW_H - lado) / 2, lado, tcol);
        else if (typeof glifo === "string" && glifo) {
          text(ctx, glifo, x + 8, ry + ROW_H / 2, lado, tcol, Math.round(lado) + "px sans-serif", "center");
        } else {
          // Sin icono elegido no hay glifo: un hueco de 8 px para que la fila no salga corrida.
          frame(ctx, x + 8 + (lado - 8) / 2, ry + (ROW_H - 8) / 2, 8, 8, fg);
        }
        tx = x + 8 + lado + 6;
      }
      // En una caja más estrecha que el hueco del icono, el texto no cabe: se omite en vez de salir.
      if (tx < x + ancho) {
        text(ctx, items[i], tx, ry + ROW_H / 2, Math.max(2, x + ancho - tx), tcol, i === act ? "bold " + font : font, "left");
      }
      line(ctx, x, ry + ROW_H, x + w, ry + ROW_H, fg);
    }
    if (carril) {
      // Carril pegado al borde derecho; el pulgar mide lo que cabe del contenido.
      const rx = x + w - SCROLL_W - LW;
      const ry0 = y + LW;
      const rh = Math.max(1, h - LW * 2);
      frame(ctx, rx, ry0, SCROLL_W, rh, fg);
      const alto = rh * Math.min(1, Math.max(0.15, h / (items.length * ROW_H)));
      fillBox(ctx, rx + LW, ry0 + LW, Math.max(1, SCROLL_W - LW * 2), Math.max(1, alto - LW * 2), fg);
    }
  }

  function paintLabel(ctx, n, x, y, w, h, ink) {
    fillBox(ctx, x, y, w, h, fillOf(n, null));
    outerFrame(ctx, n, x, y, w, h, ink, false);
    if (n.text) {
      text(ctx, n.text, x, y + h / 2, w, titleInk(n, ink), fontOf(n, 12), n.align || "left");
      return;
    }
    // Etiqueta vacía: marco discontinuo y palabra de relleno, solo como ayuda de edición.
    if (!HINTS) return;
    dashedBox(ctx, x, y, w, h, MUTE);
    text(ctx, "etiqueta", x + 4, y + h / 2, Math.max(2, w - 8), MUTE, fontOf(n, 12), "left");
  }

  function paintInput(ctx, n, x, y, w, h, ink) {
    const tieneTexto = n.text != null && n.text !== "";
    const str = tieneTexto ? n.text : n.placeholder;
    // El texto propio se tiñe con `titleColor`; la pista del campo se queda en su gris.
    const color = tieneTexto ? titleInk(n, ink) : n.disabled ? OFF : MUTE;
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    // Flecha al final: el mismo campo con aspecto de desplegable. No abre nada, y en una caja
    // más estrecha que la flecha no se pinta: se saldría del marco.
    const flecha = Boolean(n.dropdown) && w >= 24;
    if (flecha) {
      const ax = x + w - 16;
      const ay = y + h / 2 - 2;
      const tinta = n.disabled ? OFF : strokeOf(n, ink);
      line(ctx, ax, ay, ax + 4, ay + 4, tinta);
      line(ctx, ax + 4, ay + 4, ax + 8, ay, tinta);
    }
    text(ctx, str, x + 8, y + h / 2, Math.max(2, w - 16 - (flecha ? 20 : 0)), color, fontOf(n, 12), "left");
  }

  function paintTextarea(ctx, n, x, y, w, h, ink) {
    const tieneTexto = n.text != null && n.text !== "";
    const str = tieneTexto ? n.text : n.placeholder;
    const color = tieneTexto ? titleInk(n, ink) : n.disabled ? OFF : MUTE;
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    text(ctx, str, x + 8, y + Math.min(h / 2, 12), Math.max(2, w - 16), color, fontOf(n, 12), "left");
  }

  function paintChoice(ctx, n, x, y, w, h, ink) {
    const opts = n.options || [];
    const checked = Array.isArray(n.checked) ? n.checked : [];
    const radio = n.variant === "radio";
    const fg = strokeOf(n, ink);
    fillBox(ctx, x, y, w, h, fillOf(n, null));
    outerFrame(ctx, n, x, y, w, h, ink, false);
    for (let i = 0; i < opts.length; i++) {
      const ry = y + i * ROW_H;
      if (ry + ROW_H > y + h) break;
      const cy = ry + ROW_H / 2;
      const cx = x + 6;
      if (radio) {
        ring(ctx, cx + 6, cy, 6, fg);
        if (checked.indexOf(i) >= 0) dot(ctx, cx + 6, cy, 2.5, fg);
      } else {
        frame(ctx, cx, cy - 6, 12, 12, fg);
        if (checked.indexOf(i) >= 0) {
          line(ctx, cx + 2, cy, cx + 5, cy + 3.5, fg);
          line(ctx, cx + 5, cy + 3.5, cx + 10, cy - 3.5, fg);
        }
      }
      text(ctx, opts[i], x + 24, cy, Math.max(2, w - 30), titleInk(n, ink), fontOf(n, 12), "left");
    }
  }

  function paintButton(ctx, n, x, y, w, h, ink) {
    const r = 6;
    const auto = n.variant === "primary" && !n.disabled ? SOFT : PAPER;
    const relleno = fillOf(n, auto);
    shape(ctx, x, y, w, h, r);
    if (relleno) {
      ctx.fillStyle = relleno;
      ctx.fill();
    }
    if (n.stroke !== "none") {
      ctx.strokeStyle = strokeOf(n, ink);
      ctx.lineWidth = LW;
      ctx.stroke();
    }
    text(ctx, n.text, x + 8, y + h / 2, Math.max(2, w - 16), titleInk(n, ink), fontOf(n, 12), "center");
  }

  /**
   * Pinta un icono de trazos con coordenadas de 24×24, escalado a la caja que se le da.
   * Sin `Path2D` ni `arc`: aquí solo hay un `ctx` y `M`/`L`/`Q`/`Z`.
   */
  function trazaIcono(ctx, tramos, x, y, lado, color) {
    if (!ctx.beginPath || !ctx.moveTo || !ctx.lineTo) return;
    const k = lado / 24;
    ctx.save();
    if (ctx.translate) ctx.translate(x, y);
    if (ctx.scale) ctx.scale(k, k);
    ctx.strokeStyle = color;
    ctx.lineWidth = LW / Math.max(0.01, k);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const tramo of tramos) {
      ctx.beginPath();
      for (const paso of tramo) {
        if (paso[0] === "M") ctx.moveTo(paso[1], paso[2]);
        else if (paso[0] === "L") ctx.lineTo(paso[1], paso[2]);
        else if (paso[0] === "Q") {
          if (ctx.quadraticCurveTo) ctx.quadraticCurveTo(paso[1], paso[2], paso[3], paso[4]);
          else ctx.lineTo(paso[3], paso[4]);
        } else if (paso[0] === "Z" && ctx.closePath) ctx.closePath();
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function paintIcon(ctx, n, x, y, w, h, ink) {
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
    outerFrame(ctx, n, x, y, w, h, ink, true);
    if (!FINE) return;
    const nombre = n.icon || "";
    // El bloque TEXTO también manda aquí: `titleSize` escala el glifo y `titleColor` lo tiñe.
    const escala = Math.max(0.45, Math.min(3, num(n.titleSize, 12) / 12));
    const lado = Math.max(8, Math.min(Math.min(w, h) - 4, Math.min(w, h) * 0.6 * escala));
    const color = titleInk(n, ink);
    const glifo = GLYPHS[nombre];
    if (Array.isArray(glifo)) {
      trazaIcono(ctx, glifo, x + (w - lado) / 2, y + (h - lado) / 2, lado, color);
      return;
    }
    if (!nombre) return;
    text(ctx, typeof glifo === "string" ? glifo : nombre, x + 2, y + h / 2, Math.max(2, w - 4), color, Math.round(lado) + "px sans-serif", "center");
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
    const fg = strokeOf(n, ink);
    fillBox(ctx, x, y, w, h, fillOf(n, PAPER));
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
      line(ctx, x, y, x + w, y + h, fg);
      line(ctx, x + w, y, x, y + h, fg);
    }
    outerFrame(ctx, n, x, y, w, h, ink, true);
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
        case "list":
          paintList(ctx, node, x, y, w, h, ink);
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
  function draw(ctx, nodes, zoom, imagenes, hints) {
    if (!ctx) return;
    ZOOM = num(zoom, 1) > 0 ? num(zoom, 1) : 1;
    FINE = ZOOM >= 0.5;
    LW = 1 / ZOOM;
    // Ayudas de edición: el panel las enciende en pantalla y las apaga al exportar el PNG.
    HINTS = !!hints;
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
    contentRect: contentRect,
    children: children,
    place: place,
    hit: hit,
    hosts: hosts,
    depthOf: depthOf,
    hostAt: hostAt,
    adopt: adopt,
    detach: detach,
    MAX_DEPTH: MAX_DEPTH,
    click: click,
    draw: draw,
    handlePoints: handlePoints,
  };

  globalThis.PZUi = PZUi;
  if (typeof module !== "undefined") module.exports = PZUi;
})();
