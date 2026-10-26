/* Pizarra — editor de imagen por capas: fondo, imágenes pegadas, trazos y textos
   (ese es el orden de apilado, de abajo arriba).
   El alto interno del lienzo es fijo (1024 px) y el ancho sigue el aspecto real del marco
   (con topes): el lienzo llena el panel en los dos ejes y ese W × H es el PNG exportado.
   El zoom y el paneo son una transform CSS sobre el mundo: no cambian ni un píxel del aplanado. */
(function () {
  const vscode = acquireVsCodeApi();
  /** Alto interno del lienzo: fijo y referencia de la escala. El ancho `W` sigue al marco. */
  const SIZE = 1024;
  const H = SIZE;
  /** Topes del ancho del lienzo: fuera no se dibuja, dentro se copia el aspecto del panel. */
  const ANCHO_MIN = 256;
  const ANCHO_MAX = 4096;
  let W = SIZE;
  /** Separación del asa de giro respecto al cuadro, en coordenadas del lienzo. */
  const ROT_OFF = 30;
  /** Tamaño del cuadradito de cada asa. */
  const HANDLE = 15;
  /** Color del lienzo recién creado. */
  const BG_DEFAULT = "#ffffff";
  const DEG15 = Math.PI / 12;
  /** Límites y paso de la rueda del zoom. */
  const MIN_Z = 0.15;
  const MAX_Z = 8;
  const ZOOM_PASO = 1.15;

  const el = {
    root: document.querySelector(".pz"),
    frame: document.querySelector(".pz-frame"),
    world: document.getElementById("world"),
    board: document.getElementById("board"),
    overlay: document.getElementById("overlay"),
    editor: document.getElementById("text-editor"),
    status: document.getElementById("status"),
    medida: document.querySelector(".pz-medida"),
    btnZoom: document.getElementById("btn-zoom"),
    modal: document.getElementById("modal"),
    modalText: document.getElementById("modal-text"),
    modalOk: document.getElementById("modal-ok"),
    modalCancel: document.getElementById("modal-cancel"),
    btnNew: document.getElementById("btn-new"),
    btnPaste: document.getElementById("btn-paste"),
    btnSave: document.getElementById("btn-save"),
    penColor: document.getElementById("pen-color"),
    penSize: document.getElementById("pen-size"),
    erSize: document.getElementById("er-size"),
    erHard: document.getElementById("er-hard"),
    txtColor: document.getElementById("txt-color"),
    txtFamily: document.getElementById("txt-family"),
    txtSize: document.getElementById("txt-size"),
    tools: Array.from(document.querySelectorAll(".tool")),
    opts: Array.from(document.querySelectorAll(".pz-group.opt")),
    layers: Array.from(document.querySelectorAll(".pz-layer")),
  };

  const ctx = el.board.getContext("2d");
  const octx = el.overlay.getContext("2d");
  // Medidor aparte: no pisa el pincel del lienzo.
  const measure = document.createElement("canvas").getContext("2d");

  /** Trazos ya confirmados: el borrador actúa aquí con destination-out. */
  const committed = document.createElement("canvas");
  committed.width = W;
  committed.height = H;
  const cctx = committed.getContext("2d");
  /** Copia de lo confirmado más el trazo en curso, para verlo sin tocar lo de abajo. */
  const live = document.createElement("canvas");
  live.width = W;
  live.height = H;
  const lctx = live.getContext("2d");

  const state = {
    bg: { color: BG_DEFAULT, image: null },
    strokes: [],
    images: [],
    texts: [],
  };

  let tool = "select";
  let sel = null;
  /** Bloque de texto que se está escribiendo en el área flotante. */
  let editing = null;
  /** Trazo o manipulación en curso. */
  let drag = null;
  let snapshotTimer = 0;
  let dirty = false;
  /** Encuadre: escala `z` y desplazamiento en píxeles de pantalla, aplicados por CSS. */
  const view = { z: 1, tx: 0, ty: 0 };
  /** Barra espaciadora pulsada: el arrastre panea en vez de dibujar o seleccionar. */
  let espacio = false;
  /** El cierre del mini-modal abierto, si lo hay: lo usa Escape. */
  let cerrarModal = null;
  /** La carga de la copia de trabajo: `capture` espera a que termine. */
  let cargando = null;

  // ── Utilidades ────────────────────────────────────────────

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = "pz-status" + (kind ? " " + kind : "");
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Puntero a coordenadas del lienzo: mide el rect del canvas, que ya refleja el zoom y el paneo. */
  function toCanvas(event) {
    const rect = el.board.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (W / (rect.width || W)),
      y: (event.clientY - rect.top) * (H / (rect.height || H)),
    };
  }

  /** Factor canvas→píxeles de pantalla ya aplicado (incluye el zoom): sirve para el puntero y las asas. */
  function pantallaEscala() {
    const rect = el.board.getBoundingClientRect();
    return (rect.width || W) / W;
  }

  /**
   * Factor canvas→píxeles de LAYOUT, sin el zoom. El área de edición vive dentro del mundo, así
   * que se dimensiona aquí y la transform se encarga del resto: con la escala de pantalla el
   * textarea saldría doble de grande al acercar.
   */
  function layoutEscala() {
    return (el.board.offsetWidth || W) / W;
  }

  /** Paso de rueda: hacia arriba acerca, hacia abajo aleja. Dentro de los límites. */
  function pasoZoom(z, deltaY) {
    return clamp(deltaY < 0 ? z * ZOOM_PASO : z / ZOOM_PASO, MIN_Z, MAX_Z);
  }

  /**
   * Nueva vista al escalar a `z2` dejando el punto (mx,my) del marco bajo el cursor.
   * Orden translate→scale: pantalla = t + z·layout, despejando t' = m - (m - t)·(z2/z).
   */
  function zoomEn(z, tx, ty, z2, mx, my) {
    const k = z2 / z;
    return { z: z2, tx: mx - (mx - tx) * k, ty: my - (my - ty) * k };
  }

  /** Se aplica la vista al mundo y al rótulo del botón de zoom. */
  function aplicaVista() {
    el.world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
    el.btnZoom.textContent = `ZOOM ${Math.round(view.z * 100)}%`;
  }

  /** Origen del layout dentro del marco: su caja de padding, sin el borde de 1 px. */
  function origenMarco() {
    const rect = el.frame.getBoundingClientRect();
    return { x: rect.left + (el.frame.clientLeft || 0), y: rect.top + (el.frame.clientTop || 0) };
  }

  /** Puntero en píxeles del marco: la referencia que ancla `zoomEn` bajo la rueda. */
  function marcoPunto(event) {
    const o = origenMarco();
    return { x: event.clientX - o.x, y: event.clientY - o.y };
  }

  function fontOf(t) {
    return `${t.size}px ${t.family}`;
  }

  function hasContent() {
    return Boolean(
      state.strokes.length ||
        state.images.length ||
        state.texts.length ||
        state.bg.image ||
        state.bg.color !== BG_DEFAULT
    );
  }

  /**
   * Cambia el mapa de bits de un lienzo conservando lo dibujado arriba-izquierda: se copia a un
   * transitorio ANTES de asignar `width` (asignarlo borra el contenido) y se devuelve después.
   */
  function cambiarTamañoLienzo(node, w, h) {
    if (node.width === w && node.height === h) return;
    const scratch = document.createElement("canvas");
    scratch.width = node.width;
    scratch.height = node.height;
    scratch.getContext("2d").drawImage(node, 0, 0);
    node.width = w;
    node.height = h;
    node.getContext("2d").drawImage(scratch, 0, 0);
  }

  /** El rótulo de la cabecera refleja el tamaño real del lienzo exportado. */
  function pintaMedida() {
    el.medida.textContent = `Lienzo ${W} × ${H}`;
  }

  /**
   * Alto fijo (H); el ancho se saca del aspecto del marco: así la unidad de lienzo conserva su
   * tamaño relativo en Y y la escala CSS→lienzo sale uniforme en los dos ejes.
   * `clientWidth/Height`: caja de contenido sin el borde de 1 px, que falsearía el aspecto.
   * `sinMarcar`: en el arranque el lienzo aún no tiene nada que conservar en la copia.
   */
  function medirMarco(sinMarcar) {
    const cw = el.frame.clientWidth;
    const ch = el.frame.clientHeight;
    if (!cw || !ch) return; // panel oculto: nada que recalcular
    const w = clamp(Math.round((H * cw) / ch), ANCHO_MIN, ANCHO_MAX);
    if (w === W) return; // solo cambia el tamaño sin cambiar el aspecto: no se toca nada
    W = w;
    for (const node of [el.board, el.overlay, committed, live]) cambiarTamañoLienzo(node, W, H);
    pintaMedida();
    if (editing) {
      colocaEditor(editing);
      growEditor();
    }
    if (sinMarcar) redraw();
    else changed(); // la copia de trabajo tiene que reflejar el nuevo tamaño
  }

  // ── Imágenes ──────────────────────────────────────────────

  /** Encaja dentro del lienzo sin deformarla y centrada. */
  function fitInside(w, h) {
    const k = Math.min(W / w, H / h, 1);
    const nw = Math.max(1, Math.round(w * k));
    const nh = Math.max(1, Math.round(h * k));
    return { w: nw, h: nh, x: Math.round((W - nw) / 2), y: Math.round((H - nh) / 2) };
  }

  /** Decodifica una data URL con `Image`: `fetch` de `data:` lo corta la CSP. */
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("No se pudo leer la imagen."));
      img.src = dataUrl;
    });
  }

  /** Añade una imagen decodificada como objeto de la capa IMÁGENES, centrada y ajustada. */
  function addImage(drawable, w, h) {
    const box = fitInside(w, h);
    const obj = { type: "image", drawable, w: box.w, h: box.h, x: box.x, y: box.y, rot: 0 };
    state.images.push(obj);
    setTool("select");
    select(obj);
    changed();
    setStatus(`Imagen añadida: ${w} × ${h}.`, "ok");
  }

  /** Saca la imagen del portapapeles del evento `paste` (la API de clipboard está bloqueada). */
  async function pasteImage(clipboard) {
    if (!clipboard) return false;
    let blob = null;
    for (const item of clipboard.items || []) {
      if (item.kind === "file" && String(item.type).indexOf("image/") === 0) {
        blob = item.getAsFile();
        break;
      }
    }
    if (!blob) return false;
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      setStatus("El portapapeles trae una imagen que no se puede leer.", "error");
      return true;
    }
    addImage(bitmap, bitmap.width, bitmap.height);
    return true;
  }

  // ── Trazos ────────────────────────────────────────────────

  function newStroke(kind, p) {
    if (kind === "pen") {
      return { erase: false, color: el.penColor.value, size: Number(el.penSize.value), hard: 1, pts: [p] };
    }
    return {
      erase: true,
      color: "#000",
      size: Number(el.erSize.value),
      hard: clamp(Number(el.erHard.value) / 100, 0, 0.95),
      pts: [p],
    };
  }

  /** Sellitos con degradado radial: así la dureza se nota en el borde del borrador. */
  function eraseSegment(target, stroke, from, to) {
    const r = stroke.size / 2;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 3)));
    target.save();
    target.globalCompositeOperation = "destination-out";
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      const x = from.x + (to.x - from.x) * k;
      const y = from.y + (to.y - from.y) * k;
      const grad = target.createRadialGradient(x, y, r * stroke.hard, x, y, r);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      target.fillStyle = grad;
      target.beginPath();
      target.arc(x, y, r, 0, Math.PI * 2);
      target.fill();
    }
    target.restore();
  }

  function drawSegment(target, stroke, from, to) {
    if (stroke.erase) {
      eraseSegment(target, stroke, from, to);
      return;
    }
    target.save();
    target.strokeStyle = stroke.color;
    target.lineWidth = stroke.size;
    target.lineCap = "round";
    target.lineJoin = "round";
    target.beginPath();
    target.moveTo(from.x, from.y);
    target.lineTo(to.x, to.y);
    target.stroke();
    target.restore();
  }

  /** Rehace la capa de trazos desde cero (un clic sin arrastrar es un solo punto). */
  function replayStrokes() {
    cctx.clearRect(0, 0, W, H);
    for (const stroke of state.strokes) {
      const pts = stroke.pts;
      if (pts.length < 2) {
        if (pts.length) drawSegment(cctx, stroke, pts[0], { x: pts[0].x + 0.01, y: pts[0].y });
        continue;
      }
      for (let i = 1; i < pts.length; i++) drawSegment(cctx, stroke, pts[i - 1], pts[i]);
    }
  }

  // ── Textos ────────────────────────────────────────────────

  /** Reparte el texto en líneas cabiendo en el ancho; conserva los saltos de línea. */
  function layout(t) {
    measure.font = fontOf(t);
    const lineH = Math.max(1, Math.round(t.size * 1.25));
    const lines = [];
    for (const para of String(t.text).split("\n")) {
      if (para === "") {
        lines.push("");
        continue;
      }
      let cur = "";
      for (const word of para.split(" ")) {
        const trial = cur ? cur + " " + word : word;
        if (!cur || measure.measureText(trial).width <= t.w) {
          cur = trial;
        } else {
          lines.push(cur);
          cur = word;
        }
        // Una palabra más ancha que el cuadro se parte para no desbordar.
        while (cur.length > 1 && measure.measureText(cur).width > t.w) {
          let cut = cur.length - 1;
          while (cut > 1 && measure.measureText(cur.slice(0, cut)).width > t.w) cut--;
          lines.push(cur.slice(0, cut));
          cur = cur.slice(cut);
        }
      }
      lines.push(cur);
    }
    t.h = Math.max(lineH, lines.length * lineH);
    return { lines, lineH };
  }

  function drawText(t) {
    const m = layout(t);
    ctx.save();
    ctx.translate(t.x + t.w / 2, t.y + t.h / 2);
    ctx.rotate(t.rot);
    ctx.font = fontOf(t);
    ctx.fillStyle = t.color;
    ctx.textBaseline = "top";
    let y = -t.h / 2;
    for (const line of m.lines) {
      ctx.fillText(line, -t.w / 2, y);
      y += m.lineH;
    }
    ctx.restore();
  }

  // ── Composición ───────────────────────────────────────────

  function compose() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = state.bg.color;
    ctx.fillRect(0, 0, W, H);
    const bg = state.bg.image;
    if (bg) {
      const box = fitInside(bg.width, bg.height);
      ctx.drawImage(bg.drawable, box.x, box.y, box.w, box.h);
    }
    // Orden de capas de abajo arriba: FONDO, IMÁGENES, TRAZOS, TEXTOS. El lápiz va encima de
    // lo pegado: si no, una imagen taparía lo dibujado sobre ella.
    for (const img of state.images) {
      ctx.save();
      ctx.translate(img.x + img.w / 2, img.y + img.h / 2);
      ctx.rotate(img.rot);
      ctx.drawImage(img.drawable, -img.w / 2, -img.h / 2, img.w, img.h);
      ctx.restore();
    }
    // Mientras se dibuja, `live` ya incluye lo confirmado: no se pinta dos veces.
    ctx.drawImage(drag && drag.kind === "draw" ? live : committed, 0, 0);
    for (const t of state.texts) {
      // El bloque en edición lo escribe el `textarea` encima: en pantalla no se pinta (si no,
      // sale doble), pero en el PNG exportado sí tiene que estar.
      if (t !== editing || exportando) drawText(t);
    }
    drawOverlay();
  }

  let framePedida = false;
  /** Durante la exportación se pinta también el texto que se está escribiendo. */
  let exportando = false;
  function redraw() {
    if (framePedida) return;
    framePedida = true;
    requestAnimationFrame(() => {
      framePedida = false;
      compose();
    });
  }

  function pngBase64() {
    // Con el panel oculto no llega el requestAnimationFrame: se compone aquí, con lo que haya
    // pendiente incluido, para no exportar un fotograma viejo.
    framePedida = false;
    exportando = true;
    try {
      compose();
      const url = el.board.toDataURL("image/png");
      return url.slice(url.indexOf(",") + 1);
    } finally {
      // Se vuelve a componer para la pantalla, donde el textarea pisa el bloque en edición,
      // y el flag se suelta también si `toDataURL` falla.
      exportando = false;
      compose();
    }
  }

  function changed() {
    redraw();
    dirty = true;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(flushSnapshot, 600);
  }

  /** `capture` contesta al momento; el resto va con reposo de 600 ms. */
  function flushSnapshot() {
    if (!dirty) return;
    dirty = false;
    vscode.postMessage({ type: "snapshot", png: pngBase64() });
  }

  // ── Capas y herramientas ──────────────────────────────────

  /** Qué capa manda ahora mismo: eso pintan los indicadores. */
  function activeLayer() {
    if (tool === "pen" || tool === "eraser") return "strokes";
    if (tool === "text") return "texts";
    if (!sel) return "";
    return sel.type === "image" ? "images" : "texts";
  }

  function paintLayers() {
    const activa = activeLayer();
    for (const l of el.layers) l.classList.toggle("on", l.dataset.layer === activa);
  }

  function setTool(next) {
    tool = next;
    el.root.dataset.tool = next;
    for (const b of el.tools) b.classList.toggle("on", b.dataset.tool === next);
    for (const g of el.opts) g.classList.toggle("show", g.dataset.for === next);
    if (next !== "select") closeEditor();
    if (next === "text") {
      setStatus("Clic en el lienzo donde escribir; cierra con Ctrl+Enter o Escape.");
    }
    paintLayers();
    redraw();
  }

  // ── Selección: asas, golpe y giro ─────────────────────────

  function world(o, lx, ly) {
    const c = Math.cos(o.rot);
    const s = Math.sin(o.rot);
    return { x: o.x + o.w / 2 + lx * c - ly * s, y: o.y + o.h / 2 + lx * s + ly * c };
  }

  function local(o, p) {
    const c = Math.cos(-o.rot);
    const s = Math.sin(-o.rot);
    const dx = p.x - (o.x + o.w / 2);
    const dy = p.y - (o.y + o.h / 2);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  function corners(o) {
    const hw = o.w / 2;
    const hh = o.h / 2;
    return [world(o, -hw, -hh), world(o, hw, -hh), world(o, hw, hh), world(o, -hw, hh)];
  }

  function handlesOf(o) {
    const hw = o.w / 2;
    const hh = o.h / 2;
    const hs = [];
    if (o.type === "image") {
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach((sign, i) => {
        hs.push({ kind: "scale", corner: i, sx: sign[0], sy: sign[1], p: world(o, (sign[0] * hw), sign[1] * hh) });
      });
    } else {
      hs.push({ kind: "width", side: -1, p: world(o, -hw, 0) });
      hs.push({ kind: "width", side: 1, p: world(o, hw, 0) });
    }
    hs.push({ kind: "rotate", p: world(o, 0, -hh - ROT_OFF) });
    return hs;
  }

  function hitHandle(o, p) {
    const radio = Math.max(HANDLE, 9 / pantallaEscala());
    for (const h of handlesOf(o)) {
      if (Math.abs(p.x - h.p.x) <= radio && Math.abs(p.y - h.p.y) <= radio) return h;
    }
    return null;
  }

  function hitObject(p) {
    // De arriba abajo: TEXTOS es la capa más alta.
    for (const list of [state.texts, state.images]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i];
        if (o.type === "text") layout(o);
        const l = local(o, p);
        if (Math.abs(l.x) <= o.w / 2 && Math.abs(l.y) <= o.h / 2) return o;
      }
    }
    return null;
  }

  function drawOverlay() {
    octx.clearRect(0, 0, W, H);
    if (!sel || tool !== "select") return;
    const cs = corners(sel);
    const hs = handlesOf(sel);
    const rot = hs[hs.length - 1];
    octx.save();
    octx.strokeStyle = "#00e5ff";
    octx.fillStyle = "#00e5ff";
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(cs[0].x, cs[0].y);
    for (let i = 1; i < 4; i++) octx.lineTo(cs[i].x, cs[i].y);
    octx.closePath();
    octx.setLineDash([8, 6]);
    octx.stroke();
    octx.setLineDash([]);
    octx.beginPath();
    octx.moveTo(sel.x + sel.w / 2, sel.y + sel.h / 2);
    octx.lineTo(rot.p.x, rot.p.y);
    octx.stroke();
    for (const h of hs) octx.fillRect(h.p.x - HANDLE / 2, h.p.y - HANDLE / 2, HANDLE, HANDLE);
    octx.restore();
  }

  /** Al elegir un texto, los controles muestran sus valores. */
  function syncTextControls(t) {
    if (!t || t.type !== "text") return;
    el.txtColor.value = t.color;
    el.txtSize.value = t.size;
    document.getElementById("txt-size-out").textContent = String(t.size);
    const opcion = Array.from(el.txtFamily.options).some((o) => o.value === t.family);
    if (opcion) el.txtFamily.value = t.family;
  }

  function select(o) {
    sel = o;
    syncTextControls(o);
    paintLayers();
    redraw();
  }

  function deleteSelected() {
    if (!sel) return;
    const list = sel.type === "image" ? state.images : state.texts;
    const i = list.indexOf(sel);
    if (i >= 0) list.splice(i, 1);
    // Un ImageBitmap pegado ocupa memoria por su cuenta: se cierra antes de soltarlo.
    if (sel.type === "image") sel.drawable.close?.();
    sel = null;
    changed();
  }

  // ── Editor de texto flotante ──────────────────────────────

  /** Coloca el área sobre el bloque. Sólo geometría: no toca el foco ni la selección. */
  function colocaEditor(t) {
    const cs = corners(t);
    const xs = cs.map((c) => c.x);
    const ys = cs.map((c) => c.y);
    const k = layoutEscala();
    const minX = Math.min.apply(null, xs);
    const minY = Math.min.apply(null, ys);
    // El área es el rectángulo envolvente: con el bloque girado es una aproximación,
    // y se ve igual porque la fuente y el alto van escalados con el mismo factor.
    el.editor.style.left = minX * k + "px";
    el.editor.style.top = minY * k + "px";
    el.editor.style.width = Math.max(24, (Math.max.apply(null, xs) - minX) * k) + "px";
    el.editor.style.setProperty("--edit-font", t.family);
    el.editor.style.setProperty("--edit-size", t.size * k + "px");
    el.editor.style.setProperty("--edit-line", Math.round(t.size * 1.25) * k + "px");
    el.editor.style.setProperty("--edit-color", t.color);
  }

  function openEditor(t) {
    layout(t);
    editing = t;
    colocaEditor(t);
    el.editor.value = t.text;
    el.editor.hidden = false;
    growEditor();
    el.editor.focus();
    el.editor.select();
    // La guía de la herramienta TEXTO ya no vale: el área está abierta.
    setStatus("Escribe; cierra con Ctrl+Enter o Escape.");
  }

  function growEditor() {
    el.editor.style.height = "auto";
    el.editor.style.height = el.editor.scrollHeight + "px";
  }

  function closeEditor() {
    if (!editing) return;
    const t = editing;
    editing = null;
    el.editor.hidden = true;
    t.text = el.editor.value;
    if (!t.text.trim()) {
      const i = state.texts.indexOf(t);
      if (i >= 0) state.texts.splice(i, 1);
      if (sel === t) sel = null;
    }
    paintLayers();
    changed();
  }

  /** El paneo manda el cursor: 2 se arrastra, 1 Espacio pulsado, nada si no se panea. */
  function pintaCursorPan() {
    if (drag && drag.kind === "pan") el.root.dataset.pan = "2";
    else if (espacio) el.root.dataset.pan = "1";
    else delete el.root.dataset.pan;
  }

  function soltarEspacio() {
    // `pintaCursorPan` mira el arrastre: si sigue un paneo, el cursor no cambia hasta `onUp`.
    espacio = false;
    pintaCursorPan();
  }

  // ── Puntero ───────────────────────────────────────────────

  function onDown(event) {
    if (event.button !== 0) return;
    // El área de edición es hija del mundo: un clic ahí es suyo, no de la pizarra.
    if (event.target === el.editor) return;
    if (editing) closeEditor();
    // Sin esto, la acción por defecto del clic mueve el foco al body y el `blur` del área
    // cerraría el editor que acabamos de abrir. El paneo y el dibujo usan captura explícita
    // de puntero, que no es una acción por defecto: no se resiente.
    event.preventDefault();
    // `preventDefault` deja el foco donde estaba: sin soltarlo, el guard de INPUT del
    // teclado dejaría el paneo con Espacio muerto tras tocar un deslizador.
    const activo = document.activeElement;
    if (activo && activo !== el.editor && activo !== document.body) activo.blur();
    const p = toCanvas(event);
    el.frame.setPointerCapture(event.pointerId);

    // Espacio pulsado: arrastrar panea el encuadre, no toca el dibujo.
    if (espacio) {
      drag = { kind: "pan", x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
      pintaCursorPan();
      return;
    }

    if (tool === "pen" || tool === "eraser") {
      const stroke = newStroke(tool, p);
      lctx.clearRect(0, 0, W, H);
      lctx.drawImage(committed, 0, 0);
      // Un clic sin arrastrar deja un punto: se materializa como sello redondo.
      drawSegment(lctx, stroke, p, { x: p.x + 0.01, y: p.y });
      drag = { kind: "draw", stroke };
      redraw();
      return;
    }

    if (tool === "text") {
      const t = {
        type: "text",
        text: "",
        x: p.x,
        y: p.y,
        w: 420,
        h: 50,
        rot: 0,
        color: el.txtColor.value,
        size: Number(el.txtSize.value),
        family: el.txtFamily.value,
      };
      state.texts.push(t);
      setTool("select");
      select(t);
      changed();
      openEditor(t);
      return;
    }

    // SELECCIONAR: asas primero, objeto después, nada si se da en el fondo.
    if (sel) {
      const h = hitHandle(sel, p);
      if (h) {
        if (sel.type === "text") layout(sel);
        if (h.kind === "rotate") {
          drag = { kind: "rotate", center: { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 } };
        } else if (h.kind === "width") {
          // El asa mueve el ancho dejando fijo el borde de enfrente.
          drag = { kind: "width", side: h.side, anchor: h.side < 0 ? world(sel, sel.w / 2, 0) : world(sel, -sel.w / 2, 0) };
        } else {
          drag = { kind: "scale", sx: h.sx, sy: h.sy, anchor: corners(sel)[(h.corner + 2) % 4], aspect: sel.w / sel.h };
        }
        return;
      }
    }
    const o = hitObject(p);
    select(o);
    if (o) drag = { kind: "move", last: p };
  }

  function onMove(event) {
    if (!drag) return;

    // El paneo mueve el encuadre en píxeles de pantalla: ni toca el lienzo ni depende de él.
    if (drag.kind === "pan") {
      // El desplazamiento va por delante de la escala: en px de pantalla crudos.
      view.tx = drag.tx + (event.clientX - drag.x);
      view.ty = drag.ty + (event.clientY - drag.y);
      aplicaVista();
      return;
    }

    const p = toCanvas(event);

    if (drag.kind === "draw") {
      const pts = drag.stroke.pts;
      const prev = pts[pts.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1) return;
      pts.push(p);
      drawSegment(lctx, drag.stroke, prev, p);
      redraw();
      return;
    }

    const o = sel;
    if (!o) return;
    if (o.type === "text") layout(o);

    if (drag.kind === "move") {
      o.x += p.x - drag.last.x;
      o.y += p.y - drag.last.y;
      drag.last = p;
      redraw();
      return;
    }

    if (drag.kind === "rotate") {
      let rot = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) + Math.PI / 2;
      if (event.shiftKey) rot = Math.round(rot / DEG15) * DEG15;
      o.rot = rot;
      redraw();
      return;
    }

    // Ejes del objeto en el mundo.
    const ux = Math.cos(o.rot);
    const uy = Math.sin(o.rot);
    const dx = p.x - drag.anchor.x;
    const dy = p.y - drag.anchor.y;

    if (drag.kind === "scale") {
      const vx = -Math.sin(o.rot);
      const vy = Math.cos(o.rot);
      const w = clamp((dx * ux + dy * uy) / drag.sx, 12, W * 2);
      const h = w / (drag.aspect || 1);
      o.w = w;
      o.h = h;
      // El asa de en frente no se mueve: el centro se recomputa desde ella.
      o.x = drag.anchor.x + (ux * drag.sx * w) / 2 + (vx * drag.sy * h) / 2 - w / 2;
      o.y = drag.anchor.y + (uy * drag.sx * w) / 2 + (vy * drag.sy * h) / 2 - h / 2;
      redraw();
      return;
    }

    if (drag.kind === "width") {
      const w = clamp((dx * ux + dy * uy) * drag.side, 30, W * 2);
      o.w = w;
      layout(o);
      const cx = drag.anchor.x + (ux * drag.side * w) / 2;
      const cy = drag.anchor.y + (uy * drag.side * w) / 2;
      o.x = cx - w / 2;
      o.y = cy - o.h / 2;
      redraw();
    }
  }

  function onUp() {
    if (!drag) return;
    if (drag.kind === "pan") {
      // Mover el encuadre no cambia el lienzo: ni `changed` ni copia de trabajo.
      drag = null;
      pintaCursorPan();
      return;
    }
    if (drag.kind === "draw") {
      state.strokes.push(drag.stroke);
      // Lo que se vio durante el arrastre pasa a lo confirmado.
      cctx.clearRect(0, 0, W, H);
      cctx.drawImage(live, 0, 0);
      lctx.clearRect(0, 0, W, H);
    }
    drag = null;
    changed();
  }

  // ── Acciones de la barra ──────────────────────────────────

  function preguntar(texto, okLabel) {
    return new Promise((resolve) => {
      el.modalText.textContent = texto;
      el.modalOk.textContent = okLabel;
      el.modal.hidden = false;
      el.modalOk.focus();
      const cerrar = (value) => {
        el.modal.hidden = true;
        cerrarModal = null;
        el.modalOk.removeEventListener("click", aceptar);
        el.modalCancel.removeEventListener("click", cancelar);
        resolve(value);
      };
      const aceptar = () => cerrar(true);
      const cancelar = () => cerrar(false);
      el.modalOk.addEventListener("click", aceptar);
      el.modalCancel.addEventListener("click", cancelar);
      cerrarModal = cerrar;
    });
  }

  /** Tira trazos, imágenes y textos y deja el fondo en blanco. Sin preguntar. */
  function vaciar() {
    state.bg = { color: BG_DEFAULT, image: null };
    state.strokes = [];
    // Misma razón que en `deleteSelected`: los bitmaps pegados se cierran.
    for (const img of state.images) img.drawable.close?.();
    state.images = [];
    state.texts = [];
    sel = null;
    editing = null;
    el.editor.hidden = true;
    replayStrokes();
  }

  function nuevaEnBlanco() {
    if (!hasContent()) {
      setStatus("La pizarra ya está vacía.");
      return;
    }
    void preguntar("Se tiran todos los trazos, imágenes y textos. ¿Vaciar la pizarra?", "VACIAR").then(
      (aceptar) => {
        if (!aceptar) return;
        vaciar();
        changed();
        setStatus("Pizarra vacía.");
      }
    );
  }

  /**
   * Un clic = pizarra nueva con la imagen del portapapeles de FONDO. La webview no puede leer
   * el portapapeles sin gesto del sistema: se lo pide al host, que contesta con `clipboardImage`
   * o `clipboardEmpty`. El Ctrl+V de siempre sigue añadiendo a la capa IMÁGENES.
   */
  function desdePortapapeles() {
    setStatus("Cogiendo la imagen del portapapeles…");
    vscode.postMessage({ type: "clipboardBg" });
  }

  function guardar() {
    // La extensión escribe el fichero y refresca la copia de trabajo con ese PNG.
    vscode.postMessage({ type: "save", png: pngBase64() });
  }

  // ── Enlaces de interfaz ───────────────────────────────────

  el.tools.forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  el.btnNew.addEventListener("click", nuevaEnBlanco);
  el.btnPaste.addEventListener("click", desdePortapapeles);
  el.btnSave.addEventListener("click", guardar);

  // Cada deslizizador pinta su número al moverlo (el `<output>` de al lado).
  [el.penSize, el.erSize, el.erHard, el.txtSize].forEach((input) => {
    const out = document.getElementById(input.id + "-out");
    const pinta = () => {
      if (out) out.textContent = input.value;
    };
    input.addEventListener("input", pinta);
    pinta();
  });

  // Los controles de texto también sirven sobre lo seleccionado.
  el.txtColor.addEventListener("input", () => {
    if (sel && sel.type === "text") {
      sel.color = el.txtColor.value;
      changed();
    }
  });
  el.txtFamily.addEventListener("input", () => {
    if (sel && sel.type === "text") {
      sel.family = el.txtFamily.value;
      changed();
    }
  });
  el.txtSize.addEventListener("input", () => {
    if (sel && sel.type === "text") {
      sel.size = Number(el.txtSize.value);
      changed();
    }
  });

  el.frame.addEventListener("pointerdown", onDown);
  el.frame.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  // Rueda: acerca y aleja dejando el cursor sobre el mismo punto del lienzo. `passive:false`
  // porque hay que cortar el scroll de la página; la transform CSS no cambia el PNG exportado.
  el.frame.addEventListener(
    "wheel",
    (event) => {
      // Sólo la rueda vertical es zoom: el barrido horizontal del trackpad trae deltaY a 0.
      if (!event.deltaY) return;
      event.preventDefault();
      const m = marcoPunto(event);
      const z2 = pasoZoom(view.z, event.deltaY);
      if (z2 === view.z) return; // en el límite: nada que recalcular
      const nuevo = zoomEn(view.z, view.tx, view.ty, z2, m.x, m.y);
      view.z = nuevo.z;
      view.tx = nuevo.tx;
      view.ty = nuevo.ty;
      // El área de edición es hija del mundo: la transform se la lleva con el lienzo, así que
      // el zoom no la recoloca. Reabrirla seleccionaría otra vez todo el texto: no se hace.
      aplicaVista();
    },
    { passive: false }
  );

  // Botón de escape de perdidos: 100 % y encuadre en su sitio.
  el.btnZoom.addEventListener("click", () => {
    view.z = 1;
    view.tx = 0;
    view.ty = 0;
    aplicaVista();
  });

  el.frame.addEventListener("dblclick", (event) => {
    // Doble clic dentro del área: es el del navegador seleccionando una palabra.
    if (event.target === el.editor) return;
    const o = hitObject(toCanvas(event));
    if (o && o.type === "text") {
      setTool("select");
      select(o);
      openEditor(o);
    }
  });

  el.editor.addEventListener("input", () => {
    if (!editing) return;
    editing.text = el.editor.value;
    growEditor();
    changed();
  });
  el.editor.addEventListener("blur", closeEditor);
  el.editor.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      closeEditor();
    }
  });

  window.addEventListener("paste", (event) => {
    // Dentro del bloque de texto se pega el texto, no la imagen.
    if (editing) return;
    event.preventDefault();
    void pasteImage(event.clipboardData).then((habia) => {
      if (!habia) setStatus("El portapapeles no trae ninguna imagen.", "error");
    });
  });

  document.addEventListener("keydown", (event) => {
    if (editing) return;
    // Con el foco en un control (color, fuente, deslizadores) las teclas son suyas.
    const objetivo = event.target;
    if (objetivo && /^(?:INPUT|SELECT|TEXTAREA)$/.test(String(objetivo.tagName))) return;
    if (event.key === "Escape" && cerrarModal) {
      // El mini-modal abierto manda: Escape lo descarta sin tocar la selección.
      event.preventDefault();
      cerrarModal(false);
      return;
    }
    // Con el modal en pantalla, nada de lo de detrás responde: sus botones son BUTTON y no
    // los filtra el guard de arriba.
    if (cerrarModal) return;
    // Espacio: el arrastre pasa a paneo. Se coge también con un botón en el foco (ENTER sigue
    // activándolo); sin esto, pinchar una herramienta dejaría el paneo inservible.
    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (!espacio) {
        espacio = true;
        pintaCursorPan();
      }
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (sel) {
        event.preventDefault();
        deleteSelected();
      }
    } else if (event.key === "Escape") {
      select(null);
    }
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === " " || event.code === "Space") soltarEspacio();
  });

  // Si la ventana pierde el foco con Espacio pulsado no llega el `keyup`: se suelta aquí y el
  // paneo no se queda enganchado.
  window.addEventListener("blur", soltarEspacio);

  // El layout del marco sí cambia al redimensionar: hay que recolocar el área (sin reabrirla,
  // para no perder el cursor ni seleccionar todo el texto) y recalcular el ancho del lienzo.
  // Con reposo: soltar el divisor del panel dispara muchísimos eventos seguidos.
  let reposoMarco = 0;
  const reMedirMarco = () => {
    clearTimeout(reposoMarco);
    reposoMarco = setTimeout(medirMarco, 150);
  };
  if (typeof ResizeObserver === "function") {
    // El ancho de la barra lateral o un divisor sin evento `resize` de ventana: el observer
    // ve la caja real del marco aunque la webview no entere.
    new ResizeObserver(reMedirMarco).observe(el.frame);
  }
  window.addEventListener("resize", () => {
    medirMarco(); // con el aspecto ya cambiado de golpe: sale barato si W no se mueve
    if (editing) {
      colocaEditor(editing);
      growEditor();
    }
    redraw();
  });

  // ── Mensajes con la extensión ─────────────────────────────

  window.addEventListener("message", async (event) => {
    const m = event.data;
    if (!m) return;
    if (m.type === "init") {
      // Se guarda la promesa: una `capture` que llegue antes de terminar exportaría un lienzo en
      // blanco y la extensión lo escribiría encima de la copia de trabajo.
      cargando = (async () => {
        // Criterio simple: si la copia existe y el lienzo está vacío, se carga.
        if (m.png && !hasContent()) {
          try {
            const img = await loadImage(m.png);
            state.bg = { color: BG_DEFAULT, image: { drawable: img, width: img.width, height: img.height } };
            setStatus("Pizarra anterior restaurada desde la copia de trabajo.");
          } catch {
            setStatus("La copia de trabajo no se ha podido leer.", "error");
          }
        } else {
          setStatus(`Lienzo listo: ${W} × ${H}.`);
        }
        // `redraw`, no `changed`: restaurar no es un cambio, y reescribir la copia con la misma
        // imagen no aporta nada.
        redraw();
      })();
      return;
    }
    if (m.type === "clipboardImage") {
      // Como con `capture`: si la copia de trabajo aún se está cargando, se espera; si no, la
      // carga terminaría pisando el fondo que acabamos de poner.
      if (cargando) await cargando;
      // Se decodifica ANTES de limpiar: un PNG ilegible no debe dejar la pizarra en blanco.
      let img;
      try {
        img = await loadImage(m.src);
      } catch {
        setStatus("El portapapeles no trae ninguna imagen.", "error");
        return;
      }
      vaciar();
      state.bg = { color: BG_DEFAULT, image: { drawable: img, width: img.width, height: img.height } };
      changed();
      setStatus("Nueva pizarra desde el portapapeles.", "ok");
      return;
    }
    if (m.type === "clipboardEmpty") {
      setStatus("El portapapeles no trae ninguna imagen.", "error");
      return;
    }
    if (m.type === "capture") {
      if (cargando) await cargando;
      // Respuesta inmediata: se anula el reposo del debounce para no mandar dos veces.
      clearTimeout(snapshotTimer);
      dirty = false;
      vscode.postMessage({ type: "snapshot", png: pngBase64() });
      return;
    }
    if (m.type === "saved") {
      setStatus(`Guardado en ${m.path}`, "ok");
    }
  });

  setTool("select");
  aplicaVista();
  medirMarco(true); // primer ajuste con el aspecto real del marco antes de pintar nada
  pintaMedida();
  compose();
  vscode.postMessage({ type: "ready" });
})();
