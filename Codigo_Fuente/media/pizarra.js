/* Pizarra — editor de imagen por capas con capa DIAGRAMA (nodos y conectores).
   Orden de apilado, de abajo arriba: FONDO (color y luego imagen), DIAGRAMA, IMÁGENES,
   TRAZOS y TEXTOS.
   Por defecto el lienzo es el del panel: alto fijo (1024 px) y ancho según el aspecto real
   del marco (con topes), así llena el panel en los dos ejes. [NUEVA DESDE PORTAPAPELES] lo
   fija al tamaño exacto de la imagen (con tope de 4096 por lado), y ese W × H es el PNG
   exportado y la copia de trabajo.
   El zoom y el paneo son una transform CSS sobre el mundo: no cambian ni un píxel del aplanado.
   La geometría de nodos y conectores vive en `pizarraWorkflow.js` (PZFlow); aquí solo se
   decide qué se pinta, qué se golpea y qué se guarda. */
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const PZFlow = globalThis.PZFlow;
  /** Widgets de wireframe de la capa INTERFACES (`pizarraUi.js`). Sin ella, la pizarra va igual. */
  const PZUi = globalThis.PZUi || null;

  /** Alto del lienzo del panel: referencia de la escala. `W` sigue al marco; un lienzo fijado cambia los dos. */
  const SIZE = 1024;
  /** Topes del ancho del lienzo: fuera no se dibuja, dentro se copia el aspecto del panel. */
  const ANCHO_MIN = 256;
  const ANCHO_MAX = 4096;
  /** Tope de cada lado cuando el lienzo se fija al tamaño de una imagen. */
  const LADO_MAX = 4096;
  let W = SIZE;
  let H = SIZE;
  /** Lienzo con tamaño propio (el de la imagen pegada), no el del panel. */
  let fijado = false;
  /** Separación del asa de giro respecto al cuadro, en píxeles de pantalla. */
  const ROT_OFF = 30;
  /** Tamaño del cuadradito de cada asa, en píxeles de pantalla. */
  const HANDLE = 15;
  /** Asas de nodo: algo más pequeñas que las de imagen para no tapar la caja. */
  const HANDLE_NODO = 12;
  /** Color del lienzo recién creado. */
  const BG_DEFAULT = "#ffffff";
  const DEG15 = Math.PI / 12;
  /** Límites y paso de la rueda del zoom. */
  const MIN_Z = 0.15;
  const MAX_Z = 8;
  const ZOOM_PASO = 1.15;
  /** Rejilla visible y de ajuste, en píxeles de lienzo. */
  const REJILLA = 8;
  /** Umbral de las guías inteligentes (bordes y centros de otros nodos). */
  const GUIA = 5;
  /** Tamaño con el que nace un nodo al hacer clic con la herramienta NODO. */
  const NODO_W = 200;
  const NODO_H = 80;
  const NODO_MIN_W = 32;
  const NODO_MIN_H = 24;
  /** Cuerpo de la etiqueta de un conector: no hay control propio. */
  const TEXTO_ARISTA = 14;
  /** Tolerancia del golpe de un conector, en píxeles de pantalla. */
  const EDGE_TOL = 10;
  /** Entradas de la pila de deshacer (una por gesto). */
  const HIST_MAX = 50;
  /** Estilo de los conectores nuevos: los controles lo recuerdan. */
  const EDGE_STYLE = { color: "#3d5566", width: 2, dash: false, arrows: "arrow" };
  /** Esquinas de un nodo, en el sentido del reloj desde arriba a la izquierda. */
  const CORNERS = [
    { sx: -1, sy: -1 },
    { sx: 1, sy: -1 },
    { sx: 1, sy: 1 },
    { sx: -1, sy: 1 },
  ];
  const HEX = /^#[0-9a-f]{6}$/i;

  /** Panel del cajón que abre cada herramienta. SELECT no tiene: cierra el cajón. */
  const PANEL_DE_HERRAMIENTA = { node: "node", text: "text", pen: "pen", eraser: "eraser" };
  /** Título del cajón según el panel que tenga abierto. */
  const PANEL_TITULOS = { node: "NODO", edge: "CONECTOR", text: "TEXTO", pen: "LÁPIZ", eraser: "BORRADOR", ui: "INTERFAZ" };

  const el = {
    root: document.querySelector(".pz"),
    frame: document.querySelector(".pz-frame"),
    world: document.getElementById("world"),
    board: document.getElementById("board"),
    overlay: document.getElementById("overlay"),
    editor: document.getElementById("text-editor"),
    edgeEditor: document.getElementById("edge-editor"),
    status: document.getElementById("status"),
    medida: document.querySelector(".pz-medida"),
    btnZoom: document.getElementById("btn-zoom"),
    btnUndo: document.getElementById("btn-undo"),
    btnRedo: document.getElementById("btn-redo"),
    btnGrid: document.getElementById("btn-grid"),
    btnFit: document.getElementById("btn-fit"),
    btnMermaid: document.getElementById("btn-mermaid"),
    btnHelp: document.getElementById("btn-help"),
    modal: document.getElementById("modal"),
    tabs: document.getElementById("pz-tabs"),
    btnBoardAdd: document.getElementById("btn-board-add"),
    btnBoardDel: document.getElementById("btn-board-del"),
    btnBoardSave: document.getElementById("btn-board-save"),
    btnBoardLoad: document.getElementById("btn-board-load"),
    modalText: document.getElementById("modal-text"),
    modalOk: document.getElementById("modal-ok"),
    modalCancel: document.getElementById("modal-cancel"),
    help: document.getElementById("help"),
    helpClose: document.getElementById("help-close"),
    btnNew: document.getElementById("btn-new"),
    btnPaste: document.getElementById("btn-paste"),
    btnSave: document.getElementById("btn-save"),
    penColor: document.getElementById("pen-color"),
    penSize: document.getElementById("pen-size"),
    erSize: document.getElementById("er-size"),
    erHard: document.getElementById("er-hard"),
    txtColor: document.getElementById("txt-color"),
    bgColor: document.getElementById("bg-color"),
    txtFamily: document.getElementById("txt-family"),
    txtSize: document.getElementById("txt-size"),
    nodeShape: document.getElementById("node-shape"),
    nodeFill: document.getElementById("node-fill"),
    nodeStroke: document.getElementById("node-stroke"),
    nodeSize: document.getElementById("node-size"),
    nodeIcon: document.getElementById("node-icon"),
    nodeIconField: document.getElementById("node-icon-field"),
    nodeText: document.getElementById("node-text"),
    nodeTextAuto: document.getElementById("node-text-auto"),
    btnUi: document.getElementById("btn-ui"),
    drawer: document.getElementById("drawer"),
    drawerTitle: document.getElementById("drawer-title"),
    drawerClose: document.getElementById("drawer-x"),
    panels: Array.from(document.querySelectorAll(".pz-drawer-grp[data-panel]")),
    palette: document.getElementById("ui-palette"),
    inspect: document.getElementById("ui-inspect"),
    edgeColor: document.getElementById("edge-color"),
    edgeWidth: document.getElementById("edge-width"),
    edgeDash: document.getElementById("edge-dash"),
    edgeArrows: document.getElementById("edge-arrows"),
    alignGroup: document.getElementById("align-group"),
    tools: Array.from(document.querySelectorAll("[data-tool]")),
    layers: Array.from(document.querySelectorAll(".pz-layer")),
    swatches: Array.from(document.querySelectorAll(".swatch")),
    aligns: Array.from(document.querySelectorAll("[data-align]")),
    dists: Array.from(document.querySelectorAll("[data-dist]")),
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
    flow: { nodes: [], edges: [] },
    /** Capa INTERFACES: widgets planos; `x`/`y` van relativos a la caja útil del padre. */
    ui: { nodes: [] },
    images: [],
    strokes: [],
    texts: [],
    layers: { flow: true, ui: true, images: true, strokes: true, texts: true },
  };

  let tool = "select";
  /** Tipo de widget armado desde la paleta INTERFAZ: el siguiente clic en el lienzo lo coloca. */
  let pendiente = null;
  /** Panel visible del cajón: `node`/`edge`/`text`/`pen`/`eraser`/`ui`, o `null` si está cerrado. */
  let panelAbierto = null;
  /** Imagen o bloque de texto elegido (selección simple, con asas propias). */
  let sel = null;
  /** Nodos elegidos: la marquesina y Shift pueden sumar varios. */
  let selNodes = [];
  /** Conector elegido: sus asas son los extremos y los codos. */
  let selEdge = null;
  /** Widget de INTERFACES elegido: se mueve, se escala y se ajusta en el cajón INTERFAZ. */
  let selUi = null;
  /**
   * Copia en memoria de Ctrl+C: foto profunda de la selección, nunca referencias a la escena.
   * No cruza ventanas ni sobrevive al cierre de la pestaña.
   */
  let portapapeles = null;
  /** Nodo bajo el puntero: enseña sus asas de conexión. */
  let hoverNode = null;
  /** Último punto del puntero en el lienzo: lo usan los chivatos del overlay. */
  let puntero = null;
  /** Bloque de texto que se está escribiendo en el área flotante. */
  let editing = null;
  /** Nodo cuya etiqueta se está escribiendo en el mismo área. */
  let nodeEditing = null;
  /** Texto del nodo al abrir el editor: Escape lo devuelve tal cual estaba. */
  let nodeTextPrevio = "";
  /** Texto del bloque al abrir el área flotante: cerrar sin cambios no consolida nada. */
  let textoPrevio = "";
  /** Conector cuya etiqueta se edita en el campo de una línea. */
  let editingEdge = null;
  /** Trazo, manipulación o conexión en curso. */
  let drag = null;
  /** Guías inteligentes que hay que pintar mientras se arrastra. */
  let guias = [];
  let snapshotTimer = 0;
  let dirty = false;
  /** `init` ya aplicado: hasta entonces no se guarda nada (la escena aún no está). */
  let iniciada = false;
  /** Pizarra activa y todas las que hay: las manda el host en cada `init`. La 1 siempre existe. */
  let pizarraActual = 1;
  /** Pizarra cuyo contenido está pintado en el lienzo: cambia al aplicar su `init`, no al pedirla. */
  let pizarraVisible = 1;
  let pizarras = [1];
  /** Sube con cada `init`: un `init` viejo que termine tarde no pisa la pizarra nueva. */
  let initGen = 0;
  /** Encuadre: escala `z` y desplazamiento en píxeles de pantalla, aplicados por CSS. */
  const view = { z: 1, tx: 0, ty: 0 };
  /** Barra espaciadora pulsada: el arrastre panea en vez de dibujar o seleccionar. */
  let espacio = false;
  /** El cierre del mini-modal abierto, si lo hay: lo usa Escape. */
  let cerrarModal = null;
  /** La carga de la copia de trabajo: `capture` espera a que termine. */
  let cargando = null;

  /** Rejilla a la vista y de ajuste (el botón REJILLA la apaga y la enciende). */
  let rejilla = true;
  /** La capa FONDO también se puede ocultar; no viaja en la escena porque el contrato no la lleva. */
  let fondoVisible = true;
  /** El último relleno elegido; `"none"` no cabe en un `input[type=color]`. */
  let rellenoSin = false;
  /** El próximo nodo nace con texto automático salvo que se fije un color a mano. */
  let textoAuto = true;
  /** Último tamaño dibujado con la herramienta NODO: el clic lo reutiliza. */
  let ultimoTamano = { w: NODO_W, h: NODO_H };
  /** Pila de deshacer/rehacer: escenas completas, una entrada por gesto. */
  let historia = [];
  let hIdx = -1;
  let guardandoHistoria = false;
  /** Sube con cada `changed()`: `commit` ahorra serializar si nadie ha tocado nada. */
  let version = 0;
  /** Tope de la escena que viaja al host (por encima solo queda el PNG). */
  const MAX_ESCENA = 7500000;

  // ── Utilidades ────────────────────────────────────────────

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = "pz-status" + (kind ? " " + kind : "");
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Número finito o el valor por defecto. */
  function num(raw, fallback) {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  }

  /** Dos decimales: la escena no engorda con colas de coma flotante. */
  function red(v) {
    return Math.round(v * 100) / 100;
  }

  /** Ajuste a la rejilla cuando está encendida. */
  function ajusta(v) {
    return rejilla ? Math.round(v / REJILLA) * REJILLA : Math.round(v);
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
   * Píxeles de PANTALLA llevados a coordenadas del lienzo. Asas y trazos del overlay se miden
   * así: con el lienzo de una imagen pequeña muy ampliado, un asa de 15 px del lienzo taparía
   * la imagen entera.
   */
  const px = (n) => n / pantallaEscala();

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
      state.flow.nodes.length ||
        state.flow.edges.length ||
        state.ui.nodes.length ||
        state.strokes.length ||
        state.images.length ||
        state.texts.length ||
        state.bg.image
    );
  }

  /**
   * Fija el color del lienzo y lo refleja en el selector. El color es una preferencia: el host
   * la recuerda y la manda en `init`; sin ella vale el blanco por defecto.
   */
  function aplicaFondo(color) {
    const hex = typeof color === "string" && HEX.test(color) ? color.toLowerCase() : BG_DEFAULT;
    el.bgColor.value = hex;
    state.bg.color = hex;
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
   * Lienzo del panel: alto fijo (SIZE) y ancho según el aspecto del marco, así la unidad de
   * lienzo conserva su tamaño relativo en Y y la escala CSS→lienzo sale uniforme en los dos ejes.
   * `clientWidth/Height`: caja de contenido sin el borde de 1 px, que falsearía el aspecto.
   * `sinMarcar`: en el arranque el lienzo aún no tiene nada que conservar en la copia.
   * Con el lienzo fijado no se toca el tamaño: solo se recoloca el mundo en el marco.
   */
  function medirMarco(sinMarcar) {
    encajarMundo();
    if (fijado) {
      if (editing) {
        colocaEditor(editing);
        growEditor();
      }
      if (nodeEditing) colocaEditorNodo(nodeEditing);
      // La escala de pantalla cambia con la caja: el overlay tiene que repintar sus asas.
      redraw();
      return;
    }
    const cw = el.frame.clientWidth;
    const ch = el.frame.clientHeight;
    if (!cw || !ch) return; // panel oculto: nada que recalcular
    const w = clamp(Math.round((SIZE * cw) / ch), ANCHO_MIN, ANCHO_MAX);
    // El mapa de bits manda: tras soltar un lienzo fijado el ancho puede coincidir por casualidad.
    if (w === W && H === SIZE && el.board.width === w && el.board.height === SIZE) return;
    W = w;
    H = SIZE;
    for (const node of [el.board, el.overlay, committed, live]) cambiarTamañoLienzo(node, W, H);
    pintaMedida();
    if (editing) {
      colocaEditor(editing);
      growEditor();
    }
    if (nodeEditing) colocaEditorNodo(nodeEditing);
    if (sinMarcar) redraw();
    else changed(); // la copia de trabajo tiene que reflejar el nuevo tamaño
  }

  /**
   * Caja del mundo dentro del marco. Con el lienzo del panel ocupa el marco entero; con uno
   * fijado se centra con el aspecto del lienzo, así una imagen de 100 × 100 se ve grande sin
   * deformarse y el PNG sigue siendo 100 × 100.
   */
  function encajarMundo() {
    const s = el.world.style;
    if (!fijado) {
      s.left = "0";
      s.top = "0";
      s.width = "100%";
      s.height = "100%";
      return;
    }
    const cw = el.frame.clientWidth;
    const ch = el.frame.clientHeight;
    if (!cw || !ch) return; // panel oculto: la caja se queda como estaba
    const k = Math.min(cw / W, ch / H);
    const bw = Math.round(W * k);
    const bh = Math.round(H * k);
    s.width = bw + "px";
    s.height = bh + "px";
    s.left = Math.round((cw - bw) / 2) + "px";
    s.top = Math.round((ch - bh) / 2) + "px";
  }

  /** Fija el lienzo a un tamaño (con tope por lado) y deja la vista limpia. */
  function fijarLienzo(w, h) {
    const k = Math.max(w, h) > LADO_MAX ? LADO_MAX / Math.max(w, h) : 1;
    W = Math.max(1, Math.round(w * k));
    H = Math.max(1, Math.round(h * k));
    for (const node of [el.board, el.overlay, committed, live]) cambiarTamañoLienzo(node, W, H);
    fijado = true;
    encajarMundo();
    pintaMedida();
    // Pegar con el zoom a 800 % dejaría el lienzo nuevo fuera del marco.
    view.z = 1;
    view.tx = 0;
    view.ty = 0;
    aplicaVista();
  }

  /** Vuelve al lienzo del panel (alto fijo y ancho según el marco) tras vaciar uno fijado. */
  function soltarLienzo() {
    fijado = false;
    H = SIZE;
    medirMarco();
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

  /** Imágenes ya decodificadas por su data URL: restaurar no vuelve a leerlas del disco. */
  const cacheImagenes = new Map();

  async function imagenDe(src) {
    if (cacheImagenes.has(src)) return cacheImagenes.get(src);
    const img = await loadImage(src);
    cacheImagenes.set(src, img);
    return img;
  }

  /**
   * Data URL de un mapa de bits para la escena. Se cachea al pegar, no en cada instantánea:
   * si el PNG pasa del tope del host, se reencoda en JPEG y, si aún no cabe, se reduce.
   */
  function dataUrlDe(fuente) {
    const w = fuente.width;
    const h = fuente.height;
    const pinta = (kw, kh) => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, kw);
      c.height = Math.max(1, kh);
      c.getContext("2d").drawImage(fuente, 0, 0, c.width, c.height);
      return c;
    };
    const TOPE = 5.5e6;
    let url = pinta(w, h).toDataURL("image/png");
    if (url.length <= TOPE) return url;
    url = pinta(w, h).toDataURL("image/jpeg", 0.9);
    if (url.length <= TOPE) return url;
    let k = 0.75;
    while (k > 0.15) {
      url = pinta(Math.round(w * k), Math.round(h * k)).toDataURL("image/jpeg", 0.85);
      if (url.length <= TOPE) return url;
      k *= 0.75;
    }
    return url;
  }

  /**
   * `src` del fondo para la escena: la data URL tal cual si cabe en el tope del host; si no,
   * se reencoda recortada en JPEG, que es lo que mantiene viva la escena de una captura 4K.
   */
  function srcDeImagen(url, img) {
    return url.length <= 5.5e6 ? url : dataUrlDe(img);
  }

  /** Añade una imagen decodificada como objeto de la capa IMÁGENES, centrada y ajustada. */
  function addImage(drawable, w, h, src) {
    const box = fitInside(w, h);
    const obj = { type: "image", drawable, src, w: box.w, h: box.h, x: box.x, y: box.y, rot: 0 };
    state.images.push(obj);
    setTool("select");
    select(obj);
    changed();
    commit();
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
    const src = dataUrlDe(bitmap);
    bitmap.close?.();
    let img;
    try {
      img = await imagenDe(src);
    } catch {
      setStatus("El portapapeles trae una imagen que no se puede leer.", "error");
      return true;
    }
    // Con un widget IMAGEN elegido el pegado va a su `src`: no se crea capa IMÁGENES.
    if (selUi && selUi.kind === "image" && state.ui.nodes.indexOf(selUi) >= 0) {
      selUi.src = src;
      changed();
      commit();
      syncUiControls();
      setStatus("Imagen puesta en el widget de INTERFACES.", "ok");
      return true;
    }
    addImage(img, img.width, img.height, src);
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

  // ── Textos flotantes ──────────────────────────────────────

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

  // ── Nodos ─────────────────────────────────────────────────

  /** Luminancia simple: decide el texto y el icono sobre el relleno. */
  function esClaro(hex) {
    if (!HEX.test(hex)) return true; // sin relleno: manda el fondo del lienzo
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.62;
  }

  function colorTextoNodo(n) {
    if (n.textColor && n.textColor !== "auto" && HEX.test(n.textColor)) return n.textColor;
    return esClaro(n.fill) ? "#14232b" : "#ffffff";
  }

  /** Relleno para los conectores y los iconos: el del texto resuelto, que siempre contrasta. */
  function colorIcono(n) {
    return colorTextoNodo(n);
  }

  /** Silueta redondeada a mano: `arcTo` no admite un radio mayor que medio lado. */
  function caja(t, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    t.beginPath();
    if (!rr) {
      t.rect(x, y, w, h);
      return;
    }
    t.moveTo(x + rr, y);
    t.arcTo(x + w, y, x + w, y + h, rr);
    t.arcTo(x + w, y + h, x, y + h, rr);
    t.arcTo(x, y + h, x, y, rr);
    t.arcTo(x, y, x + w, y, rr);
    t.closePath();
  }

  /** Path2D de cada icono, una vez: `new Path2D` con la cadena `d` de la librería. */
  const cacheIconos = new Map();

  function iconoPath(nombre) {
    const clave = PZFlow.ICONS[nombre] ? nombre : "mail";
    if (!cacheIconos.has(clave)) cacheIconos.set(clave, new Path2D(PZFlow.ICONS[clave]));
    return cacheIconos.get(clave);
  }

  /** Pinta el icono escalado al cuadro: el trazo se compensa para que no engorde ni desaparezca. */
  function dibujaIcono(t, n, x, y, lado) {
    const k = lado / 24;
    t.save();
    t.translate(x, y);
    t.scale(k, k);
    t.lineWidth = 2 / k;
    // Un icono blanco sobre relleno claro no se vería: ese caso cae al color de texto resuelto.
    const blancoSobreClaro = n.iconColor === "#ffffff" && esClaro(n.fill);
    t.strokeStyle = HEX.test(n.iconColor) && !blancoSobreClaro ? n.iconColor : colorIcono(n);
    t.lineCap = "round";
    t.lineJoin = "round";
    t.stroke(iconoPath(n.icon));
    t.restore();
  }

  /**
   * Rectángulo útil del texto de un nodo, dentro de su silueta. El texto se ajusta y, si no
   * cabe en alto, se encoge: nunca debe salirse de la figura.
   */
  function cajaTextoNodo(n) {
    if (n.shape === "ellipse") {
      return { x: n.x + n.w * 0.14, y: n.y + n.h * 0.14, w: Math.max(1, n.w * 0.72), h: Math.max(1, n.h * 0.72) };
    }
    if (n.shape === "diamond") {
      return { x: n.x + n.w * 0.25, y: n.y + n.h * 0.25, w: Math.max(1, n.w * 0.5), h: Math.max(1, n.h * 0.5) };
    }
    if (n.shape === "icon") {
      // El icono ocupa la parte de arriba; su etiqueta va debajo.
      return { x: n.x + 8, y: n.y + n.h * 0.56, w: Math.max(1, n.w - 16), h: Math.max(1, n.h * 0.4) };
    }
    if (n.shape === "stadium") {
      const lateral = Math.max(0, Math.min(n.w / 2 - 4, n.h / 2 + 6));
      return { x: n.x + lateral, y: n.y + 8, w: Math.max(1, n.w - lateral * 2), h: Math.max(1, n.h - 16) };
    }
    return { x: n.x + 10, y: n.y + 10, w: Math.max(1, n.w - 20), h: Math.max(1, n.h - 20) };
  }

  /** Reparte el texto del nodo en líneas con el cuerpo y el ancho dados. */
  function partirTextoNodo(n, ancho, size) {
    measure.font = `${n.weight || 400} ${size}px sans-serif`;
    const lines = [];
    for (const para of String(n.text == null ? "" : n.text).split("\n")) {
      if (para === "") {
        lines.push("");
        continue;
      }
      let cur = "";
      for (const word of para.split(" ")) {
        const prueba = cur ? cur + " " + word : word;
        if (!cur || measure.measureText(prueba).width <= ancho) {
          cur = prueba;
        } else {
          lines.push(cur);
          cur = word;
        }
        while (cur.length > 1 && measure.measureText(cur).width > ancho) {
          let corte = cur.length - 1;
          while (corte > 1 && measure.measureText(cur.slice(0, corte)).width > ancho) corte--;
          lines.push(cur.slice(0, corte));
          cur = cur.slice(corte);
        }
      }
      lines.push(cur);
    }
    return lines;
  }

  /**
   * Líneas del texto de un nodo con su cuerpo efectivo: si el bloque no cabe en la caja de la
   * forma, se baja el cuerpo de 1 en 1 hasta 8. Nunca sube por encima de `n.fontSize`.
   */
  function lineasNodo(n) {
    const caja = cajaTextoNodo(n);
    const ancho = Math.max(4, caja.w);
    let size = Math.max(1, Math.round(n.fontSize));
    let lines = partirTextoNodo(n, ancho, size);
    let lineH = Math.max(1, Math.round(size * 1.25));
    while (size > 8 && lines.length * lineH > caja.h) {
      size -= 1;
      lines = partirTextoNodo(n, ancho, size);
      lineH = Math.max(1, Math.round(size * 1.25));
    }
    return { lines, lineH, size, caja };
  }

  function dibujaTextoNodo(t, n) {
    if (n === nodeEditing) return; // lo escribe el textarea encima
    const m = lineasNodo(n);
    if (!m.lines.length) return;
    const cajaTexto = m.caja;
    t.save();
    // Recorte con la silueta: aunque el bloque no quepa, el texto no sale del nodo.
    if (n.shape === "icon") caja(t, n.x, n.y, n.w, n.h, 10);
    else PZFlow.nodePath(t, n);
    t.clip();
    t.font = `${n.weight || 400} ${m.size}px sans-serif`;
    t.fillStyle = colorTextoNodo(n);
    t.textBaseline = "middle";
    const alto = (m.lines.length - 1) * m.lineH;
    let y = cajaTexto.y + cajaTexto.h / 2 - alto / 2;
    const alineado = n.align === "left" || n.align === "right" ? n.align : "center";
    t.textAlign = alineado;
    const x =
      alineado === "left" ? cajaTexto.x : alineado === "right" ? cajaTexto.x + cajaTexto.w : cajaTexto.x + cajaTexto.w / 2;
    for (const linea of m.lines) {
      t.fillText(linea, x, y);
      y += m.lineH;
    }
    t.restore();
  }

  function dibujaNodo(t, n) {
    const icono = n.shape === "icon";
    t.save();
    if (icono) {
      // La forma ICONO no traza silueta en la librería: aquí lleva una caja suave propia.
      caja(t, n.x, n.y, n.w, n.h, 10);
      if (n.fill !== "none") {
        t.fillStyle = n.fill;
        t.fill();
      }
      t.lineWidth = 2;
      t.strokeStyle = n.stroke;
      t.stroke();
      const hayTexto = Boolean(String(n.text || "").trim());
      const lado = Math.max(12, Math.min(n.w, n.h) * (hayTexto ? 0.42 : 0.66));
      dibujaIcono(t, n, n.x + (n.w - lado) / 2, n.y + (hayTexto ? n.h * 0.1 : (n.h - lado) / 2), lado);
      if (hayTexto) dibujaTextoNodo(t, n);
    } else {
      PZFlow.nodePath(t, n);
      if (n.fill !== "none") {
        t.fillStyle = n.fill;
        t.fill();
      }
      t.lineWidth = 2;
      t.strokeStyle = n.stroke;
      t.stroke();
      dibujaTextoNodo(t, n);
    }
    t.restore();
  }

  // ── INTERFACES: widgets de wireframe ──────────────────────

  /** Lado mínimo de un widget al escalarlo con un asa. */
  const UI_MIN = 8;
  /** Tope de widgets de la capa: el mismo que aplica el saneado del host (`MAX_UI_NODES`). */
  const UI_MAX = 800;

  /**
   * Campos del inspector por tipo: solo los que `pizarraUi.js` lee de verdad en cada widget.
   * `align` solo lo usa la etiqueta (el resto de controles alinea por su cuenta).
   */
  const UI_CAMPOS = {
    container: ["title", "disabled"],
    window: ["title", "disabled"],
    "tabs-h": ["items", "active", "disabled"],
    "tabs-v": ["items", "active", "disabled"],
    accordion: ["items", "active", "disabled"],
    menu: ["items", "active", "orientation", "disabled"],
    list: ["items", "active", "icon", "icons", "scroll", "disabled"],
    label: ["text", "align", "disabled"],
    input: ["text", "placeholder", "disabled"],
    textarea: ["text", "placeholder", "disabled"],
    choice: ["options", "checked", "variant", "disabled"],
    button: ["text", "variant", "disabled"],
    icon: ["icon", "disabled"],
    image: ["src", "disabled"],
  };

  /** Orden y rótulo de cada campo del inspector. */
  const UI_EDITOR = {
    title: { etiqueta: "TÍTULO", tag: "input" },
    text: { etiqueta: "TEXTO", tag: "input" },
    placeholder: { etiqueta: "PISTA", tag: "input" },
    items: { etiqueta: "FILAS (una por línea)", tag: "textarea" },
    active: { etiqueta: "ACTIVA / ABIERTA", tag: "select" },
    options: { etiqueta: "OPCIONES (una por línea)", tag: "textarea" },
    checked: { etiqueta: "MARCADAS (0, 2…)", tag: "input" },
    variant: { etiqueta: "VARIANTE", tag: "select" },
    align: { etiqueta: "ALINEAR", tag: "select" },
    // Rejilla con los iconos del diagrama, no una lista de nombres.
    icon: { etiqueta: "ICONO", tag: "iconos" },
    // Dos botones de icono: el menú en fila o en columna.
    orientation: { etiqueta: "ORIENTACIÓN", tag: "orientacion" },
    // Solo la lista: icono a la izquierda de cada fila y barra de desplazamiento a la derecha.
    icons: { etiqueta: "ICONO EN CADA FILA", tag: "checkbox" },
    scroll: { etiqueta: "BARRA DE DESPLAZAMIENTO", tag: "checkbox" },
    // Solo lectura: la data URL se pone pegando la imagen o desde el MCP, no escribiéndola.
    src: { etiqueta: "IMAGEN", tag: "nota" },
    disabled: { etiqueta: "APAGADO", tag: "checkbox" },
  };
  const UI_ORDEN = ["title", "text", "placeholder", "items", "active", "options", "checked", "variant", "align", "icon", "orientation", "icons", "scroll", "src", "disabled"];

  /**
   * Paleta: icono y rótulo corto de cada tipo. La librería trae rótulos largos («Pestañas H»,
   * «Área de texto») que no caben en el cajón; aquí se acortan sin tocar `pizarraUi.js`.
   * El `d` va en un `<svg viewBox="0 0 24 24">` con trazo 1.7, como el resto del panel.
   */
  const UI_PALETA = {
    container: { label: "Contenedor", d: "M4 4h16v16H4z" },
    window: { label: "Ventana", d: "M3 4h18v16H3zM3 10h18" },
    "tabs-h": { label: "Tabs H", d: "M3 4h18v16H3zM3 10h18M9 4v6M15 4v6" },
    "tabs-v": { label: "Tabs V", d: "M3 4h18v16H3zM9 4v16M3 9h6M3 15h6" },
    accordion: { label: "Acordeón", d: "M3 4h18v16H3zM3 10h18M3 16h18M6 7h4M6 13h4" },
    menu: { label: "Menú", d: "M4 7h16M4 12h16M4 17h16" },
    list: { label: "Lista", d: "M4 6h16M4 12h16M4 18h10" },
    label: { label: "Etiqueta", d: "M5 6h14M12 6v13" },
    input: { label: "Campo", d: "M3 8h18v8H3zM7 10v4" },
    textarea: { label: "Área texto", d: "M3 6h18v12H3zM6 10h12M6 14h8" },
    choice: { label: "Casilla", d: "M4 9h5v5H4zM12 11.5h8" },
    button: { label: "Botón", d: "M7 9h10a3 3 0 0 1 0 6H7a3 3 0 0 1 0-6z" },
    icon: { label: "Icono", d: "M12 4l2.4 5.2L20 12l-5.6 2.8L12 20l-2.4-5.2L4 12l5.6-2.8z" },
    image: { label: "Imagen", d: "M3 5h18v14H3zM8 11h.01M4 17l5-5 4 4 3-3 4 4" },
  };

  /** Iconos de las acciones del inspector: solo trazo, con `title` y `aria-label`. */
  const UI_ACCIONES = [
    { id: "subir", title: "Subir el widget un paso en el orden de pintado", d: "M12 19V5M6 11l6-6 6 6" },
    { id: "bajar", title: "Bajar el widget un paso en el orden de pintado", d: "M12 5v14M6 13l6 6 6-6" },
    { id: "extraer", title: "Sacar el widget a la raíz de la capa", d: "M14 4h6v6M20 4l-8 8M18 14v6H4V4h6" },
    { id: "borrar", title: "Borrar el widget y los que cuelgan de él", d: "M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6" },
  ];

  /** Controles del inspector por campo; se crean una vez y se rellenan al elegir. */
  const inspectorCampos = {};
  const inspectorFilas = {};
  /** Botones de la paleta INTERFAZ: el armado se marca con `.on` y `aria-pressed`. */
  const paletaBotones = [];
  /** Chips y botones del bloque ESTILO y de los extras por tipo, para marcarlos al elegir. */
  const inspectorMarcas = {};
  /** Siguiente número de id de widget: `u1`, `u2`… sin repetir lo que ya haya. */
  let uiSeq = 0;

  /** Id nuevo de widget, sin pisar ninguno de la escena. */
  function nuevoIdUi() {
    let id;
    do {
      uiSeq += 1;
      id = "u" + uiSeq;
    } while (state.ui.nodes.some((n) => n.id === id));
    return id;
  }

  /** Ids del widget y de todo lo que cuelga de él. */
  function ramaUi(id) {
    const ids = [id];
    for (let i = 0; i < ids.length; i += 1) {
      for (const n of state.ui.nodes) {
        if (n.parent === ids[i] && ids.indexOf(n.id) < 0) ids.push(n.id);
      }
    }
    return ids;
  }

  /** Copia de un widget con sus listas clonadas: la copia no comparte arrays con la escena. */
  function copiaWidget(n) {
    return { ...n, items: n.items.slice(), options: n.options.slice(), checked: n.checked.slice() };
  }

  /** Origen de la caja útil del padre, en coordenadas del lienzo: los hijos van relativos a él. */
  function uiOrigen(n) {
    if (!n || n.parent == null || !PZUi) return { x: 0, y: 0 };
    const padre = state.ui.nodes.find((m) => m.id === n.parent);
    if (!padre) return { x: 0, y: 0 };
    const caja = PZUi.place(state.ui.nodes, padre);
    const util = PZUi.contentBox(padre);
    return { x: caja.x + util.dx, y: caja.y + util.dy };
  }

  /** Widgets de una escena al modelo de la webview; lo que no encaja se cae, no aborta la carga. */
  function uiDeEscena(raw) {
    const usados = new Set();
    const nodos = [];
    for (const n of Array.isArray(raw) ? raw : []) {
      if (!n || typeof n.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(n.id) || usados.has(n.id)) continue;
      usados.add(n.id);
      nodos.push({
        id: n.id,
        kind: typeof n.kind === "string" ? n.kind : "container",
        parent: typeof n.parent === "string" ? n.parent : null,
        x: num(n.x, 0),
        y: num(n.y, 0),
        w: Math.max(1, num(n.w, 120)),
        h: Math.max(1, num(n.h, 32)),
        title: typeof n.title === "string" ? n.title : "",
        text: typeof n.text === "string" ? n.text : "",
        placeholder: typeof n.placeholder === "string" ? n.placeholder : "",
        items: Array.isArray(n.items) ? n.items.filter((t) => typeof t === "string") : [],
        active: num(n.active, -1),
        options: Array.isArray(n.options) ? n.options.filter((t) => typeof t === "string") : [],
        checked: Array.isArray(n.checked) ? n.checked.filter((i) => typeof i === "number") : [],
        variant: typeof n.variant === "string" ? n.variant : "",
        align: typeof n.align === "string" ? n.align : "left",
        icon: typeof n.icon === "string" ? n.icon : "",
        src: typeof n.src === "string" ? n.src : "",
        disabled: n.disabled === true,
        // Solo `list`: icono por fila y barra de desplazamiento simulada.
        icons: n.icons === true,
        scroll: n.scroll === true,
        // Estilo: mismas reglas que el saneado del host, por si la escena viene de un `init`
        // viejo o del historial de antes de estos campos.
        fill: n.fill === "none" || n.fill === "auto" ? n.fill : /^#[0-9a-f]{6}$/i.test(n.fill) ? n.fill.toLowerCase() : "auto",
        stroke: n.stroke === "none" ? "none" : /^#[0-9a-f]{6}$/i.test(n.stroke) ? n.stroke.toLowerCase() : "#111111",
        titleColor: /^#[0-9a-f]{6}$/i.test(n.titleColor) ? n.titleColor.toLowerCase() : "#111111",
        titleSize: clamp(Math.round(num(n.titleSize, 12)), 8, 48),
        orientation: n.orientation === "h" ? "h" : "v",
      });
    }
    // Padre que no está: el widget se queda, pero en la raíz (igual que el saneado del host).
    const ids = new Set(nodos.map((n) => n.id));
    for (const n of nodos) {
      if (n.parent !== null && !ids.has(n.parent)) n.parent = null;
    }
    return nodos;
  }

  /** Widget nuevo de la paleta: el tamaño lo manda la librería. */
  function widgetNuevo(kind) {
    const tam = PZUi.defaults(kind);
    const items = [];
    // Un par de filas de arranque: un contenedor vacío no se entiende hasta configurarlo.
    if (kind === "tabs-h" || kind === "tabs-v") items.push("Pestaña 1", "Pestaña 2");
    else if (kind === "accordion") items.push("Sección 1");
    else if (kind === "menu") items.push("Opción 1");
    else if (kind === "list") items.push("Elemento 1", "Elemento 2", "Elemento 3");
    const options = kind === "choice" ? ["Opción 1"] : [];
    return {
      id: nuevoIdUi(),
      kind,
      parent: null,
      x: 0,
      y: 0,
      w: tam.w,
      h: tam.h,
      title: kind === "window" ? "Ventana" : "",
      text: kind === "button" ? "Botón" : "",
      placeholder: kind === "input" ? "Texto" : kind === "textarea" ? "Texto" : "",
      items,
      // La lista no nace con una fila resaltada: se elige en el inspector.
      active: kind === "list" ? -1 : items.length ? 0 : -1,
      options,
      checked: [],
      variant: "",
      align: "left",
      icon: kind === "icon" ? "user" : "",
      src: "",
      disabled: false,
      icons: false,
      scroll: false,
      // Estilo obligatorio en el contrato: los defectos del saneado del host, tal cual.
      fill: "auto",
      stroke: "#111111",
      titleColor: "#111111",
      titleSize: 12,
      orientation: "v",
    };
  }

  /**
   * Suelta un widget desde la paleta: con su esquina superior izquierda en `p`.
   */
  function insertarUi(kind, p) {
    if (!PZUi) {
      desarmar();
      setStatus("La capa INTERFACES no está cargada.", "error");
      return;
    }
    if (state.ui.nodes.length >= UI_MAX) {
      desarmar();
      setStatus("La capa INTERFACES llega al tope de 800 widgets.", "error");
      return;
    }
    // Insertar a ciegas con la capa oculta no enseña nada: se enciende, como el lápiz con TRAZOS.
    const capaApagada = state.layers.ui === false;
    if (capaApagada) {
      state.layers.ui = true;
      paintLayers();
    }
    const nodo = widgetNuevo(kind);
    // El clic manda: sobre un contenedor el widget entra dentro y sus `x`/`y` pasan a ser
    // relativas a la caja útil; en el vacío, la esquina cae donde se suelta.
    const cont = hostDestino(p, null);
    if (cont) {
      nodo.parent = cont.id;
      const util = PZUi.contentRect(state.ui.nodes, cont);
      nodo.x = ajusta(Math.max(0, p.x - util.x));
      nodo.y = ajusta(Math.max(0, p.y - util.y));
    } else {
      nodo.x = ajusta(p.x);
      nodo.y = ajusta(p.y);
    }
    state.ui.nodes.push(nodo);
    setTool("select");
    selectUi(nodo);
    changed();
    commit();
    const añadido = `${etiquetaUi(kind)} añadido${cont ? ` dentro de ${etiquetaUi(cont.kind)}` : ""}.`;
    setStatus(
      capaApagada ? `La capa INTERFACES estaba oculta: la enciendo. Interfaz: ${añadido}` : `Interfaz: ${añadido}`,
      "ok"
    );
  }

  /** Contenedor que recibiría un widget soltado en `p`, si aún cabe un nivel más. */
  function hostDestino(p, excluir) {
    if (!PZUi) return null;
    const cont = PZUi.hostAt(state.ui.nodes, p.x, p.y, excluir);
    return cont && PZUi.depthOf(state.ui.nodes, cont) + 1 <= PZUi.MAX_DEPTH ? cont : null;
  }

  /** Nombre visible de un tipo de widget. */
  function etiquetaUi(kind) {
    if (!PZUi) return kind;
    const entrada = PZUi.KINDS.find((k) => k.kind === kind);
    return entrada ? entrada.label : kind;
  }

  /** Arma la colocación de un widget: el siguiente clic en el lienzo lo pone donde caiga. */
  function armarUi(kind, boton) {
    pendiente = kind;
    for (const b of paletaBotones) {
      const activo = b === boton;
      b.classList.toggle("on", activo);
      b.setAttribute("aria-pressed", activo ? "true" : "false");
    }
    setStatus(`INTERFAZ: clic en el lienzo para colocar ${etiquetaUi(kind)}; Esc cancela.`, "ok");
    redraw();
  }

  /** Desarma la colocación pendiente y apaga la marca de la paleta. */
  function desarmar() {
    pendiente = null;
    for (const b of paletaBotones) {
      b.classList.remove("on");
      b.setAttribute("aria-pressed", "false");
    }
  }

  /** Asa de tamaño del widget elegido, en coordenadas del lienzo. */
  function hitAsaUi(n, p) {
    const caja = PZUi.place(state.ui.nodes, n);
    const radio = px(HANDLE_NODO);
    for (const asa of PZUi.handlePoints(caja)) {
      if (Math.abs(p.x - asa.x) <= radio && Math.abs(p.y - asa.y) <= radio) return asa;
    }
    return null;
  }

  /** Escalado desde un asa: los bordes se mueven en absoluto y el resultado vuelve al padre. */
  function redimensionarUi(d, p) {
    const n = d.nodo;
    const b = d.caja;
    let x0 = b.x;
    let y0 = b.y;
    let x1 = b.x + b.w;
    let y1 = b.y + b.h;
    if (d.part.indexOf("w") >= 0) x0 = ajusta(p.x);
    if (d.part.indexOf("e") >= 0) x1 = ajusta(p.x);
    if (d.part.indexOf("n") >= 0) y0 = ajusta(p.y);
    if (d.part.indexOf("s") >= 0) y1 = ajusta(p.y);
    // El asa no cruza el borde de enfrente: el widget se queda en su lado mínimo.
    if (x1 - x0 < UI_MIN) {
      if (d.part.indexOf("w") >= 0) x0 = x1 - UI_MIN;
      else x1 = x0 + UI_MIN;
    }
    if (y1 - y0 < UI_MIN) {
      if (d.part.indexOf("n") >= 0) y0 = y1 - UI_MIN;
      else y1 = y0 + UI_MIN;
    }
    const x = x0 - d.origen.x;
    const y = y0 - d.origen.y;
    const w = x1 - x0;
    const h = y1 - y0;
    const cambia = n.x !== x || n.y !== y || n.w !== w || n.h !== h;
    n.x = x;
    n.y = y;
    n.w = w;
    n.h = h;
    return cambia;
  }

  /** SUBIR/BAJAR: intercambia el sitio con el hermano de al lado en el orden de pintado. */
  function moverUi(dir) {
    if (!selUi || state.ui.nodes.indexOf(selUi) < 0) return;
    const hermanos = PZUi.children(state.ui.nodes, selUi.parent);
    const i = hermanos.indexOf(selUi);
    const otro = hermanos[i + dir];
    if (i < 0 || !otro) {
      setStatus(dir > 0 ? "Ya es el widget de arriba." : "Ya es el widget de abajo.");
      return;
    }
    const a = state.ui.nodes.indexOf(selUi);
    const b = state.ui.nodes.indexOf(otro);
    state.ui.nodes[a] = otro;
    state.ui.nodes[b] = selUi;
    changed();
    commit();
  }

  /** EXTRAER: el widget pasa a la raíz sin moverse de donde se ve. */
  function extraerUi() {
    if (!selUi || state.ui.nodes.indexOf(selUi) < 0) return;
    if (selUi.parent == null) {
      setStatus("El widget ya está en la raíz de INTERFACES.");
      return;
    }
    PZUi.detach(state.ui.nodes, selUi);
    changed();
    commit();
    syncUiControls();
    setStatus("Widget sacado a la raíz de INTERFACES.");
  }

  /** Ctrl+D con un widget elegido: copia su subárbol, desplazado y con ids nuevos. */
  function duplicarUi() {
    const ids = new Set(ramaUi(selUi.id));
    if (state.ui.nodes.length + ids.size > UI_MAX) {
      setStatus("La capa INTERFACES llega al tope de 800 widgets.", "error");
      return;
    }
    const copias = new Map();
    for (const n of state.ui.nodes.slice()) {
      if (!ids.has(n.id)) continue;
      const copia = { ...copiaWidget(n), id: nuevoIdUi() };
      if (n === selUi) {
        copia.x += 16;
        copia.y += 16;
      }
      copias.set(n.id, copia);
      state.ui.nodes.push(copia);
    }
    // Un padre que no viaja en la copia se queda el de siempre: la copia es su hermana.
    for (const copia of copias.values()) {
      const padre = copias.get(copia.parent);
      if (padre) copia.parent = padre.id;
    }
    selectUi(copias.get(selUi.id));
    changed();
    commit();
    setStatus(`${copias.size} widget(s) duplicados.`, "ok");
  }

  /** Rellena un `<select>` con pares valor/rótulo y deja elegido el que toque. */
  function llenarOpciones(select, pares, actual) {
    if (!select) return;
    select.replaceChildren(...pares.map(([valor, texto]) => new Option(texto, valor)));
    const hay = pares.some(([valor]) => valor === actual);
    select.value = hay ? actual : pares.length ? pares[0][0] : "";
  }

  /** Selección de un widget: el cajón enseña su inspector. */
  function selectUi(n) {
    selUi = n;
    sel = null;
    selNodes = [];
    selEdge = null;
    syncUiControls();
    syncOpciones();
    paintLayers();
    actualizarContexto();
    redraw();
  }

  /**
   * Lleva el foco al campo de etiqueta del widget: `title`, `text`, `placeholder` o `items`,
   * el primero que su tipo tenga. Sin ninguno, solo queda la selección.
   */
  function enfocarEtiquetaUi(n) {
    const campos = UI_CAMPOS[n.kind] || [];
    const clave = ["title", "text", "placeholder", "items"].find((k) => campos.indexOf(k) >= 0);
    const control = clave ? inspectorCampos[clave] : null;
    if (!control || control.tagName === "SPAN") return;
    control.focus();
    if (control.tagName === "TEXTAREA") {
      // Las filas se escriben por abajo: el caret va al final.
      const fin = control.value.length;
      control.setSelectionRange(fin, fin);
    } else {
      control.select();
    }
  }

  /** Inspector: se oculta sin widget elegido y, con él, enseña solo los campos de su tipo. */
  function syncUiControls() {
    const n = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? selUi : null;
    selUi = n;
    if (!el.inspect) return;
    el.inspect.hidden = !n;
    if (!n) return;
    const campos = UI_CAMPOS[n.kind] || [];
    for (const clave of UI_ORDEN) {
      const fila = inspectorFilas[clave];
      if (fila) fila.hidden = campos.indexOf(clave) < 0;
    }
    const poner = (clave, valor) => {
      const c = inspectorCampos[clave];
      if (!c) return;
      if (c.tagName === "SPAN") c.textContent = valor == null ? "" : String(valor);
      else if (c.type === "checkbox") c.checked = Boolean(valor);
      else c.value = valor == null ? "" : String(valor);
    };
    poner("title", n.title);
    poner("text", n.text);
    poner("placeholder", n.placeholder);
    poner("items", n.items.join("\n"));
    poner("options", n.options.join("\n"));
    poner("checked", n.checked.join(", "));
    poner("disabled", n.disabled);
    poner("icons", n.icons);
    poner("scroll", n.scroll);
    poner("src", n.src ? "Cargada" : "Sin imagen");
    if (campos.indexOf("variant") >= 0) {
      const pares =
        n.kind === "choice"
          ? [["", "NINGUNA"], ["check", "CASILLA"], ["radio", "RADIO"]]
          : [["", "NINGUNA"], ["primary", "PRIMARIA"], ["secondary", "SECUNDARIA"]];
      llenarOpciones(inspectorCampos.variant, pares, n.variant);
    }
    if (campos.indexOf("align") >= 0) {
      llenarOpciones(
        inspectorCampos.align,
        [["left", "IZQUIERDA"], ["center", "CENTRO"], ["right", "DERECHA"]],
        n.align
      );
    }
    if (campos.indexOf("active") >= 0) {
      const abierta = n.kind === "tabs-h" || n.kind === "tabs-v";
      const pares = n.items.map((t, i) => [String(i), `${i + 1}. ${t || "fila"}`]);
      llenarOpciones(inspectorCampos.active, abierta ? pares : [["-1", "NINGUNA"], ...pares], String(n.active));
    }
    pintaEstilo();
  }

  /** Marca los chips y botones del bloque ESTILO y de los extras del tipo elegido. */
  function pintaEstilo() {
    const n = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? selUi : null;
    if (!n) return;
    const seis = (valor, defecto) => (/^#[0-9a-f]{6}$/i.test(valor) ? valor : defecto);
    const color = (clave, valor) => {
      const c = inspectorCampos[clave];
      if (c) c.value = valor;
    };
    color("fill", seis(n.fill, "#ffffff"));
    color("stroke", seis(n.stroke, "#111111"));
    color("titleColor", seis(n.titleColor, "#111111"));
    const tam = inspectorCampos.titleSize;
    if (tam) tam.value = String(n.titleSize || 12);
    // Un chip encendido es un `aria-pressed` y su clase: el resto de marcas, igual.
    const marca = (boton, activo) => {
      if (!boton) return;
      boton.classList.toggle("on", activo);
      boton.setAttribute("aria-pressed", activo ? "true" : "false");
    };
    marca(inspectorMarcas.fillAuto, n.fill === "auto");
    marca(inspectorMarcas.fillNone, n.fill === "none");
    marca(inspectorMarcas.strokeNone, n.stroke === "none");
    marca(inspectorMarcas.orientH, n.orientation === "h");
    marca(inspectorMarcas.orientV, n.orientation !== "h");
    for (const [nombre, boton] of Object.entries(inspectorMarcas.iconos || {})) {
      marca(boton, nombre === n.icon);
    }
  }

  /**
   * Bloque ESTILO: aplica **solo** el campo tocado (los demás no se pisan) y no repinta los
   * controles mientras se escribe: normalizar el número a cada tecla impediría teclear «45».
   * `cerrar` es el final del gesto: ahí sí se reescriben valores (el número acotado) y chips.
   */
  function aplicarEstilo(clave, cerrar) {
    const n = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? selUi : null;
    if (!n) return;
    let cambia = false;
    const hex = (control) => {
      const valor = control ? String(control.value).toLowerCase() : "";
      return /^#[0-9a-f]{6}$/.test(valor) ? valor : "";
    };
    if (clave === "fill") {
      const fondo = hex(inspectorCampos.fill);
      if (fondo && n.fill !== fondo) {
        n.fill = fondo;
        cambia = true;
      }
    } else if (clave === "stroke") {
      const borde = hex(inspectorCampos.stroke);
      if (borde && n.stroke !== borde) {
        n.stroke = borde;
        cambia = true;
      }
    } else if (clave === "titleColor") {
      const tinta = hex(inspectorCampos.titleColor);
      if (tinta && n.titleColor !== tinta) {
        n.titleColor = tinta;
        cambia = true;
      }
    } else if (clave === "titleSize") {
      const control = inspectorCampos.titleSize;
      const valor = control ? clamp(Math.round(Number(control.value) || 12), 8, 48) : n.titleSize;
      if (n.titleSize !== valor) {
        n.titleSize = valor;
        cambia = true;
      }
    }
    if (cambia) changed();
    if (cerrar) pintaEstilo();
  }

  /** Escribe un campo de estilo desde un chip o un botón: un gesto, una entrada de historial. */
  function fijaEstilo(clave, valor) {
    const n = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? selUi : null;
    if (!n || n[clave] === valor) {
      pintaEstilo();
      return;
    }
    n[clave] = valor;
    changed();
    commit();
    pintaEstilo();
  }

  /** Vuelca el inspector sobre el widget elegido. `changed` en cada tecla; `commit` al cerrar. */
  function aplicarInspector() {
    const n = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? selUi : null;
    if (!n) return;
    const campos = UI_CAMPOS[n.kind] || [];
    const valor = (clave) => {
      const c = inspectorCampos[clave];
      if (!c) return "";
      if (c.tagName === "SPAN") return c.textContent;
      return c.type === "checkbox" ? c.checked : String(c.value);
    };
    const listas = (clave) =>
      valor(clave)
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    const iguales = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    let cambia = false;
    for (const clave of campos) {
      // `src` es solo lectura; `icon` y `orientation` los ponen sus botones, no un campo.
      if (clave === "src" || clave === "icon" || clave === "orientation") continue;
      if (clave === "items") {
        const lista = listas("items");
        if (!iguales(lista, n.items)) {
          n.items = lista;
          n.active = Math.min(n.active, lista.length - 1);
          cambia = true;
        }
      } else if (clave === "options") {
        const lista = listas("options");
        if (!iguales(lista, n.options)) {
          n.options = lista;
          n.checked = n.checked.filter((i) => i < lista.length);
          cambia = true;
        }
      } else if (clave === "active") {
        const i = parseInt(valor("active"), 10);
        const entero = Number.isFinite(i) ? i : -1;
        if (n.active !== entero) {
          n.active = entero;
          cambia = true;
        }
      } else if (clave === "checked") {
        const indices = valor("checked")
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((i) => Number.isFinite(i) && i >= 0 && i < n.options.length);
        if (!iguales(indices, n.checked)) {
          n.checked = indices;
          cambia = true;
        }
      } else if (clave === "disabled") {
        if (n.disabled !== valor("disabled")) {
          n.disabled = valor("disabled");
          cambia = true;
        }
      } else if (n[clave] !== valor(clave)) {
        n[clave] = valor(clave);
        cambia = true;
      }
    }
    if (cambia) changed();
  }

  /** Icono SVG de 24×24 con el mismo trazo que el resto del panel. */
  function svgIcono(d) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  }

  /** Rótulo de sección del cajón: hace de separador fino entre bloques. */
  function seccion(titulo, d) {
    const caja = document.createElement("div");
    caja.className = "pz-ui-sec";
    if (d) caja.append(svgIcono(d));
    const texto = document.createElement("span");
    texto.textContent = titulo;
    caja.append(texto);
    return caja;
  }

  /** Botón de icono del inspector: solo trazo, con `title` y `aria-label` en español. */
  function botonIcono(clase, d, titulo, fn) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = clase;
    boton.title = titulo;
    boton.setAttribute("aria-label", titulo);
    boton.append(svgIcono(d));
    boton.addEventListener("click", fn);
    return boton;
  }

  /** Paleta del cajón: un botón por tipo, agrupados como los declara la librería. */
  function construirPaleta() {
    if (!el.palette) return;
    if (!PZUi) {
      const nota = document.createElement("p");
      nota.className = "pz-ui-nota";
      nota.textContent = "La capa INTERFACES no se ha cargado: no hay paleta de widgets.";
      el.palette.append(nota);
      return;
    }
    const grupos = new Map();
    for (const k of PZUi.KINDS) {
      if (!grupos.has(k.group)) grupos.set(k.group, []);
      grupos.get(k.group).push(k);
    }
    for (const [grupo, lista] of grupos) {
      const rotulo = document.createElement("div");
      rotulo.className = "pz-ui-grp";
      rotulo.textContent = grupo === "contenedor" ? "CONTENEDORES" : "CONTROLES";
      const rejilla = document.createElement("div");
      rejilla.className = "pz-ui-grid";
      for (const k of lista) {
        const meta = UI_PALETA[k.kind] || { label: k.label, d: "M4 4h16v16H4z" };
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "pz-ui-btn";
        const texto = document.createElement("span");
        texto.textContent = meta.label;
        boton.append(svgIcono(meta.d), texto);
        boton.title = `Colocar ${meta.label.toLowerCase()} en la capa INTERFACES`;
        boton.setAttribute("aria-label", boton.title);
        boton.setAttribute("aria-pressed", "false");
        paletaBotones.push(boton);
        boton.addEventListener("click", () => armarUi(k.kind, boton));
        rejilla.append(boton);
      }
      el.palette.append(rotulo, rejilla);
    }
  }

  /** Fila del bloque ESTILO: rótulo arriba y los controles en línea. */
  function filaEstilo(etiqueta) {
    const fila = document.createElement("div");
    fila.className = "pz-ui-field pz-ui-fila";
    const rotulo = document.createElement("span");
    rotulo.textContent = etiqueta;
    const caja = document.createElement("span");
    caja.className = "pz-ui-ctl";
    fila.append(rotulo, caja);
    return { fila, caja };
  }

  /** Chip de dos estados (AUTO / SIN): el activo se marca con `.on` y `aria-pressed`. */
  function chip(texto, titulo, fn) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "pz-ui-chip";
    boton.textContent = texto;
    boton.title = titulo;
    boton.setAttribute("aria-label", titulo);
    boton.setAttribute("aria-pressed", "false");
    boton.addEventListener("click", fn);
    return boton;
  }

  /** Inspector del cajón: se crea una vez y se rellena al elegir widget. */
  function construirInspector() {
    if (!el.inspect) return;
    for (const clave of UI_ORDEN) {
      const editor = UI_EDITOR[clave];
      // Los campos compuestos (rejilla de iconos, orientación) van en un `div`: un `label` con
      // varios botones dentro reparte el clic al primero.
      const compuesto = editor.tag === "iconos" || editor.tag === "orientacion";
      // Toda casilla va en fila, como APAGADO: rótulo a la izquierda y la casilla a la derecha.
      const casilla = editor.tag === "checkbox";
      const fila = document.createElement(compuesto ? "div" : "label");
      fila.className = casilla ? "pz-ui-field pz-ui-check" : "pz-ui-field";
      fila.hidden = true;
      const rotulo = document.createElement("span");
      rotulo.textContent = editor.etiqueta;
      let control;
      if (editor.tag === "textarea") {
        control = document.createElement("textarea");
        control.rows = 3;
      } else if (editor.tag === "select") {
        control = document.createElement("select");
      } else if (editor.tag === "nota") {
        // Valor de solo lectura (`src`): un span, no un campo que se pueda escribir.
        control = document.createElement("span");
        control.className = "pz-ui-valor";
      } else if (compuesto) {
        // Rejilla de botones: el valor lo pone el clic, no un campo.
        control = document.createElement("span");
        control.className = editor.tag === "iconos" ? "pz-ui-icons" : "pz-ui-ctl";
        if (editor.tag === "iconos") {
          inspectorMarcas.iconos = {};
          for (const nombre of Object.keys(PZFlow.ICONS)) {
            const boton = botonIcono("pz-ui-ico", PZFlow.ICONS[nombre], `Icono ${nombre}`, () => fijaEstilo("icon", nombre));
            inspectorMarcas.iconos[nombre] = boton;
            control.append(boton);
          }
        } else {
          inspectorMarcas.orientH = botonIcono(
            "pz-ui-ico",
            "M4 12h16M16 8l4 4-4 4",
            "Menú horizontal",
            () => fijaEstilo("orientation", "h")
          );
          inspectorMarcas.orientV = botonIcono(
            "pz-ui-ico",
            "M12 4v16M8 16l4 4 4-4",
            "Menú vertical",
            () => fijaEstilo("orientation", "v")
          );
          control.append(inspectorMarcas.orientH, inspectorMarcas.orientV);
        }
      } else {
        control = document.createElement("input");
        control.type = editor.tag === "checkbox" ? "checkbox" : "text";
      }
      fila.append(rotulo, control);
      inspectorCampos[clave] = control;
      inspectorFilas[clave] = fila;
      el.inspect.append(fila);
      if (control.tagName === "SPAN") {
        // El valor de solo lectura no se edita: su `title` explica de dónde sale y el rótulo de
        // la fila ya lo nombra, así que el valor se queda sin `aria-label` propio.
        if (editor.tag === "nota") control.title = "La imagen se pega con Ctrl+V";
        continue;
      }
      control.title = editor.etiqueta;
      control.setAttribute("aria-label", editor.etiqueta);
      if (control.tagName === "INPUT" && control.type !== "checkbox") control.spellcheck = false;
      control.addEventListener("input", () => aplicarInspector());
      control.addEventListener("change", () => {
        aplicarInspector();
        commit();
      });
    }

    // ── ESTILO: fondo, borde y texto, iguales en todos los tipos ──
    el.inspect.append(seccion("ESTILO", "M4 20l6-6M12 4h8v8M20 4l-8 8M4 4h6v6H4z"));
    const fondo = filaEstilo("FONDO");
    inspectorCampos.fill = document.createElement("input");
    inspectorCampos.fill.type = "color";
    inspectorCampos.fill.className = "pz-ui-color";
    inspectorCampos.fill.title = "Color de fondo del widget";
    inspectorCampos.fill.setAttribute("aria-label", "Color de fondo del widget");
    inspectorMarcas.fillAuto = chip("AUTO", "Fondo del tipo, sin color propio", () => fijaEstilo("fill", "auto"));
    inspectorMarcas.fillNone = chip("SIN", "Sin fondo: deja ver lo que hay debajo", () => fijaEstilo("fill", "none"));
    fondo.caja.append(inspectorCampos.fill, inspectorMarcas.fillAuto, inspectorMarcas.fillNone);
    el.inspect.append(fondo.fila);

    const borde = filaEstilo("BORDE");
    inspectorCampos.stroke = document.createElement("input");
    inspectorCampos.stroke.type = "color";
    inspectorCampos.stroke.className = "pz-ui-color";
    inspectorCampos.stroke.title = "Color del borde del widget";
    inspectorCampos.stroke.setAttribute("aria-label", "Color del borde del widget");
    inspectorMarcas.strokeNone = chip("SIN", "Sin borde", () => fijaEstilo("stroke", "none"));
    borde.caja.append(inspectorCampos.stroke, inspectorMarcas.strokeNone);
    el.inspect.append(borde.fila);

    const texto = filaEstilo("TEXTO");
    inspectorCampos.titleColor = document.createElement("input");
    inspectorCampos.titleColor.type = "color";
    inspectorCampos.titleColor.className = "pz-ui-color";
    inspectorCampos.titleColor.title = "Color del texto del widget";
    inspectorCampos.titleColor.setAttribute("aria-label", "Color del texto del widget");
    inspectorCampos.titleSize = document.createElement("input");
    inspectorCampos.titleSize.type = "number";
    inspectorCampos.titleSize.min = "8";
    inspectorCampos.titleSize.max = "48";
    inspectorCampos.titleSize.step = "1";
    inspectorCampos.titleSize.className = "pz-ui-num";
    inspectorCampos.titleSize.title = "Cuerpo del texto del widget, en píxeles (8 a 48)";
    inspectorCampos.titleSize.setAttribute("aria-label", "Cuerpo del texto del widget, en píxeles (8 a 48)");
    texto.caja.append(inspectorCampos.titleColor, inspectorCampos.titleSize);
    el.inspect.append(texto.fila);

    // El selector nativo no emite `input` si se elige el color que ya vale. Con `fill` a «auto»
    // o «sin» el control muestra blanco, y elegir blanco no haría nada: antes de abrirlo se deja
    // un color casi igual (`CASI`) que no se va a elegir. Si se cierra sin elegir, el `change`
    // devuelve el control a lo guardado y no toca el widget.
    const CASI = { fill: "#feffff", stroke: "#fefefe" };
    const evitaRepetido = (clave) => {
      const control = inspectorCampos[clave];
      control.addEventListener("click", () => {
        const n = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? selUi : null;
        if (n && !/^#[0-9a-f]{6}$/i.test(String(n[clave]))) control.value = CASI[clave];
      });
    };
    evitaRepetido("fill");
    evitaRepetido("stroke");

    for (const clave of ["fill", "stroke", "titleColor", "titleSize"]) {
      const control = inspectorCampos[clave];
      control.addEventListener("input", () => aplicarEstilo(clave, false));
      control.addEventListener("change", () => {
        // Sin elección real el control sigue en el color de relleno: se repinta y no se escribe.
        if (CASI[clave] && String(control.value).toLowerCase() === CASI[clave]) {
          pintaEstilo();
          return;
        }
        aplicarEstilo(clave, true);
        commit();
      });
    }

    // ── ACCIONES: solo icono, con su rótulo en `title` ──
    const acciones = document.createElement("div");
    acciones.className = "pz-ui-actions";
    const hechos = {
      subir: () => moverUi(1),
      bajar: () => moverUi(-1),
      extraer: extraerUi,
      borrar: () => deleteSelected(),
    };
    for (const accion of UI_ACCIONES) {
      acciones.append(botonIcono("pz-ui-act", accion.d, accion.title, hechos[accion.id]));
    }
    el.inspect.append(acciones);
  }

  // ── Conectores ────────────────────────────────────────────

  function nodosPorId() {
    const mapa = Object.create(null);
    for (const n of state.flow.nodes) mapa[n.id] = n;
    return mapa;
  }

  /** Clave de carril: mismo par de nodos y mismo sentido. */
  let carriles = null;

  function clavePar(e) {
    const a = e.from.node ? "n:" + e.from.node : "p@" + red(e.from.x || 0) + "," + red(e.from.y || 0);
    const b = e.to.node ? "n:" + e.to.node : "p@" + red(e.to.x || 0) + "," + red(e.to.y || 0);
    return a + ">" + b;
  }

  function carrilDe(e) {
    if (!carriles) {
      carriles = new Map();
      const vistos = new Map();
      for (const otra of state.flow.edges) {
        const clave = clavePar(otra);
        const i = vistos.get(clave) || 0;
        carriles.set(otra.id, i);
        vistos.set(clave, i + 1);
      }
    }
    return carriles.get(e.id) || 0;
  }

  function arrowsTexto(e) {
    if (e.startArrow && e.endArrow) return "both";
    if (e.startArrow) return "back";
    return e.endArrow ? "arrow" : "none";
  }

  function extremoDe(e, nodos) {
    if (e.from.node) return nodos[e.from.node] || null;
    return { x: e.from.x, y: e.from.y };
  }

  function extremoHasta(e, nodos) {
    if (e.to.node) return nodos[e.to.node] || null;
    return { x: e.to.x, y: e.to.y };
  }

  /** Ruta de la arista con la forma que espera la librería. `null` si un extremo perdió su nodo. */
  function rutaDe(e) {
    const nodos = nodosPorId();
    const desde = extremoDe(e, nodos);
    const hasta = extremoHasta(e, nodos);
    if (!desde || !hasta) return null;
    return PZFlow.routeEdge(
      {
        from: desde,
        to: hasta,
        fromSide: e.from.node ? e.from.side : null,
        toSide: e.to.node ? e.to.side : null,
        waypoints: e.waypoints,
        dashed: e.dash,
        arrows: arrowsTexto(e),
      },
      nodos,
      carrilDe(e)
    );
  }

  function punta(t, desde, hasta, color, tamano) {
    const p = PZFlow.arrowHead(desde, hasta, tamano);
    t.beginPath();
    t.moveTo(p.tip.x, p.tip.y);
    t.lineTo(p.a.x, p.a.y);
    t.lineTo(p.b.x, p.b.y);
    t.closePath();
    t.fillStyle = color;
    t.fill();
  }

  function dibujaArista(t, e) {
    const r = rutaDe(e);
    if (!r || r.points.length < 2) return;
    const pts = r.points;
    t.save();
    t.strokeStyle = e.color;
    t.lineWidth = e.width;
    t.lineJoin = "round";
    t.lineCap = "butt";
    if (e.dash) t.setLineDash([e.width * 3 + 6, e.width * 2 + 4]);
    PZFlow.roundedPath(t, pts, 10);
    t.stroke();
    t.setLineDash([]);
    const tamano = 8 + e.width * 1.4;
    if (e.endArrow) punta(t, pts[pts.length - 2], pts[pts.length - 1], e.color, tamano);
    if (e.startArrow) punta(t, pts[1], pts[0], e.color, tamano);
    if (e.label) {
      const p = puntoEtiqueta(e, r);
      t.font = `600 ${TEXTO_ARISTA}px sans-serif`;
      t.textAlign = "center";
      t.textBaseline = "middle";
      t.lineJoin = "round";
      // Halo del color de fondo: la etiqueta se lee aunque la línea le pase por debajo.
      t.strokeStyle = state.bg.color;
      t.lineWidth = 4;
      t.strokeText(e.label, p.x, p.y);
      t.fillStyle = e.color;
      t.fillText(e.label, p.x, p.y);
    }
    t.restore();
  }

  function puntoEtiqueta(e, ruta) {
    const r = ruta || rutaDe(e);
    const base = r ? r.label : { x: 0, y: 0 };
    return { x: base.x + (e.labelOffset ? e.labelOffset.dx : 0), y: base.y + (e.labelOffset ? e.labelOffset.dy : 0) };
  }

  // ── Composición ───────────────────────────────────────────

  function dibujaRejilla(t) {
    if (!rejilla) return;
    if (REJILLA * pantallaEscala() < 3) return; // a 15 % serían una mancha
    t.save();
    t.strokeStyle = "rgba(0, 229, 255, 0.12)";
    t.lineWidth = Math.max(0.5, px(1));
    t.beginPath();
    for (let x = 0; x <= W; x += REJILLA) {
      t.moveTo(x + 0.5, 0);
      t.lineTo(x + 0.5, H);
    }
    for (let y = 0; y <= H; y += REJILLA) {
      t.moveTo(0, y + 0.5);
      t.lineTo(W, y + 0.5);
    }
    t.stroke();
    t.restore();
  }

  function compose() {
    ctx.clearRect(0, 0, W, H);
    if (fondoVisible) {
      ctx.fillStyle = state.bg.color;
      ctx.fillRect(0, 0, W, H);
      const bg = state.bg.image;
      if (bg) {
        const box = fitInside(bg.width, bg.height);
        ctx.drawImage(bg.drawable, box.x, box.y, box.w, box.h);
      }
      // La rejilla es una guía: no viaja en el PNG exportado.
      if (!exportando) dibujaRejilla(ctx);
    }
    if (state.layers.flow !== false) {
      for (const e of state.flow.edges) dibujaArista(ctx, e);
      for (const n of state.flow.nodes) dibujaNodo(ctx, n);
    }
    if (state.layers.ui !== false && PZUi) {
      // El zoom que pide la librería es el mismo que usa `px()`: píxeles de pantalla por píxel
      // de lienzo (el lienzo va estirado por CSS, así el trazo mide igual a cualquier zoom).
      // El mapa de imágenes ya decodificadas es la misma caché que usan la escena y el pegado.
      // `hints` enciende la ayuda de etiqueta vacía: en pantalla sí, en el PNG exportado no.
      PZUi.draw(ctx, state.ui.nodes, pantallaEscala(), cacheImagenes, !exportando);
    }
    if (state.layers.images !== false) {
      for (const img of state.images) {
        ctx.save();
        ctx.translate(img.x + img.w / 2, img.y + img.h / 2);
        ctx.rotate(img.rot);
        ctx.drawImage(img.drawable, -img.w / 2, -img.h / 2, img.w, img.h);
        ctx.restore();
      }
    }
    // Mientras se dibuja, `live` ya incluye lo confirmado: no se pinta dos veces.
    if (state.layers.strokes !== false) {
      ctx.drawImage(drag && drag.kind === "draw" ? live : committed, 0, 0);
    }
    if (state.layers.texts !== false) {
      for (const t of state.texts) {
        // El bloque en edición lo escribe el `textarea` encima: en pantalla no se pinta (si no,
        // sale doble), pero en el PNG exportado sí tiene que estar.
        if (t !== editing || exportando) drawText(t);
      }
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
    version++;
    carriles = null;
    redraw();
    dirty = true;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(flushSnapshot, 600);
  }

  /**
   * Escena para el host, o `null` si pasa del tope. Se serializa UNA vez: el host rechazaría
   * la escena entera y el usuario se enteraría después; mejor decirlo aquí.
   */
  function escenaParaEnviar() {
    const doc = escena();
    if (JSON.stringify(doc).length <= MAX_ESCENA) return doc;
    setStatus(
      "La escena pasa del tope de tamaño y no se guarda: solo queda el PNG. Al reabrir la pizarra no podrás editar el diagrama.",
      "error"
    );
    return null;
  }

  /** `capture` contesta al momento; el resto va con reposo de 600 ms. */
  function flushSnapshot() {
    // Sin el `init` aplicado, la escena es un lienzo vacío: guardarla pisaría el dibujo bueno.
    // El panel mide el marco antes de recibir la escena y eso marca `dirty`, así que la guarda
    // se pospone hasta que la escena esté puesta.
    if (!dirty || !iniciada) return;
    dirty = false;
    vscode.postMessage({ type: "snapshot", board: pizarraActual, png: pngBase64(), scene: escenaParaEnviar() });
  }

  // ── Escena (contrato con el host) ─────────────────────────

  function extremoEscena(punto) {
    if (punto.node) return { node: punto.node, side: punto.side || "auto" };
    return { x: red(punto.x), y: red(punto.y) };
  }

  function escena() {
    return {
      v: 1,
      canvas: { w: W, h: H, fixed: fijado },
      bg: { color: state.bg.color, image: state.bg.image && state.bg.image.src ? state.bg.image.src : null },
      flow: {
        nodes: state.flow.nodes.map((n) => ({
          id: n.id,
          shape: n.shape,
          x: red(n.x),
          y: red(n.y),
          w: red(n.w),
          h: red(n.h),
          text: n.text || "",
          fill: n.fill,
          stroke: n.stroke,
          textColor: n.textColor,
          fontSize: n.fontSize,
          weight: n.weight,
          align: n.align,
          icon: n.icon,
          iconColor: HEX.test(n.iconColor) ? n.iconColor : "#14232b",
        })),
        edges: state.flow.edges.map((e) => ({
          id: e.id,
          from: extremoEscena(e.from),
          to: extremoEscena(e.to),
          label: e.label || "",
          color: e.color,
          width: e.width,
          dash: Boolean(e.dash),
          startArrow: Boolean(e.startArrow),
          endArrow: Boolean(e.endArrow),
          waypoints: (e.waypoints || []).map((w) => ({ x: red(w.x), y: red(w.y) })),
          labelOffset: { dx: red(e.labelOffset ? e.labelOffset.dx : 0), dy: red(e.labelOffset ? e.labelOffset.dy : 0) },
        })),
      },
      ui: {
        nodes: state.ui.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          parent: n.parent == null ? null : n.parent,
          x: red(n.x),
          y: red(n.y),
          w: red(n.w),
          h: red(n.h),
          title: n.title || "",
          text: n.text || "",
          placeholder: n.placeholder || "",
          items: n.items.slice(),
          active: n.active,
          options: n.options.slice(),
          checked: n.checked.slice(),
          variant: n.variant || "",
          align: n.align || "left",
          icon: n.icon || "",
          src: n.src || "",
          disabled: Boolean(n.disabled),
          icons: Boolean(n.icons),
          scroll: Boolean(n.scroll),
          fill: n.fill || "auto",
          stroke: n.stroke || "#111111",
          titleColor: n.titleColor || "#111111",
          titleSize: n.titleSize || 12,
          orientation: n.orientation || "v",
        })),
      },
      images: state.images
        .filter((i) => Boolean(i.src))
        .map((i) => ({ src: i.src, x: red(i.x), y: red(i.y), w: red(i.w), h: red(i.h), rot: i.rot })),
      strokes: state.strokes.map((s) => ({
        erase: Boolean(s.erase),
        color: s.color,
        size: s.size,
        hard: s.hard,
        pts: s.pts.map((p) => [red(p.x), red(p.y)]),
      })),
      texts: state.texts.map((t) => ({
        text: t.text,
        x: red(t.x),
        y: red(t.y),
        w: red(t.w),
        h: red(t.h),
        rot: t.rot,
        color: t.color,
        size: t.size,
        family: t.family,
      })),
      layers: {
        flow: state.layers.flow !== false,
        ui: state.layers.ui !== false,
        images: state.layers.images !== false,
        strokes: state.layers.strokes !== false,
        texts: state.layers.texts !== false,
      },
    };
  }

  // ── Historial: una entrada por gesto ──────────────────────

  function actualizarUndo() {
    el.btnUndo.disabled = hIdx <= 0;
    el.btnRedo.disabled = hIdx < 0 || hIdx >= historia.length - 1;
  }

  function reiniciarHistorial() {
    historia = [{ v: version, doc: escena() }];
    hIdx = 0;
    actualizarUndo();
  }

  /** Consolida el gesto si algo cambió desde la última entrada: solo entonces serializa. */
  function commit() {
    if (guardandoHistoria || hIdx < 0) return;
    if (historia[hIdx] && historia[hIdx].v === version) return;
    historia = historia.slice(0, hIdx + 1);
    historia.push({ v: version, doc: escena() });
    if (historia.length > HIST_MAX) historia.shift();
    hIdx = historia.length - 1;
    actualizarUndo();
  }

  /** Corta el gesto vivo: deshacer no debe dejar un arrastre a medias. */
  function cortarGesto() {
    drag = null;
    guias = [];
    pintaCursorPan();
    hoverNode = null;
    pintaCursor("");
  }

  async function deshacer() {
    if (hIdx <= 0) return;
    cerrarEditores(true);
    cortarGesto();
    hIdx--;
    await aplicarEscena(historia[hIdx].doc, { mantenerVista: true });
    // Solo la copia de trabajo: restaurar no es un gesto nuevo.
    changed();
    actualizarUndo();
    setStatus("Deshecho.");
  }

  async function rehacer() {
    if (hIdx < 0 || hIdx >= historia.length - 1) return;
    cerrarEditores(true);
    cortarGesto();
    hIdx++;
    await aplicarEscena(historia[hIdx].doc, { mantenerVista: true });
    changed();
    actualizarUndo();
    setStatus("Rehecho.");
  }

  // ── Aplicar una escena (arranque y deshacer) ──────────────

  function nodoDeEscena(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
    const shape = PZFlow.SHAPES.indexOf(raw.shape) >= 0 ? raw.shape : "rect";
    return {
      type: "node",
      id: raw.id,
      shape,
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      w: Math.max(1, num(raw.w, NODO_W)),
      h: Math.max(1, num(raw.h, NODO_H)),
      text: typeof raw.text === "string" ? raw.text : "",
      fill: raw.fill === "none" || HEX.test(raw.fill) ? raw.fill.toLowerCase() : "#ffffff",
      stroke: HEX.test(raw.stroke) ? raw.stroke.toLowerCase() : "#5b7385",
      textColor: raw.textColor === "auto" ? "auto" : HEX.test(raw.textColor) ? raw.textColor.toLowerCase() : "auto",
      fontSize: clamp(num(raw.fontSize, 18), 6, 300),
      weight: raw.weight === 700 || raw.weight === 600 || raw.weight === 400 ? raw.weight : 400,
      align: raw.align === "left" || raw.align === "right" ? raw.align : "center",
      icon: typeof raw.icon === "string" && PZFlow.ICONS[raw.icon] ? raw.icon : "mail",
      iconColor: HEX.test(raw.iconColor) ? raw.iconColor.toLowerCase() : "#14232b",
    };
  }

  function extremoDeEscena(raw, ids) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.node === "string") {
      if (!ids.has(raw.node)) return null;
      const lado = PZFlow.SIDES.indexOf(raw.side) >= 0 ? raw.side : "auto";
      return { node: raw.node, side: lado };
    }
    if (typeof raw.x === "number" && typeof raw.y === "number") return { x: raw.x, y: raw.y };
    return null;
  }

  function aristaDeEscena(raw, ids) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
    const from = extremoDeEscena(raw.from, ids);
    const to = extremoDeEscena(raw.to, ids);
    if (!from || !to) return null;
    return {
      type: "edge",
      id: raw.id,
      from,
      to,
      label: typeof raw.label === "string" ? raw.label : "",
      color: HEX.test(raw.color) ? raw.color.toLowerCase() : "#3d5566",
      width: clamp(num(raw.width, 2), 0.5, 20),
      dash: raw.dash === true,
      startArrow: raw.startArrow === true,
      endArrow: raw.endArrow !== false,
      waypoints: Array.isArray(raw.waypoints)
        ? raw.waypoints
            .filter((w) => w && typeof w.x === "number" && typeof w.y === "number")
            .map((w) => ({ x: w.x, y: w.y }))
        : [],
      labelOffset: {
        dx: num(raw.labelOffset && raw.labelOffset.dx, 0),
        dy: num(raw.labelOffset && raw.labelOffset.dy, 0),
      },
    };
  }

  /**
   * Vuelca una escena del host (o del historial) sobre el lienzo. Las imágenes se decodifican
   * aparte y una rota se descarta con aviso: no aborta la carga.
   */
  async function aplicarEscena(doc, opciones) {
    const opts = opciones || {};
    // Restaurar no es un gesto: lo que cierren los editores no entra en el historial.
    const guardadoAntes = guardandoHistoria;
    guardandoHistoria = true;
    cerrarEditores(true);
    drag = null;
    guias = [];
    hoverNode = null;
    limpiarSeleccion();
    // Lo armado en la paleta no sobrevive a un cambio de escena: el clic caería en otra pizarra.
    desarmar();
    const v0 = { z: view.z, tx: view.tx, ty: view.ty };
    const canvas = doc && doc.canvas ? doc.canvas : {};
    if (canvas.fixed) {
      fijarLienzo(num(canvas.w, W), num(canvas.h, H));
    } else {
      fijado = false;
      H = SIZE;
      medirMarco(true);
    }
    if (opts.mantenerVista) {
      view.z = v0.z;
      view.tx = v0.tx;
      view.ty = v0.ty;
      aplicaVista();
    }

    const bg = doc && doc.bg ? doc.bg : {};
    state.bg = { color: HEX.test(bg.color) ? bg.color.toLowerCase() : el.bgColor.value || BG_DEFAULT, image: null };
    el.bgColor.value = state.bg.color;
    if (typeof bg.image === "string" && bg.image) {
      try {
        const img = await imagenDe(bg.image);
        state.bg.image = { drawable: img, width: img.width, height: img.height, src: bg.image };
      } catch {
        setStatus("La imagen de fondo de la escena no se ha podido leer.", "error");
      }
    }

    const capas = doc && doc.layers ? doc.layers : {};
    state.layers = {
      flow: capas.flow !== false,
      ui: capas.ui !== false,
      images: capas.images !== false,
      strokes: capas.strokes !== false,
      texts: capas.texts !== false,
    };

    const usados = new Set();
    const nodos = doc && doc.flow && Array.isArray(doc.flow.nodes) ? doc.flow.nodes : [];
    state.flow.nodes = [];
    for (const raw of nodos) {
      const n = nodoDeEscena(raw);
      if (!n) continue;
      if (usados.has(n.id)) n.id = PZFlow.newId("n");
      usados.add(n.id);
      state.flow.nodes.push(n);
    }
    const aristas = doc && doc.flow && Array.isArray(doc.flow.edges) ? doc.flow.edges : [];
    state.flow.edges = [];
    const idsArista = new Set();
    for (const raw of aristas) {
      const e = aristaDeEscena(raw, usados);
      if (!e) continue;
      if (idsArista.has(e.id)) e.id = PZFlow.newId("e");
      idsArista.add(e.id);
      state.flow.edges.push(e);
    }

    // Imágenes: en serie, con aviso por cada una que no se pueda leer.
    state.images = [];
    for (const raw of Array.isArray(doc && doc.images) ? doc.images : []) {
      if (!raw || typeof raw.src !== "string") continue;
      try {
        const img = await imagenDe(raw.src);
        state.images.push({
          type: "image",
          drawable: img,
          src: raw.src,
          x: num(raw.x, 0),
          y: num(raw.y, 0),
          w: Math.max(1, num(raw.w, img.width)),
          h: Math.max(1, num(raw.h, img.height)),
          rot: num(raw.rot, 0),
        });
      } catch {
        setStatus("Una imagen de la escena no se ha podido leer: se descarta.", "error");
      }
    }

    // INTERFACES: la escena puede no traerla (pizarras de antes de la capa).
    state.ui = { nodes: uiDeEscena(doc && doc.ui ? doc.ui.nodes : null) };
    // Las imágenes de los widgets se decodifican aquí, en serie: `cacheImagenes` es el mapa que
    // `compose` le pasa a la librería. Una que no se puede leer se queda sin `src` (marcador).
    for (const widget of state.ui.nodes) {
      if (!widget.src) continue;
      try {
        await imagenDe(widget.src);
      } catch {
        widget.src = "";
        setStatus("La imagen de un widget no se ha podido leer: se queda sin ella.", "error");
      }
    }

    state.strokes = (Array.isArray(doc && doc.strokes) ? doc.strokes : [])
      .map((raw) => {
        const pts = Array.isArray(raw && raw.pts)
          ? raw.pts
              .filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number")
              .map((p) => ({ x: p[0], y: p[1] }))
          : [];
        if (!pts.length) return null;
        return {
          erase: raw.erase === true,
          color: HEX.test(raw.color) ? raw.color.toLowerCase() : "#000000",
          size: clamp(num(raw.size, 4), 1, 200),
          hard: clamp(num(raw.hard, 0.8), 0, 1),
          pts,
        };
      })
      .filter(Boolean);

    state.texts = (Array.isArray(doc && doc.texts) ? doc.texts : [])
      .map((raw) => {
        if (!raw || typeof raw.text !== "string" || !raw.text) return null;
        return {
          type: "text",
          text: raw.text,
          x: num(raw.x, 0),
          y: num(raw.y, 0),
          w: Math.max(1, num(raw.w, 240)),
          h: Math.max(1, num(raw.h, 40)),
          rot: num(raw.rot, 0),
          color: HEX.test(raw.color) ? raw.color.toLowerCase() : "#12303f",
          size: clamp(num(raw.size, 24), 6, 300),
          family: typeof raw.family === "string" ? raw.family : "sans-serif",
        };
      })
      .filter(Boolean);

    replayStrokes();
    paintLayers();
    actualizarContexto();
    // Los carriles dependen de los nodos: la caché de la escena anterior ya no vale.
    carriles = null;
    // La escena aplicada es una entrada consolidada: el contador vuelve a su versión.
    if (hIdx >= 0 && historia[hIdx]) version = historia[hIdx].v;
    redraw();
    guardandoHistoria = guardadoAntes;
  }

  // ── Capas y herramientas ──────────────────────────────────

  /** Qué capa manda ahora mismo: eso pintan los indicadores. */
  function activeLayer() {
    if (tool === "pen" || tool === "eraser") return "strokes";
    if (tool === "text") return "texts";
    if (tool === "node") return "flow";
    if (selUi) return "ui";
    if (selEdge || selNodes.length) return "flow";
    if (!sel) return "";
    return sel.type === "image" ? "images" : "texts";
  }

  function paintLayers() {
    const activa = activeLayer();
    for (const l of el.layers) {
      const clave = l.dataset.layer;
      if (clave === "bg") {
        l.setAttribute("aria-pressed", fondoVisible ? "true" : "false");
        l.classList.remove("on");
        continue;
      }
      const visible = state.layers[clave] !== false;
      l.setAttribute("aria-pressed", visible ? "true" : "false");
      l.classList.toggle("on", clave === activa);
    }
  }

  /** Abre el panel que toque en la ventana flotante; `null` la cierra sin tocar la herramienta. */
  function abrirPanel(clave) {
    panelAbierto = clave || null;
    el.drawer.hidden = !panelAbierto;
    el.drawerTitle.textContent = panelAbierto ? PANEL_TITULOS[panelAbierto] || "" : "";
    for (const p of el.panels) p.hidden = p.dataset.panel !== panelAbierto;
    // El botón INTERFAZ solo marca su propia ventana, no cualquier cajón abierto.
    const ui = panelAbierto === "ui";
    el.btnUi.classList.toggle("on", ui);
    el.btnUi.setAttribute("aria-pressed", ui ? "true" : "false");
  }

  /** Lo que depende de la selección dentro del panel abierto: ICONO y alinear. */
  function syncOpciones() {
    const icono =
      (selNodes.length && selNodes[0].shape === "icon") || (!selNodes.length && el.nodeShape.value === "icon");
    el.nodeIconField.hidden = !icono;
    // Alinear y repartir piden varios nodos.
    el.alignGroup.hidden = selNodes.length < 2;
  }

  function actualizarContexto() {
    if ((tool === "pen" || tool === "eraser") && state.layers.strokes === false) {
      setStatus("La capa TRAZOS está oculta: enciéndela con el chip TRAZOS o lo que pintes no se verá.", "error");
    } else if (tool === "pen") setStatus("LÁPIZ: arrastra para dibujar. La goma está en BORRADOR.");
    else if (tool === "eraser") setStatus("BORRADOR: arrastra sobre los trazos. La dureza del borde está en su ventana.");
    else if (tool === "text") setStatus("TEXTO: clic en el lienzo donde escribir; cierra con Ctrl+Enter o Escape.");
    else if (tool === "node")
      setStatus(
        `NODO: clic crea uno de ${ultimoTamano.w} × ${ultimoTamano.h}; arrastra para dibujarlo a ese tamaño. Doble clic edita su etiqueta.`
      );
    else if (selEdge)
      setStatus(
        "CONECTOR: arrastra un tramo para desviarlo, un codo para moverlo, o un extremo para reengancharlo; Alt+clic añade un codo y doble clic en la etiqueta la edita."
      );
    else if (selUi)
      setStatus(
        "INTERFAZ: arrastra para mover y tira de un asa para el tamaño; otro clic sobre el widget simula su control."
      );
    else if (selNodes.length > 1)
      setStatus(
        `${selNodes.length} nodos: arrastra para mover, flechas para ajustar; los iconos de alinear y repartir ordenan la selección.`
      );
    else if (selNodes.length === 1)
      setStatus("NODO: arrastra para mover; asas de esquina redimensionan y las azules conectan; doble clic edita.");
    else if (sel && sel.type === "text") setStatus("TEXTO: arrastra para mover; asas para el ancho y el giro.");
    else if (sel && sel.type === "image") setStatus("IMAGEN: arrastra para mover; asas para escalar y girar.");
    else setStatus("SELECCIONAR: doble clic edita lo que haya debajo; arrastra en el vacío para la marquesina.");
  }

  function setTool(next) {
    tool = next;
    // Cambiar de herramienta desarma la colocación de la paleta: su marca no puede quedar viva.
    desarmar();
    el.root.dataset.tool = next;
    for (const b of el.tools) b.classList.toggle("on", b.dataset.tool === next);
    // La ventana sigue a la herramienta. La paleta INTERFAZ no se cierra aquí: crear un widget
    // pasa por SELECT y dejaría la paleta sin abrir en cada clic.
    const propio = PANEL_DE_HERRAMIENTA[next];
    if (propio) abrirPanel(propio);
    else if (panelAbierto && panelAbierto !== "ui") abrirPanel(null);
    if (next !== "select" && next !== "node") cerrarEditores(false);
    // Pintar con la capa TRAZOS oculta es pintar a ciegas: se enciende al coger el lápiz o la goma.
    const capaApagada = (next === "pen" || next === "eraser") && state.layers.strokes === false;
    if (capaApagada) {
      state.layers.strokes = true;
      changed();
    }
    syncOpciones();
    paintLayers();
    actualizarContexto();
    if (capaApagada) setStatus("La capa TRAZOS estaba oculta: la enciendo para que se vea lo que pintes.", "ok");
    redraw();
  }

  // ── Selección ─────────────────────────────────────────────

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
        hs.push({ kind: "scale", corner: i, sx: sign[0], sy: sign[1], p: world(o, sign[0] * hw, sign[1] * hh) });
      });
    } else {
      hs.push({ kind: "width", side: -1, p: world(o, -hw, 0) });
      hs.push({ kind: "width", side: 1, p: world(o, hw, 0) });
    }
    hs.push({ kind: "rotate", p: world(o, 0, -hh - px(ROT_OFF)) });
    return hs;
  }

  function hitHandle(o, p) {
    const radio = px(HANDLE);
    for (const h of handlesOf(o)) {
      if (Math.abs(p.x - h.p.x) <= radio && Math.abs(p.y - h.p.y) <= radio) return h;
    }
    return null;
  }

  /** Textos e imágenes: dos listas, la de arriba primero. */
  function hitObject(p) {
    for (const list of [state.texts, state.images]) {
      const visible = list === state.texts ? state.layers.texts !== false : state.layers.images !== false;
      if (!visible) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const o = list[i];
        if (o.type === "text") layout(o);
        const l = local(o, p);
        if (Math.abs(l.x) <= o.w / 2 && Math.abs(l.y) <= o.h / 2) return o;
      }
    }
    return null;
  }

  function nodoEn(p) {
    if (state.layers.flow === false) return null;
    for (let i = state.flow.nodes.length - 1; i >= 0; i--) {
      if (PZFlow.hitNode(state.flow.nodes[i], p)) return state.flow.nodes[i];
    }
    return null;
  }

  function aristaEn(p) {
    if (state.layers.flow === false) return null;
    let mejor = null;
    let distancia = Infinity;
    for (let i = state.flow.edges.length - 1; i >= 0; i--) {
      const e = state.flow.edges[i];
      const r = rutaDe(e);
      if (!r || r.points.length < 2) continue;
      const golpe = PZFlow.segmentHit(r.points, p, px(EDGE_TOL));
      if (golpe.index >= 0 && golpe.distance < distancia) {
        mejor = e;
        distancia = golpe.distance;
      }
    }
    return mejor;
  }

  /** Asas de esquina de un nodo: redimensionar. */
  function asasEsquina(n) {
    const ancho = n.w;
    const alto = n.h;
    return CORNERS.map((c, i) => ({
      kind: "esquina",
      corner: i,
      sx: c.sx,
      sy: c.sy,
      p: { x: n.x + (c.sx > 0 ? ancho : 0), y: n.y + (c.sy > 0 ? alto : 0) },
    }));
  }

  /** Asas de los cuatro lados: de aquí sale un conector. */
  function asasLado(n) {
    return PZFlow.SIDES.map((s) => ({ kind: "lado", side: s, p: PZFlow.anchorPoint(n, s, PZFlow.nodeCenter(n)) }));
  }

  function hitAsaNodo(n, p, conEsquinas) {
    const radio = px(HANDLE_NODO);
    for (const a of asasLado(n)) {
      if (Math.abs(p.x - a.p.x) <= radio && Math.abs(p.y - a.p.y) <= radio) return a;
    }
    if (conEsquinas) {
      for (const a of asasEsquina(n)) {
        if (Math.abs(p.x - a.p.x) <= radio && Math.abs(p.y - a.p.y) <= radio) return a;
      }
    }
    return null;
  }

  function syncTextControls(t) {
    if (!t || t.type !== "text") return;
    el.txtColor.value = t.color;
    el.txtSize.value = t.size;
    document.getElementById("txt-size-out").textContent = String(t.size);
    const opcion = Array.from(el.txtFamily.options).some((o) => o.value === t.family);
    if (opcion) el.txtFamily.value = t.family;
  }

  function syncNodoControls() {
    const n = selNodes[0];
    if (n) {
      el.nodeShape.value = n.shape;
      if (n.fill !== "none") {
        el.nodeFill.value = n.fill;
        rellenoSin = false;
      } else {
        rellenoSin = true;
      }
      el.nodeStroke.value = n.stroke;
      el.nodeSize.value = String(n.fontSize);
      document.getElementById("node-size-out").textContent = String(n.fontSize);
      if (PZFlow.ICONS[n.icon]) el.nodeIcon.value = n.icon;
      for (const sw of el.swatches) sw.classList.toggle("on", sw.dataset.fill === n.fill);
      // Color del texto: el automático se enseña resuelto, pero sigue siendo "auto".
      textoAuto = n.textColor === "auto";
      el.nodeText.value = textoAuto ? colorTextoNodo(n) : n.textColor;
      el.nodeTextAuto.classList.toggle("on", textoAuto);
      el.nodeTextAuto.setAttribute("aria-pressed", textoAuto ? "true" : "false");
    }
    syncOpciones();
  }

  function syncEdgeControls() {
    const e = selEdge;
    if (!e) return;
    el.edgeColor.value = e.color;
    el.edgeWidth.value = String(e.width);
    const outAncho = document.getElementById("edge-width-out");
    if (outAncho) outAncho.textContent = String(e.width);
    el.edgeDash.checked = Boolean(e.dash);
    el.edgeArrows.value = arrowsTexto(e);
  }

  /**
   * La selección solo manda en la ventana con SELECT o NODO: con LÁPIZ o TEXTO activos, la
   * ventana de la herramienta se queda como está.
   */
  function panelDeSeleccion() {
    return tool === "select" || tool === "node";
  }

  /** Imagen o bloque de texto: selección simple. */
  function select(o) {
    sel = o;
    selNodes = [];
    selEdge = null;
    selUi = null;
    syncUiControls();
    // Un bloque de texto enseña TEXTO, como la barra de antes. La imagen no tiene ajustes
    // propios: no abre nada y no cierra lo que estuviera abierto. La paleta INTERFAZ manda.
    if (o && o.type === "text" && panelAbierto !== "ui" && panelDeSeleccion()) abrirPanel("text");
    syncTextControls(o);
    syncNodoControls();
    syncOpciones();
    paintLayers();
    actualizarContexto();
    redraw();
  }

  function selectNodos(lista) {
    selNodes = lista.slice();
    sel = null;
    selEdge = null;
    selUi = null;
    syncUiControls();
    // Cualquier nodo elegido enseña sus ajustes (con varios, también alinear y repartir). La
    // paleta INTERFAZ manda: un clic en un nodo del diagrama no la cierra.
    if (selNodes.length && panelAbierto !== "ui" && panelDeSeleccion()) abrirPanel("node");
    syncNodoControls();
    paintLayers();
    actualizarContexto();
    redraw();
  }

  function selectArista(e) {
    selEdge = e;
    sel = null;
    selNodes = [];
    selUi = null;
    syncUiControls();
    syncEdgeControls();
    // La paleta INTERFAZ es la única que no cede el sitio a la ventana del conector.
    if (panelAbierto !== "ui") abrirPanel("edge");
    syncOpciones();
    paintLayers();
    actualizarContexto();
    redraw();
  }

  function limpiarSeleccion() {
    const habia = sel || selNodes.length || selEdge || selUi;
    sel = null;
    selNodes = [];
    selEdge = null;
    selUi = null;
    syncUiControls();
    // La ventana que abrió la selección se va con ella: el CONECTOR, y NODO o TEXTO cuando se
    // eligió con SELECT. Las que son de la herramienta (o la paleta INTERFAZ) se quedan.
    if (panelAbierto && panelAbierto !== "ui" && panelAbierto !== PANEL_DE_HERRAMIENTA[tool]) abrirPanel(null);
    syncOpciones();
    paintLayers();
    if (habia) {
      actualizarContexto();
      redraw();
    }
  }

  function deleteSelected() {
    if (selUi) {
      // Sus descendientes se van con él: un hijo huérfano quedaría en la raíz, no donde estaba.
      const ids = new Set(ramaUi(selUi.id));
      state.ui.nodes = state.ui.nodes.filter((n) => !ids.has(n.id));
      selUi = null;
      syncUiControls();
      paintLayers();
      changed();
      commit();
      return;
    }
    if (selNodes.length) {
      const ids = new Set(selNodes.map((n) => n.id));
      state.flow.nodes = state.flow.nodes.filter((n) => !ids.has(n.id));
      state.flow.edges = state.flow.edges.filter((e) => !(e.from.node && ids.has(e.from.node)) && !(e.to.node && ids.has(e.to.node)));
      limpiarSeleccion();
      changed();
      commit();
      return;
    }
    if (selEdge) {
      state.flow.edges = state.flow.edges.filter((e) => e !== selEdge);
      limpiarSeleccion();
      changed();
      commit();
      return;
    }
    if (!sel) return;
    const list = sel.type === "image" ? state.images : state.texts;
    const i = list.indexOf(sel);
    if (i >= 0) list.splice(i, 1);
    // Un ImageBitmap pegado ocupa memoria por su cuenta: se cierra antes de soltarlo.
    // La copia de Ctrl+V comparte el suyo con el original: solo se cierra si nadie más lo usa.
    if (sel.type === "image" && !state.images.some((m) => m.drawable === sel.drawable)) sel.drawable.close?.();
    sel = null;
    changed();
    commit();
  }

  // ── Overlay: asas, guías y selección ──────────────────────

  function contornoNodo(t, n, color, discontinuo) {
    t.strokeStyle = color;
    t.lineWidth = px(2);
    if (discontinuo) t.setLineDash([px(7), px(5)]);
    caja(t, n.x, n.y, n.w, n.h, n.shape === "stadium" ? Math.min(n.w, n.h) / 2 : n.shape === "round" ? 14 : 0);
    t.stroke();
    t.setLineDash([]);
  }

  function cuadro(t, p, lado, color, hueco) {
    if (hueco) {
      t.fillStyle = "#0b1418";
      t.fillRect(p.x - lado / 2, p.y - lado / 2, lado, lado);
    }
    t.strokeStyle = color;
    t.lineWidth = px(2);
    t.strokeRect(p.x - lado / 2, p.y - lado / 2, lado, lado);
  }

  function drawOverlay() {
    octx.clearRect(0, 0, W, H);
    const flujoVisible = state.layers.flow !== false;
    const lado = px(HANDLE_NODO);

    // ── Chivatos de NODO: antes de las asas, para no tapar la selección ──
    const formaNueva = PZFlow.SHAPES.indexOf(el.nodeShape.value) >= 0 ? el.nodeShape.value : "rect";
    const silueta = (cajaNodo, discontinuo, opacidad) => {
      octx.save();
      if (cajaNodo.shape === "icon") caja(octx, cajaNodo.x, cajaNodo.y, cajaNodo.w, cajaNodo.h, 10);
      else PZFlow.nodePath(octx, cajaNodo);
      const relleno = rellenoActual();
      if (relleno !== "none") {
        octx.globalAlpha = opacidad * 0.22;
        octx.fillStyle = relleno;
        octx.fill();
        octx.globalAlpha = opacidad;
      }
      octx.lineWidth = px(2);
      octx.strokeStyle = el.nodeStroke.value;
      if (discontinuo) octx.setLineDash([px(6), px(4)]);
      octx.stroke();
      octx.restore();
    };

    // NODO arrastrando: silueta del nodo que se va a crear + medida exacta.
    if (flujoVisible && drag && drag.kind === "nodo-dibujar") {
      const brutoW = Math.abs(drag.p.x - drag.desde.x);
      const brutoH = Math.abs(drag.p.y - drag.desde.y);
      const dibujando = brutoW > 8 && brutoH > 8;
      let prev;
      if (dibujando) {
        let w = brutoW;
        let h = brutoH;
        if (drag.shift) {
          const ladoMayor = Math.max(w, h);
          w = ladoMayor;
          h = ladoMayor;
        }
        prev = {
          shape: formaNueva,
          x: ajusta(Math.min(drag.desde.x, drag.p.x)),
          y: ajusta(Math.min(drag.desde.y, drag.p.y)),
          w: Math.max(NODO_MIN_W, Math.round(w)),
          h: Math.max(NODO_MIN_H, Math.round(h)),
        };
      } else {
        // Un clic sin arrastre crea el nodo del último tamaño en el punto pulsado.
        prev = { shape: formaNueva, x: ajusta(drag.desde.x), y: ajusta(drag.desde.y), w: ultimoTamano.w, h: ultimoTamano.h };
      }
      silueta(prev, !dibujando, dibujando ? 1 : 0.35);
      if (dibujando) {
        const etiqueta = `${Math.round(prev.w)} × ${Math.round(prev.h)}`;
        octx.save();
        octx.font = `600 ${px(11)}px sans-serif`;
        octx.textAlign = "center";
        octx.textBaseline = "middle";
        const tx = prev.x + prev.w / 2;
        const ty = prev.y + prev.h + px(11);
        octx.lineWidth = px(3);
        octx.strokeStyle = "rgba(11, 20, 24, 0.85)";
        octx.strokeText(etiqueta, tx, ty);
        octx.fillStyle = "#ffffff";
        octx.fillText(etiqueta, tx, ty);
        octx.restore();
      }
    }

    // NODO sin gesto: dónde caería el próximo nodo, si el puntero está en el vacío.
    if (flujoVisible && tool === "node" && !pendiente && puntero && !drag && !hoverNode) {
      silueta(
        { shape: formaNueva, x: ajusta(puntero.x), y: ajusta(puntero.y), w: ultimoTamano.w, h: ultimoTamano.h },
        true,
        0.35
      );
    }

    // Fantasma de lo armado (TEXTO y la paleta INTERFAZ): dónde caería y qué sería. El overlay
    // no es el lienzo del dibujo, así que esto no sale en el PNG.
    const fantasma = (x, y, w, h, rotulo) => {
      octx.save();
      octx.globalAlpha = 0.5;
      octx.strokeStyle = "#00e5ff";
      octx.lineWidth = px(2);
      octx.setLineDash([px(6), px(4)]);
      octx.strokeRect(x, y, w, h);
      octx.globalAlpha = 1;
      octx.font = `600 ${px(11)}px sans-serif`;
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.lineWidth = px(3);
      octx.strokeStyle = "rgba(11, 20, 24, 0.85)";
      octx.strokeText(rotulo, x + w / 2, y + h / 2);
      octx.fillStyle = "#ffffff";
      octx.fillText(rotulo, x + w / 2, y + h / 2);
      octx.restore();
    };
    // Caja útil del contenedor que va a recibir un widget: mismo trazo discontinuo, sin rótulo.
    const cajaHost = (r) => {
      octx.save();
      octx.globalAlpha = 0.6;
      octx.strokeStyle = "#00e5ff";
      octx.lineWidth = px(2);
      octx.setLineDash([px(6), px(4)]);
      octx.strokeRect(r.x, r.y, r.w, r.h);
      octx.restore();
    };
    if (puntero && !drag) {
      // Lo armado cae donde está el puntero: el fantasma enseña ese mismo punto.
      if (pendiente && PZUi) {
        const tam = PZUi.defaults(pendiente);
        // El widget se coloca con `ajusta`, así que el recuadro también se pega a la rejilla.
        fantasma(ajusta(puntero.x), ajusta(puntero.y), tam.w, tam.h, etiquetaUi(pendiente));
        // Sobre un contenedor entrará dentro: se enseña la caja útil que lo va a recibir.
        const cont = hostDestino(puntero, null);
        if (cont) cajaHost(PZUi.contentRect(state.ui.nodes, cont));
      } else if (tool === "text") {
        fantasma(puntero.x, puntero.y, Math.max(40, Math.min(420, W)), Math.max(20, Math.min(50, H)), "texto");
      }
    }

    // Arrastrando un widget: la caja útil del contenedor que lo recogerá al soltar.
    if (drag && drag.kind === "ui-mover" && drag.host) {
      cajaHost(PZUi.contentRect(state.ui.nodes, drag.host));
    }

    if (
      flujoVisible &&
      hoverNode &&
      state.flow.nodes.indexOf(hoverNode) >= 0 &&
      !drag &&
      (tool === "select" || tool === "node") &&
      selNodes.indexOf(hoverNode) < 0
    ) {
      contornoNodo(octx, hoverNode, "#00e5ff", true);
      for (const a of asasLado(hoverNode)) cuadro(octx, a.p, lado, "#2f8fff");
    }

    if (flujoVisible && selNodes.length === 1) {
      const n = selNodes[0];
      contornoNodo(octx, n, "#00e5ff", false);
      for (const a of asasLado(n)) cuadro(octx, a.p, lado, "#2f8fff");
      for (const a of asasEsquina(n)) cuadro(octx, a.p, px(HANDLE), "#00e5ff");
    } else if (flujoVisible && selNodes.length > 1) {
      const b = cajaDeNodos(selNodes);
      octx.save();
      octx.strokeStyle = "#00e5ff";
      octx.lineWidth = px(2);
      octx.setLineDash([px(8), px(6)]);
      octx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      octx.setLineDash([]);
      for (const n of selNodes) contornoNodo(octx, n, "rgba(0, 229, 255, 0.45)", false);
      octx.restore();
    }

    if (sel && tool === "select") {
      const cs = corners(sel);
      const hs = handlesOf(sel);
      const rot = hs[hs.length - 1];
      const ladoImagen = px(HANDLE);
      octx.save();
      octx.strokeStyle = "#00e5ff";
      octx.fillStyle = "#00e5ff";
      octx.lineWidth = px(2);
      octx.beginPath();
      octx.moveTo(cs[0].x, cs[0].y);
      for (let i = 1; i < 4; i++) octx.lineTo(cs[i].x, cs[i].y);
      octx.closePath();
      octx.setLineDash([px(8), px(6)]);
      octx.stroke();
      octx.setLineDash([]);
      octx.beginPath();
      octx.moveTo(sel.x + sel.w / 2, sel.y + sel.h / 2);
      octx.lineTo(rot.p.x, rot.p.y);
      octx.stroke();
      for (const h of hs) octx.fillRect(h.p.x - ladoImagen / 2, h.p.y - ladoImagen / 2, ladoImagen, ladoImagen);
      octx.restore();
    }

    // INTERFACES: contorno y las ocho asas del widget elegido. El overlay es otro lienzo, así
    // que nada de esto viaja en el PNG (`pngBase64` lee solo el lienzo del dibujo).
    if (state.layers.ui !== false && PZUi && selUi && state.ui.nodes.indexOf(selUi) >= 0) {
      const b = PZUi.place(state.ui.nodes, selUi);
      octx.save();
      octx.strokeStyle = "#00e5ff";
      octx.lineWidth = px(2);
      octx.strokeRect(b.x, b.y, b.w, b.h);
      for (const asa of PZUi.handlePoints(b)) cuadro(octx, asa, px(HANDLE_NODO), "#00e5ff");
      octx.restore();
    }

    if (flujoVisible && selEdge) {
      const r = rutaDe(selEdge);
      if (r && r.points.length >= 2) {
        const pts = r.points;
        octx.save();
        octx.strokeStyle = "rgba(0, 229, 255, 0.55)";
        octx.lineWidth = px(8);
        PZFlow.roundedPath(octx, pts, 10);
        octx.stroke();
        octx.restore();
        // Asas: los codos materializados van tal cual; sin materializar, solo los quiebres
        // reales de la ruta (los vértices alineados del anclaje, el stub y el canal no lo son).
        const usuario = puntosUsuario(selEdge) || pts;
        const codos = selEdge.waypoints.length;
        const asas = codos
          ? selEdge.waypoints
          : PZFlow.bends(pts)
              .slice(1, -1)
              .map((i) => pts[i]);
        octx.save();
        octx.strokeStyle = "#00e5ff";
        octx.fillStyle = "#00e5ff";
        octx.lineWidth = px(2);
        for (const p of [pts[0], pts[pts.length - 1]]) {
          octx.beginPath();
          octx.arc(p.x, p.y, px(5), 0, Math.PI * 2);
          octx.fill();
        }
        for (const p of asas) cuadro(octx, p, px(9), "#00e5ff");
        const hasta = codos ? codos - 1 : usuario.length - 3;
        for (let s = 1; s <= hasta; s++) {
          const a = usuario[s];
          const b = usuario[s + 1];
          if (!a || !b) continue;
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          octx.beginPath();
          octx.arc(m.x, m.y, px(3), 0, Math.PI * 2);
          octx.fillStyle = "#0b1418";
          octx.fill();
          octx.strokeStyle = "#00e5ff";
          octx.stroke();
        }
        octx.restore();
      }
    }

    if (drag && drag.kind === "marquesina") {
      const a = drag.from;
      const b = drag.to;
      octx.save();
      octx.strokeStyle = "#00e5ff";
      octx.fillStyle = "rgba(0, 229, 255, 0.08)";
      octx.lineWidth = px(1.5);
      octx.setLineDash([px(6), px(4)]);
      octx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      octx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      octx.restore();
    }

    if (guias.length) {
      octx.save();
      octx.strokeStyle = "#ff3ea5";
      octx.lineWidth = px(1.5);
      octx.setLineDash([px(6), px(4)]);
      for (const g of guias) {
        octx.beginPath();
        if (g.x != null) {
          octx.moveTo(g.x, g.desde);
          octx.lineTo(g.x, g.hasta);
        } else {
          octx.moveTo(g.desde, g.y);
          octx.lineTo(g.hasta, g.y);
        }
        octx.stroke();
      }
      octx.restore();
    }

    if (drag && drag.kind === "conectar") {
      const fin = drag.destino ? PZFlow.anchorPoint(drag.destino, drag.destinoLado, drag.p) : drag.p;
      octx.save();
      if (drag.destino) contornoNodo(octx, drag.destino, "#35c08a", false);
      octx.strokeStyle = "#35c08a";
      octx.lineWidth = px(2);
      octx.setLineDash([px(7), px(5)]);
      octx.beginPath();
      octx.moveTo(drag.desde.x, drag.desde.y);
      octx.lineTo(fin.x, fin.y);
      octx.stroke();
      octx.setLineDash([]);
      octx.beginPath();
      octx.arc(fin.x, fin.y, px(4), 0, Math.PI * 2);
      octx.fillStyle = "#35c08a";
      octx.fill();
      octx.restore();
    }

    // ── Chivato del pincel: al final y encima de todo, sigue al puntero siempre ──
    if ((tool === "pen" || tool === "eraser") && puntero && !(drag && drag.kind === "pan")) {
      const tamano = tool === "pen" ? Number(el.penSize.value) : Number(el.erSize.value);
      const radio = Math.max(0.5, tamano / 2);
      octx.save();
      octx.beginPath();
      octx.arc(puntero.x, puntero.y, radio, 0, Math.PI * 2);
      octx.lineWidth = px(3.5);
      octx.strokeStyle = "rgba(11, 20, 24, 0.85)";
      octx.stroke();
      octx.beginPath();
      octx.arc(puntero.x, puntero.y, radio, 0, Math.PI * 2);
      octx.lineWidth = px(1.5);
      octx.strokeStyle = "#ffffff";
      octx.stroke();
      if (tool === "eraser") {
        const duro = clamp(Number(el.erHard.value) / 100, 0, 0.95);
        if (duro > 0) {
          octx.beginPath();
          octx.arc(puntero.x, puntero.y, radio * duro, 0, Math.PI * 2);
          octx.setLineDash([px(4), px(3)]);
          octx.lineWidth = px(1.5);
          octx.strokeStyle = "#ffffff";
          octx.stroke();
          octx.setLineDash([]);
        }
      } else {
        octx.beginPath();
        octx.arc(puntero.x, puntero.y, Math.max(px(1.5), radio * 0.25), 0, Math.PI * 2);
        octx.globalAlpha = 0.4;
        octx.fillStyle = el.penColor.value;
        octx.fill();
        octx.globalAlpha = 1;
      }
      octx.restore();
    }
  }

  // ── Editor de texto flotante (bloques) ────────────────────

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
    el.editor.style.paddingTop = "0px";
    el.editor.style.paddingLeft = "0px";
    el.editor.style.paddingRight = "0px";
    el.editor.style.textAlign = "left";
    el.editor.style.fontWeight = "400";
    el.editor.style.setProperty("--edit-font", t.family);
    el.editor.style.setProperty("--edit-size", t.size * k + "px");
    el.editor.style.setProperty("--edit-line", Math.round(t.size * 1.25) * k + "px");
    el.editor.style.setProperty("--edit-color", t.color);
  }

  function openEditor(t) {
    // La ventana taparía el área de edición: un clic en el hueco tapado la haría perder el foco
    // y, con el texto todavía vacío, borraría el bloque recién creado.
    abrirPanel(null);
    layout(t);
    editing = t;
    textoPrevio = t.text || "";
    nodeEditing = null;
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
    let quitado = false;
    if (!t.text.trim()) {
      const i = state.texts.indexOf(t);
      if (i >= 0) {
        state.texts.splice(i, 1);
        quitado = true;
      }
      if (sel === t) sel = null;
    } else {
      layout(t);
    }
    paintLayers();
    // Abrir y cerrar sin tocar el texto no es un gesto: ni entrada ni copia de trabajo. Un
    // bloque nuevo que se cierra vacío tampoco: la escena vuelve a como estaba.
    const real = t.text !== textoPrevio || (quitado && textoPrevio !== "");
    if (!real) {
      redraw();
      return;
    }
    changed();
    commit();
  }

  // ── Editor de la etiqueta de un nodo ──────────────────────

  /**
   * Coloca el área exactamente donde se pinta el texto: mismo cuerpo efectivo, mismos márgenes
   * laterales de la caja y el mismo centrado vertical. Así no baila al confirmar.
   */
  function colocaEditorNodo(n) {
    const k = layoutEscala();
    const m = lineasNodo(n);
    const cajaTexto = m.caja;
    const s = el.editor.style;
    // El área ocupa el nodo entero y el relleno la recorta a la caja útil (caja de contenido).
    s.left = n.x * k + "px";
    s.top = n.y * k + "px";
    s.width = Math.max(24, n.w * k) + "px";
    s.setProperty("--edit-font", "sans-serif");
    s.setProperty("--edit-size", m.size * k + "px");
    s.setProperty("--edit-line", m.lineH * k + "px");
    s.setProperty("--edit-color", colorTextoNodo(n));
    s.fontWeight = String(n.weight || 400);
    s.textAlign = n.align === "left" || n.align === "right" ? n.align : "center";
    s.paddingLeft = Math.max(0, (cajaTexto.x - n.x) * k) + "px";
    s.paddingRight = Math.max(0, (n.x + n.w - cajaTexto.x - cajaTexto.w) * k) + "px";
    s.paddingTop = "0px";
    s.height = "auto";
    const contenido = el.editor.scrollHeight;
    // `border-box`: el relleno va dentro del alto, así que hay que sumarlo para no recortar.
    const padTop = Math.max(0, (cajaTexto.y - n.y) * k + (cajaTexto.h * k - contenido) / 2);
    s.paddingTop = padTop + "px";
    s.height = contenido + padTop + "px";
  }

  function abrirEditorNodo(n) {
    // Igual que en el texto: la ventana no puede quedar encima del área de edición.
    abrirPanel(null);
    if (editing) closeEditor();
    nodeEditing = n;
    nodeTextPrevio = n.text || "";
    el.editor.value = n.text || "";
    el.editor.hidden = false;
    colocaEditorNodo(n);
    el.editor.focus();
    el.editor.select();
    setStatus("Etiqueta del nodo: Enter confirma, Mayús+Enter salta de línea, TAB encadena a la derecha y Ctrl+Enter abajo.");
  }

  /**
   * El alto del nodo crece si el texto no cabe con el cuerpo configurado; nunca se encoge solo.
   * El aire extra cubre los márgenes de la forma (la diferencia entre el nodo y su caja útil).
   */
  function crecerNodo(n) {
    const cajaTexto = cajaTextoNodo(n);
    const lines = partirTextoNodo(n, Math.max(4, cajaTexto.w), Math.max(1, Math.round(n.fontSize)));
    const lineH = Math.max(1, Math.round(n.fontSize * 1.25));
    const necesario = lines.length * lineH + (n.h - cajaTexto.h) + 4;
    if (necesario > n.h) n.h = necesario;
  }

  function confirmarEditorNodo(direccion) {
    const n = nodeEditing;
    if (!n) return;
    nodeEditing = null;
    el.editor.hidden = true;
    const texto = el.editor.value;
    const igual = texto === nodeTextPrevio;
    n.text = texto;
    crecerNodo(n);
    let nuevo = null;
    if (direccion) nuevo = nodoEncadenado(n, direccion);
    // Sin texto nuevo y sin cadena no hay gesto que consolidar.
    if (!igual || nuevo) {
      changed();
      commit();
    }
    if (nuevo) {
      selectNodos([nuevo]);
      abrirEditorNodo(nuevo);
    }
  }

  function cancelarEditorNodo() {
    if (!nodeEditing) return;
    // El texto se escribe en el nodo al vuelo: cancelar lo devuelve a como estaba.
    nodeEditing.text = nodeTextPrevio;
    nodeEditing = null;
    el.editor.hidden = true;
    changed();
    actualizarContexto();
  }

  /** Nodo nuevo conectado al editado: a la derecha (TAB) o abajo (Ctrl+Enter). */
  function nodoEncadenado(n, direccion) {
    const abajo = direccion === "abajo";
    const w = n.w;
    const h = Math.max(NODO_MIN_H, Math.min(n.h, NODO_H));
    const x = abajo ? n.x : n.x + n.w + 72;
    const y = abajo ? n.y + n.h + 72 : n.y;
    const nuevo = crearNodo(x, y, w, h);
    state.flow.nodes.push(nuevo);
    state.flow.edges.push(
      crearArista(n, abajo ? "b" : "r", { node: nuevo.id, side: abajo ? "t" : "l" })
    );
    return nuevo;
  }

  // ── Editor de la etiqueta de un conector ──────────────────

  function colocaEditorArista(e) {
    const k = layoutEscala();
    const p = puntoEtiqueta(e);
    const ancho = Math.max(110, 170 * k);
    el.edgeEditor.style.left = p.x * k - ancho / 2 + "px";
    el.edgeEditor.style.top = p.y * k - 11 + "px";
    el.edgeEditor.style.width = ancho + "px";
  }

  function abrirEditorArista(e) {
    // Mismo motivo: el campo de la etiqueta va sobre el lienzo, no debajo de la ventana.
    abrirPanel(null);
    if (editing) closeEditor();
    if (nodeEditing) confirmarEditorNodo();
    editingEdge = e;
    el.edgeEditor.value = e.label || "";
    el.edgeEditor.hidden = false;
    colocaEditorArista(e);
    el.edgeEditor.focus();
    el.edgeEditor.select();
    setStatus("Etiqueta del conector: Enter confirma y Escape la descarta.");
  }

  function cerrarEditorArista(confirmar) {
    if (!editingEdge) return;
    const e = editingEdge;
    editingEdge = null;
    el.edgeEditor.hidden = true;
    if (confirmar) {
      e.label = el.edgeEditor.value.slice(0, 500);
      changed();
      commit();
    } else {
      changed();
    }
    actualizarContexto();
  }

  function cerrarEditores(cancelar) {
    if (editing) closeEditor();
    if (nodeEditing) {
      if (cancelar) cancelarEditorNodo();
      else confirmarEditorNodo();
    }
    if (editingEdge) cerrarEditorArista(!cancelar);
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

  /** Cursor de la zona: lo decide lo que hay debajo del puntero. */
  function pintaCursor(nombre) {
    if (nombre) el.root.dataset.cursor = nombre;
    else delete el.root.dataset.cursor;
  }

  // ── Creación de nodos y aristas ───────────────────────────

  function rellenoActual() {
    return rellenoSin ? "none" : el.nodeFill.value;
  }

  function crearNodo(x, y, w, h) {
    const n = {
      type: "node",
      id: PZFlow.newId("n"),
      shape: PZFlow.SHAPES.indexOf(el.nodeShape.value) >= 0 ? el.nodeShape.value : "rect",
      x: ajusta(x),
      y: ajusta(y),
      w: Math.max(NODO_MIN_W, Math.round(w)),
      h: Math.max(NODO_MIN_H, Math.round(h)),
      text: "",
      fill: rellenoActual(),
      stroke: el.nodeStroke.value,
      textColor: textoAuto ? "auto" : el.nodeText.value,
      fontSize: clamp(Number(el.nodeSize.value) || 18, 6, 300),
      weight: 600,
      align: "center",
      icon: PZFlow.ICONS[el.nodeIcon.value] ? el.nodeIcon.value : "mail",
      iconColor: "#14232b",
    };
    n.iconColor = colorIcono(n);
    return n;
  }

  /** `destino`: `{ node, side }` si se engancha a un nodo, `{ x, y }` si es punta libre. */
  function crearArista(desdeNodo, desdeLado, destino) {
    const e = {
      type: "edge",
      id: PZFlow.newId("e"),
      from: { node: desdeNodo.id, side: desdeLado || "auto" },
      to: destino.node
        ? { node: destino.node, side: destino.side || "auto" }
        : { x: ajusta(destino.x), y: ajusta(destino.y) },
      label: "",
      color: EDGE_STYLE.color,
      width: EDGE_STYLE.width,
      dash: EDGE_STYLE.dash,
      startArrow: EDGE_STYLE.arrows === "both" || EDGE_STYLE.arrows === "back",
      endArrow: EDGE_STYLE.arrows === "arrow" || EDGE_STYLE.arrows === "both",
      waypoints: [],
      labelOffset: { dx: 0, dy: 0 },
    };
    return e;
  }

  /** Lado del nodo cuyo ancla queda más cerca del puntero. */
  function ladoCercano(n, p) {
    let mejor = "r";
    let distancia = Infinity;
    for (const s of PZFlow.SIDES) {
      const a = PZFlow.anchorPoint(n, s, p);
      const d = Math.hypot(a.x - p.x, a.y - p.y);
      if (d < distancia) {
        distancia = d;
        mejor = s;
      }
    }
    return mejor;
  }

  // ── Guías inteligentes y cajas ────────────────────────────

  function cajaDeNodos(lista) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of lista) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w);
      y1 = Math.max(y1, n.y + n.h);
    }
    return { x0, y0, x1, y1 };
  }

  function cajaDeObjeto(o) {
    if (!o.rot) return { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
    const cs = corners(o);
    const xs = cs.map((c) => c.x);
    const ys = cs.map((c) => c.y);
    return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
  }

  /**
   * Ajuste por bordes y centros: devuelve el desplazamiento que pega la caja móvil a la más
   * cercana y las líneas que hay que pintar. Umbral `GUIA` píxeles de lienzo.
   */
  function snapAGuias(caja, excluir) {
    const fuera = state.flow.nodes.filter((n) => excluir.indexOf(n) < 0);
    let dx = 0;
    let dy = 0;
    let dX = GUIA + 1;
    let dY = GUIA + 1;
    let guiaX = null;
    let guiaY = null;
    const cx = (caja.x0 + caja.x1) / 2;
    const cy = (caja.y0 + caja.y1) / 2;
    const movX = [caja.x0, cx, caja.x1];
    const movY = [caja.y0, cy, caja.y1];
    for (const n of fuera) {
      const otrosX = [n.x, n.x + n.w / 2, n.x + n.w];
      const otrosY = [n.y, n.y + n.h / 2, n.y + n.h];
      for (const a of movX) {
        for (const b of otrosX) {
          const d = b - a;
          if (Math.abs(d) <= GUIA && Math.abs(d) < Math.abs(dX)) {
            dX = d;
            guiaX = { x: b, desde: Math.min(caja.y0, n.y) - 12, hasta: Math.max(caja.y1, n.y + n.h) + 12 };
          }
        }
      }
      for (const a of movY) {
        for (const b of otrosY) {
          const d = b - a;
          if (Math.abs(d) <= GUIA && Math.abs(d) < Math.abs(dY)) {
            dY = d;
            guiaY = { y: b, desde: Math.min(caja.x0, n.x) - 12, hasta: Math.max(caja.x1, n.x + n.w) + 12 };
          }
        }
      }
    }
    if (guiaX) dx = dX;
    if (guiaY) dy = dY;
    const lineas = [];
    if (guiaX) lineas.push(guiaX);
    if (guiaY) lineas.push(guiaY);
    return { dx, dy, lineas };
  }

  // ── Puntero ───────────────────────────────────────────────

  function onDown(event) {
    if (event.button !== 0) return;
    // Las áreas de edición son hijas del mundo: un clic ahí es suyo, no de la pizarra.
    if (event.target === el.editor || event.target === el.edgeEditor) return;
    if (editing) closeEditor();
    if (editingEdge) cerrarEditorArista(true);
    if (nodeEditing) confirmarEditorNodo();
    // Sin esto, la acción por defecto del clic mueve el foco al body y el `blur` del área
    // cerraría el editor que acabamos de abrir. El paneo y el dibujo usan captura explícita
    // de puntero, que no es una acción por defecto: no se resiente.
    event.preventDefault();
    // `preventDefault` deja el foco donde estaba: sin soltarlo, el guard de INPUT del
    // teclado dejaría el paneo con Espacio muerto tras tocar un deslizador.
    const activo = document.activeElement;
    if (activo && activo !== el.editor && activo !== el.edgeEditor && activo !== document.body) activo.blur();
    const p = toCanvas(event);
    el.frame.setPointerCapture(event.pointerId);

    // Espacio pulsado: arrastrar panea el encuadre, no toca el dibujo.
    if (espacio) {
      drag = { kind: "pan", x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
      pintaCursorPan();
      return;
    }

    // Colocación armada en la paleta INTERFAZ: el clic pone el widget y vuelve a SELECCIONAR.
    if (pendiente) {
      insertarUi(pendiente, p);
      redraw();
      return;
    }

    if (tool === "pen" || tool === "eraser") {
      if (state.layers.strokes === false) {
        setStatus("La capa TRAZOS está oculta: enciéndela con TRAZOS o no se verá lo que pintes.", "error");
      }
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
        // En un lienzo de 100 × 100 el bloque no puede nacer cuatro veces más ancho que el lienzo.
        w: Math.max(40, Math.min(420, W)),
        h: Math.max(20, Math.min(50, H)),
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

    // Asas del objeto simple (imagen o bloque de texto).
    if (sel && tool === "select") {
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

    // Asas de nodo: los lados conectan (del nodo bajo el puntero o del único elegido).
    const candidato = hoverNode && state.flow.nodes.indexOf(hoverNode) >= 0 ? hoverNode : selNodes.length === 1 ? selNodes[0] : null;
    if (candidato && state.layers.flow !== false) {
      const asa = hitAsaNodo(candidato, p, selNodes.length === 1);
      if (asa && asa.kind === "lado") {
        drag = {
          kind: "conectar",
          nodo: candidato,
          lado: asa.side,
          desde: asa.p,
          p,
          destino: null,
          destinoLado: null,
        };
        return;
      }
      if (asa && asa.kind === "esquina") {
        selectNodos([candidato]);
        const opuesta = CORNERS[(asa.corner + 2) % 4];
        drag = {
          kind: "nodo-redimensionar",
          nodo: candidato,
          sx: asa.sx,
          sy: asa.sy,
          ancla: {
            x: candidato.x + (opuesta.sx > 0 ? candidato.w : 0),
            y: candidato.y + (opuesta.sy > 0 ? candidato.h : 0),
          },
          aspecto: candidato.w / Math.max(1, candidato.h),
          shift: event.shiftKey,
        };
        return;
      }
    }

    // Controles del conector elegido: etiqueta, codos y extremos.
    if (selEdge && state.layers.flow !== false) {
      if (hitEtiquetaArista(selEdge, p)) {
        drag = { kind: "arista-etiqueta", arista: selEdge, desde: p, offset: { ...selEdge.labelOffset } };
        return;
      }
      const r = rutaDe(selEdge);
      if (r && r.points.length >= 2) {
        const radio = px(10);
        // Codos: se golpea sobre los `waypoints` guardados; sin ellos, sobre los de la ruta
        // pintada, que tras materializar ocupan exactamente los mismos índices (i - 1).
        if (selEdge.waypoints.length) {
          for (let j = 0; j < selEdge.waypoints.length; j++) {
            const w = selEdge.waypoints[j];
            if (Math.abs(p.x - w.x) <= radio && Math.abs(p.y - w.y) <= radio) {
              drag = { kind: "arista-codo", arista: selEdge, indice: j, desde: p };
              return;
            }
          }
        } else {
          for (let i = 1; i < r.points.length - 1; i++) {
            if (Math.abs(p.x - r.points[i].x) <= radio && Math.abs(p.y - r.points[i].y) <= radio) {
              drag = { kind: "arista-codo", arista: selEdge, indice: i - 1, desde: p };
              return;
            }
          }
        }
        for (const extremo of ["from", "to"]) {
          const q = extremo === "from" ? r.points[0] : r.points[r.points.length - 1];
          if (Math.hypot(p.x - q.x, p.y - q.y) <= radio) {
            drag = { kind: "arista-extremo", arista: selEdge, extremo, p, destino: nodoEn(p), destinoLado: null };
            return;
          }
        }
      }
    }

    if (tool === "node") {
      const n = nodoEn(p);
      if (n) {
        if (event.shiftKey) {
          const i = selNodes.indexOf(n);
          selectNodos(i >= 0 ? selNodes.filter((x) => x !== n) : selNodes.concat([n]));
        } else {
          selectNodos([n]);
        }
        drag = { kind: "nodo-mover", objetivo: n, nodos: selNodes.slice(), desde: p, inicios: iniciosDe(selNodes) };
        return;
      }
      drag = { kind: "nodo-dibujar", desde: p, p, shift: event.shiftKey };
      return;
    }

    // INTERFACES: las asas del widget elegido mandan sobre lo que tenga debajo.
    if (PZUi && tool === "select" && state.layers.ui !== false) {
      const asa = selUi && state.ui.nodes.indexOf(selUi) >= 0 ? hitAsaUi(selUi, p) : null;
      if (asa) {
        drag = {
          kind: "ui-tamano",
          nodo: selUi,
          part: asa.part,
          caja: PZUi.place(state.ui.nodes, selUi),
          origen: uiOrigen(selUi),
        };
        return;
      }
    }

    // SELECCIONAR: de arriba abajo, el orden de pintado al revés.
    const o = hitObject(p);
    if (o) {
      select(o);
      drag = { kind: "move", last: p, desde: p };
      return;
    }

    // INTERFACES va encima del diagrama y debajo de imágenes y textos, así que su golpe entra
    // aquí: después de `hitObject` y antes de los nodos.
    if (PZUi && tool === "select" && state.layers.ui !== false) {
      const golpe = PZUi.hit(state.ui.nodes, p.x, p.y);
      if (golpe) {
        if (golpe.node !== selUi) {
          selectUi(golpe.node);
        } else {
          // Segundo clic sobre el elegido: simula el control (pestaña, acordeón, casilla).
          const antes = [golpe.node.active, golpe.node.checked.join(",")].join("|");
          PZUi.click(golpe.node, golpe.part);
          if ([golpe.node.active, golpe.node.checked.join(",")].join("|") !== antes) {
            changed();
            commit();
          }
        }
        drag = { kind: "ui-mover", nodo: golpe.node, desde: p, inicio: { x: golpe.node.x, y: golpe.node.y } };
        return;
      }
    }

    const n = nodoEn(p);
    if (n) {
      if (event.shiftKey) {
        const i = selNodes.indexOf(n);
        if (i >= 0) {
          const resto = selNodes.filter((x) => x !== n);
          if (resto.length) selectNodos(resto);
          else limpiarSeleccion();
        } else {
          selectNodos(selNodes.concat([n]));
        }
      } else if (selNodes.indexOf(n) < 0) {
        selectNodos([n]);
      }
      drag = { kind: "nodo-mover", objetivo: n, nodos: selNodes.slice(), desde: p, inicios: iniciosDe(selNodes) };
      return;
    }

    const e = aristaEn(p);
    if (e) {
      selectArista(e);
      if (event.altKey) {
        if (codoEn(e, p)) {
          changed();
          commit();
        }
        return;
      }
      const tramo = tramoInterior(e, p);
      if (tramo >= 0) {
        drag = { kind: "arista-tramo", arista: e, tramo, desde: p };
        return;
      }
      return;
    }

    // Fondo: marquesina de nodos.
    if (!event.shiftKey) limpiarSeleccion();
    drag = { kind: "marquesina", from: p, to: p, shift: event.shiftKey, base: event.shiftKey ? selNodes.slice() : [] };
  }

  /** Posiciones de partida de un arrastre en grupo. */
  function iniciosDe(lista) {
    const mapa = new Map();
    for (const n of lista) mapa.set(n, { x: n.x, y: n.y });
    return mapa;
  }

  /** Punto de la etiqueta del conector, para golpearla antes que a la línea. */
  function hitEtiquetaArista(e, p) {
    if (!e.label) return false;
    const q = puntoEtiqueta(e);
    measure.font = `600 ${TEXTO_ARISTA}px sans-serif`;
    const ancho = measure.measureText(e.label).width;
    return Math.abs(p.x - q.x) <= ancho / 2 + 6 && Math.abs(p.y - q.y) <= TEXTO_ARISTA;
  }

  /**
   * Materializa la ruta en `waypoints`: la forma deja de depender del enrutado automático.
   * Solo la primera vez: volver a materializar metería los codos que dibuja la librería.
   */
  function materializar(e) {
    if (e.waypoints && e.waypoints.length) return true;
    const r = rutaDe(e);
    if (!r || r.points.length < 3) return false;
    e.waypoints = r.points.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
    return true;
  }

  /**
   * Polilínea de edición: `[a0, ...waypoints, b0]`, donde los anclajes son los dos extremos
   * de la ruta. Sin waypoints vale la ruta pintada, que es lo que se puede tocar antes de
   * materializar. El índice `k` de esta lista es el waypoint `k - 1` una vez materializada.
   */
  function puntosUsuario(e) {
    const r = rutaDe(e);
    if (!r || r.points.length < 2) return null;
    if (!e.waypoints || !e.waypoints.length) return r.points;
    return [r.points[0], ...e.waypoints, r.points[r.points.length - 1]];
  }

  /** Tramo interior (entre codos) que pasa por el punto; -1 si es un tramo del extremo. */
  function tramoInterior(e, p) {
    const pts = puntosUsuario(e);
    if (!pts || pts.length < 3) return -1;
    const golpe = PZFlow.segmentHit(pts, p, px(EDGE_TOL));
    if (golpe.index < 1 || golpe.index > pts.length - 3) return -1;
    return golpe.index;
  }

  /** Alt+clic: añade un codo en ese punto de un tramo interior. `true` si añadió algo. */
  function codoEn(e, p) {
    const tramo = tramoInterior(e, p);
    if (tramo < 0) {
      setStatus("Alt+clic añade codos en los tramos interiores del conector.", "error");
      return false;
    }
    if (!materializar(e)) return false;
    // Sin ajuste a la rejilla: el codo nace en el punto exacto y la línea no se mueve.
    e.waypoints.splice(tramo, 0, { x: red(p.x), y: red(p.y) });
    setStatus("Codo añadido: arrástralo para moverlo y haz doble clic para quitarlo.");
    return true;
  }

  function onMove(event) {
    puntero = toCanvas(event);
    if (!drag) {
      // Sin gesto: se decide el cursor y el nodo bajo el puntero. Solo se repinta si cambió
      // algo; las herramientas que llevan chivato repintan siempre (el rAF agrupa).
      const p = puntero;
      const previo = hoverNode;
      const cursorPrevio = el.root.dataset.cursor;
      hoverNode = nodoEn(p);
      pintaCursorCursor(p);
      const chivato =
        tool === "pen" || tool === "eraser" || tool === "node" || tool === "text" || Boolean(pendiente);
      if (chivato || previo !== hoverNode || cursorPrevio !== el.root.dataset.cursor) redraw();
      return;
    }

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

    if (drag.kind === "marquesina") {
      drag.to = p;
      redraw();
      return;
    }

    if (drag.kind === "nodo-dibujar") {
      drag.p = p;
      drag.shift = event.shiftKey;
      redraw();
      return;
    }

    if (drag.kind === "nodo-mover") {
      if (Math.hypot(p.x - drag.desde.x, p.y - drag.desde.y) >= 1) drag.movido = true;
      moverNodos(drag, p);
      redraw();
      return;
    }

    if (drag.kind === "nodo-redimensionar") {
      redimensionarNodo(drag, p, event.shiftKey);
      redraw();
      return;
    }

    if (drag.kind === "conectar") {
      drag.p = p;
      const destino = nodoEn(p);
      drag.destino = destino && destino !== drag.nodo ? destino : null;
      drag.destinoLado = drag.destino ? ladoCercano(drag.destino, p) : null;
      redraw();
      return;
    }

    if (drag.kind === "ui-mover") {
      drag.p = p;
      const x = ajusta(drag.inicio.x + (p.x - drag.desde.x));
      const y = ajusta(drag.inicio.y + (p.y - drag.desde.y));
      // Un temblor dentro de la misma celda de la rejilla no es un gesto: ni redibuja ni entra
      // en el historial.
      drag.movido = x !== drag.inicio.x || y !== drag.inicio.y;
      if (!drag.movido) return;
      drag.nodo.x = x;
      drag.nodo.y = y;
      // Destino del reanidado, para la pista del overlay.
      drag.host = hostDestino(p, drag.nodo);
      redraw();
      return;
    }

    if (drag.kind === "ui-tamano") {
      if (redimensionarUi(drag, p)) drag.movido = true;
      redraw();
      return;
    }

    // Desplazamiento del gesto: redondeado a la rejilla si está encendida, crudo si no.
    // Se aplica siempre sobre la base, así un temblor de 1 px no pega el punto a la rejilla.
    const delta = (d) => (rejilla ? Math.round(d / REJILLA) * REJILLA : d);

    if (drag.kind === "arista-tramo") {
      const e = drag.arista;
      const s = drag.tramo;
      const pts = puntosUsuario(e);
      if (!pts) return;
      const pa = pts[s];
      const pb = pts[s + 1];
      if (!pa || !pb) return;
      const vertical = Math.abs(pa.x - pb.x) <= Math.abs(pa.y - pb.y);
      const paso = delta(vertical ? p.x - drag.desde.x : p.y - drag.desde.y);
      // Sin desplazamiento del eje que manda no hay gesto: ni materializa ni consolida.
      if (!paso) {
        redraw();
        return;
      }
      // La ruta se congela en `waypoints` al primer movimiento real.
      if (!drag.materializado) {
        if (!materializar(e)) {
          drag = null;
          return;
        }
        const a0 = e.waypoints[s - 1];
        const b0 = e.waypoints[s];
        if (!a0 || !b0) {
          drag = null;
          return;
        }
        drag.base = { ax: a0.x, ay: a0.y, bx: b0.x, by: b0.y };
        drag.materializado = true;
      }
      const a = e.waypoints[s - 1];
      const b = e.waypoints[s];
      if (!a || !b) return;
      if (vertical) {
        const x = drag.base.ax + paso;
        if (x === drag.base.ax) {
          redraw();
          return;
        }
        a.x = x;
        b.x = x;
      } else {
        const y = drag.base.ay + paso;
        if (y === drag.base.ay) {
          redraw();
          return;
        }
        a.y = y;
        b.y = y;
      }
      drag.movido = true;
      redraw();
      return;
    }

    if (drag.kind === "arista-codo") {
      const dx = delta(p.x - drag.desde.x);
      const dy = delta(p.y - drag.desde.y);
      if (!dx && !dy) {
        redraw();
        return;
      }
      // Misma regla: el codo solo se materializa cuando el desplazamiento es real.
      if (!drag.materializado) {
        if (!materializar(drag.arista)) {
          drag = null;
          return;
        }
        const inicio = drag.arista.waypoints[drag.indice];
        if (!inicio) {
          drag = null;
          return;
        }
        const previo = drag.arista.waypoints[drag.indice - 1];
        const siguiente = drag.arista.waypoints[drag.indice + 1];
        drag.base = {
          x: inicio.x,
          y: inicio.y,
          prev: previo ? { x: previo.x, y: previo.y } : null,
          next: siguiente ? { x: siguiente.x, y: siguiente.y } : null,
        };
        drag.materializado = true;
      }
      const e = drag.arista;
      const w = e.waypoints[drag.indice];
      if (!w) return;
      const nx = drag.base.x + dx;
      const ny = drag.base.y + dy;
      if (nx === drag.base.x && ny === drag.base.y) {
        redraw();
        return;
      }
      w.x = nx;
      w.y = ny;
      // Arrastrar con él a los vecinos que compartían eje: los tramos contiguos se desplazan
      // y el resto de la ruta no se toca. Los anclajes nunca se mueven.
      const prev = e.waypoints[drag.indice - 1];
      const next = e.waypoints[drag.indice + 1];
      if (prev && drag.base.prev) {
        if (drag.base.prev.x === drag.base.x) prev.x = nx;
        if (drag.base.prev.y === drag.base.y) prev.y = ny;
      }
      if (next && drag.base.next) {
        if (drag.base.next.x === drag.base.x) next.x = nx;
        if (drag.base.next.y === drag.base.y) next.y = ny;
      }
      drag.movido = true;
      redraw();
      return;
    }

    if (drag.kind === "arista-extremo") {
      drag.p = p;
      drag.movido = true;
      const destino = nodoEn(p);
      drag.destino = destino;
      drag.destinoLado = destino ? ladoCercano(destino, p) : null;
      // Se mueve de verdad mientras se arrastra: así la ruta se ve reengancharse en vivo.
      const e = drag.arista;
      if (destino) e[drag.extremo] = { node: destino.id, side: drag.destinoLado };
      else e[drag.extremo] = { x: ajusta(p.x), y: ajusta(p.y) };
      redraw();
      return;
    }

    if (drag.kind === "arista-etiqueta") {
      drag.arista.labelOffset = {
        dx: Math.round(drag.offset.dx + (p.x - drag.desde.x)),
        dy: Math.round(drag.offset.dy + (p.y - drag.desde.y)),
      };
      drag.movido = true;
      if (editingEdge) colocaEditorArista(editingEdge);
      redraw();
      return;
    }

    const o = sel;
    if (!o) return;
    if (o.type === "text") layout(o);

    if (drag.kind === "move") {
      // Cualquier desplazamiento real cuenta: con el zoom del sistema al 125/150 % un arrastre
      // lento puede no llegar a 1 px de lienzo entre dos eventos.
      if (p.x !== drag.desde.x || p.y !== drag.desde.y) drag.movido = true;
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
      drag.movido = true;
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
      drag.movido = true;
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
      drag.movido = true;
      redraw();
    }
  }

  /** Cursor según lo que hay debajo: asas, nodo, conector o etiqueta. */
  function pintaCursorCursor(p) {
    if (espacio) return; // el paneo manda y lo pinta `pintaCursorPan`
    if (tool === "pen" || tool === "eraser" || tool === "text" || tool === "node") {
      pintaCursor("");
      return;
    }
    const candidato = hoverNode && state.flow.nodes.indexOf(hoverNode) >= 0 ? hoverNode : selNodes.length === 1 ? selNodes[0] : null;
    if (candidato && state.layers.flow !== false) {
      const asa = hitAsaNodo(candidato, p, selNodes.length === 1);
      if (asa && asa.kind === "lado") {
        pintaCursor("connect");
        return;
      }
      if (asa && asa.kind === "esquina") {
        pintaCursor(asa.sx * asa.sy > 0 ? "resize-nwse" : "resize-nesw");
        return;
      }
    }
    if (selEdge && hitEtiquetaArista(selEdge, p)) {
      pintaCursor("label");
      return;
    }
    if (aristaEn(p)) {
      pintaCursor("edge");
      return;
    }
    if (hoverNode) {
      pintaCursor("move");
      return;
    }
    if (hitObject(p)) {
      pintaCursor("move");
      return;
    }
    pintaCursor("");
  }

  /** Movimiento en grupo con rejilla y guías inteligentes. */
  function moverNodos(d, p) {
    const brutoX = p.x - d.desde.x;
    const brutoY = p.y - d.desde.y;
    let dx = brutoX;
    let dy = brutoY;
    const primero = d.nodos[0];
    if (primero && rejilla) {
      const ini = d.inicios.get(primero);
      dx = ajusta(ini.x + brutoX) - ini.x;
      dy = ajusta(ini.y + brutoY) - ini.y;
    }
    // Caja provisional para buscar guías.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of d.nodos) {
      const ini = d.inicios.get(n);
      x0 = Math.min(x0, ini.x + dx);
      y0 = Math.min(y0, ini.y + dy);
      x1 = Math.max(x1, ini.x + dx + n.w);
      y1 = Math.max(y1, ini.y + dy + n.h);
    }
    const ajuste = snapAGuias({ x0, y0, x1, y1 }, d.nodos);
    dx += ajuste.dx;
    dy += ajuste.dy;
    guias = ajuste.lineas;
    for (const n of d.nodos) {
      const ini = d.inicios.get(n);
      n.x = Math.round(ini.x + dx);
      n.y = Math.round(ini.y + dy);
    }
  }

  function redimensionarNodo(d, p, shift) {
    const n = d.nodo;
    let w = Math.abs(ajusta(p.x) - d.ancla.x);
    let h = Math.abs(ajusta(p.y) - d.ancla.y);
    if (shift) {
      const aspecto = d.aspecto || 1;
      if (w / Math.max(1, h) > aspecto) h = w / aspecto;
      else w = h * aspecto;
    }
    n.w = Math.max(NODO_MIN_W, w);
    n.h = Math.max(NODO_MIN_H, h);
    n.x = d.sx > 0 ? d.ancla.x : d.ancla.x - n.w;
    n.y = d.sy > 0 ? d.ancla.y : d.ancla.y - n.h;
  }

  function onUp(event) {
    if (!drag) return;
    const d = drag;
    drag = null;
    pintaCursorPan();
    guias = [];

    if (d.kind === "pan") {
      // Mover el encuadre no cambia el lienzo: ni `changed` ni copia de trabajo.
      return;
    }
    if (d.kind === "draw") {
      state.strokes.push(d.stroke);
      // Lo que se vio durante el arrastre pasa a lo confirmado.
      cctx.clearRect(0, 0, W, H);
      cctx.drawImage(live, 0, 0);
      lctx.clearRect(0, 0, W, H);
      changed();
      commit();
      return;
    }
    if (d.kind === "marquesina") {
      const a = d.from;
      const b = d.to;
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const x1 = Math.max(a.x, b.x);
      const y1 = Math.max(a.y, b.y);
      const dentro =
        Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2
          ? []
          : state.flow.nodes.filter((n) => n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0);
      if (dentro.length) {
        const base = d.shift ? d.base : [];
        const suma = base.slice();
        for (const n of dentro) if (suma.indexOf(n) < 0) suma.push(n);
        selectNodos(suma);
      }
      redraw();
      return;
    }
    if (d.kind === "nodo-dibujar") {
      const bruto = { w: Math.abs(d.p.x - d.desde.x), h: Math.abs(d.p.y - d.desde.y) };
      let w = bruto.w;
      let h = bruto.h;
      const dibujando = w > 8 && h > 8;
      if (dibujando && (d.shift || (event && event.shiftKey))) {
        const lado = Math.max(w, h);
        w = lado;
        h = lado;
      }
      if (!dibujando) {
        w = ultimoTamano.w;
        h = ultimoTamano.h;
      } else {
        ultimoTamano = { w: Math.round(w), h: Math.round(h) };
      }
      const x = Math.min(d.desde.x, d.p.x);
      const y = Math.min(d.desde.y, d.p.y);
      const n = crearNodo(dibujando ? x : d.desde.x, dibujando ? y : d.desde.y, w, h);
      state.flow.nodes.push(n);
      selectNodos([n]);
      changed();
      commit();
      actualizarContexto();
      return;
    }
    if (d.kind === "nodo-mover") {
      // Un clic sin arrastre sobre un nodo ya elegido deja la selección en ese nodo.
      if (!d.movido && d.objetivo && selNodes.length > 1) {
        selectNodos([d.objetivo]);
        return;
      }
      changed();
      commit();
      return;
    }
    if (d.kind === "nodo-redimensionar") {
      changed();
      commit();
      return;
    }
    if (d.kind === "conectar") {
      const destino = d.destino;
      if (destino && destino !== d.nodo) {
        state.flow.edges.push(crearArista(d.nodo, d.lado, { node: destino.id, side: ladoCercano(destino, d.p) }));
        selectArista(state.flow.edges[state.flow.edges.length - 1]);
        changed();
        commit();
      } else if (!destino) {
        state.flow.edges.push(crearArista(d.nodo, d.lado, { x: d.p.x, y: d.p.y }));
        selectArista(state.flow.edges[state.flow.edges.length - 1]);
        changed();
        commit();
        setStatus("Conector con punta libre: arrástrala hasta un nodo para engancharla.");
      } else {
        setStatus("Un conector no puede unir un nodo consigo mismo.", "error");
      }
      redraw();
      return;
    }
    if (d.kind === "arista-tramo" || d.kind === "arista-codo") {
      // Sin movimiento real no hay gesto: ni entra en el historial.
      if (!d.movido) {
        redraw();
        return;
      }
      changed();
      commit();
      return;
    }
    if (d.kind === "arista-etiqueta") {
      if (!d.movido) {
        redraw();
        return;
      }
      changed();
      commit();
      return;
    }
    if (d.kind === "arista-extremo") {
      if (!d.movido) {
        redraw();
        return;
      }
      const e = d.arista;
      const destino = d.destino;
      // Alt al soltar fuerza el lado automático; sin Alt manda el lado más cercano.
      const forzarAuto = Boolean(event && event.altKey);
      if (destino) {
        e[d.extremo] = { node: destino.id, side: forzarAuto ? "auto" : ladoCercano(destino, d.p) };
      } else {
        e[d.extremo] = { x: ajusta(d.p.x), y: ajusta(d.p.y) };
      }
      changed();
      commit();
      return;
    }

    // Widgets de INTERFACES: al soltar, el widget se reanida en el contenedor que tenga debajo.
    if (d.kind === "ui-mover") {
      if (!d.movido) {
        redraw();
        return;
      }
      // El arrastre dejó `x`/`y` en coordenadas del padre de antes, pero `adopt`/`detach`
      // parten de la caja absoluta: el widget no salta de donde se ve.
      const cand = PZUi.hostAt(state.ui.nodes, d.p.x, d.p.y, d.nodo);
      if (cand && cand.id !== d.nodo.parent) {
        if (PZUi.depthOf(state.ui.nodes, cand) + 1 <= PZUi.MAX_DEPTH) {
          // Se reparenta con la caja absoluta de antes, no con el puntero: la esquina no salta.
          const caja = PZUi.place(state.ui.nodes, d.nodo);
          PZUi.adopt(state.ui.nodes, d.nodo, cand, caja.x, caja.y);
          setStatus(`Widget metido dentro de ${etiquetaUi(cand.kind)}.`);
        } else {
          setStatus(`No caben más de ${PZUi.MAX_DEPTH} niveles de widgets.`, "error");
        }
      } else if (!cand && d.nodo.parent != null) {
        PZUi.detach(state.ui.nodes, d.nodo);
        setStatus("Widget sacado a la raíz de INTERFACES.");
      }
      redraw();
      changed();
      commit();
      return;
    }

    // Tamaño del widget: sin movimiento no hay gesto.
    if (d.kind === "ui-tamano") {
      if (!d.movido) {
        redraw();
        return;
      }
      changed();
      commit();
      return;
    }

    // Objetos simples (imagen y texto): sin movimiento no hay gesto.
    if (!d.movido) {
      redraw();
      return;
    }
    changed();
    commit();
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

  // ── Pizarras de la pestaña ────────────────────────────────

  /**
   * Pinta la tira de pestañas con `pizarras` y marca la activa. La 1 lleva el distintivo IA:
   * es la que leen y editan los agentes y no se puede eliminar.
   */
  function pintaPestanas() {
    el.tabs.textContent = "";
    for (const n of pizarras) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pz-tab" + (n === pizarraActual ? " on" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", n === pizarraActual ? "true" : "false");
      b.textContent = String(n);
      b.title = n === 1 ? "Pizarra 1: la que leen y editan los agentes" : `Pizarra ${n}`;
      if (n === 1) {
        const ia = document.createElement("span");
        ia.className = "pz-tab-ia";
        ia.textContent = "IA";
        b.appendChild(ia);
      }
      b.addEventListener("click", () => {
        if (n === pizarraActual) return;
        // El volcado va primero: el host encadena sus mensajes y lo escribe en la pizarra que
        // se deja, no en la que llega.
        flushSnapshot();
        vscode.postMessage({ type: "switchBoard", board: n });
      });
      el.tabs.appendChild(b);
    }
    // La 1 no se puede eliminar: el `−` se apaga y dice por qué.
    const sola = pizarraActual === 1;
    el.btnBoardDel.disabled = sola;
    el.btnBoardDel.title = sola
      ? "La pizarra 1 no se puede eliminar: es la que leen y editan los agentes"
      : `Eliminar la pizarra ${pizarraActual}`;
  }

  function anadirPizarra() {
    flushSnapshot();
    vscode.postMessage({ type: "addBoard" });
  }

  function eliminarPizarra() {
    if (pizarraActual === 1) return;
    void preguntar(`Se eliminará la pizarra ${pizarraActual} con su imagen. No se puede deshacer.`, "ELIMINAR").then(
      (aceptar) => {
        if (aceptar) {
          // Volcado antes de borrar: el host lo escribe en la pizarra que aún existe.
          flushSnapshot();
          vscode.postMessage({ type: "deleteBoard", board: pizarraActual });
        }
      }
    );
  }

  /** Copia con nombre de la pizarra activa: el host pide el nombre y escribe la carpeta. */
  function guardarPizarra() {
    // Sin el `init` aplicado, la escena sería un lienzo vacío: guardaría lo que no hay.
    if (!iniciada) {
      setStatus("La pizarra aún se está cargando.", "error");
      return;
    }
    if (!hasContent()) {
      setStatus("La pizarra está vacía: no hay nada que guardar.", "error");
      return;
    }
    // El contrato de `saveBoard` pide data URL (el `snapshot` de siempre va en base64 pelado).
    vscode.postMessage({ type: "saveBoard", png: `data:image/png;base64,${pngBase64()}`, scene: escenaParaEnviar() });
  }

  /** Sustituye la pizarra activa por una guardada: el host elige el nombre y manda la escena. */
  function cargarPizarra() {
    flushSnapshot();
    vscode.postMessage({ type: "loadBoard" });
  }

  /** Tira el diagrama, los trazos, las imágenes y los textos y conserva el color de fondo. */
  function vaciar() {
    // El color es una preferencia: vaciar no lo devuelve al blanco.
    state.bg = { color: el.bgColor.value, image: null };
    // La pizarra vacía se ve: el chip FONDO vuelve a encendido.
    fondoVisible = true;
    state.flow = { nodes: [], edges: [] };
    state.ui = { nodes: [] };
    state.strokes = [];
    // Misma razón que en `deleteSelected`: los bitmaps pegados se cierran.
    for (const img of state.images) img.drawable.close?.();
    state.images = [];
    state.texts = [];
    sel = null;
    selNodes = [];
    selEdge = null;
    selUi = null;
    syncUiControls();
    // El widget armado en la paleta no sobrevive al vaciado: se desarma con la escena.
    desarmar();
    hoverNode = null;
    nodeEditing = null;
    editingEdge = null;
    el.editor.hidden = true;
    el.edgeEditor.hidden = true;
    replayStrokes();
    paintLayers();
    redraw();
  }

  function nuevaEnBlanco() {
    if (!hasContent()) {
      setStatus("La pizarra ya está vacía.");
      return;
    }
    void preguntar("Se tiran el diagrama, los trazos, las imágenes y los textos. ¿Vaciar la pizarra?", "VACIAR").then(
      (aceptar) => {
        if (!aceptar) return;
        vaciar();
        soltarLienzo();
        changed();
        commit();
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
    // La extensión escribe el fichero y refresca la copia de trabajo con ese PNG; la escena
    // viaja con él para que el fichero guardado siga siendo editable.
    vscode.postMessage({ type: "save", png: pngBase64(), scene: escenaParaEnviar() });
  }

  /** Ajusta el lienzo al contenido: margen de 40, tope de 4096 y zoom al 100 %. */
  function ajustarLienzo() {
    const cajas = [];
    for (const n of state.flow.nodes) cajas.push({ x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h });
    for (const img of state.images) cajas.push(cajaDeObjeto(img));
    for (const t of state.texts) {
      layout(t);
      cajas.push(cajaDeObjeto(t));
    }
    // Los trazos también cuentan: un lápiz fuera del diagrama se quedaría sin lienzo.
    for (const s of state.strokes) {
      if (!s.pts.length) continue;
      let sx0 = Infinity;
      let sy0 = Infinity;
      let sx1 = -Infinity;
      let sy1 = -Infinity;
      for (const p of s.pts) {
        sx0 = Math.min(sx0, p.x);
        sy0 = Math.min(sy0, p.y);
        sx1 = Math.max(sx1, p.x);
        sy1 = Math.max(sy1, p.y);
      }
      cajas.push({ x0: sx0, y0: sy0, x1: sx1, y1: sy1 });
    }
    // La capa INTERFACES también manda: si un widget queda fuera del lienzo, no sale en el PNG.
    if (PZUi) {
      for (const n of state.ui.nodes) {
        const c = PZUi.place(state.ui.nodes, n);
        cajas.push({ x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h });
      }
    }
    if (!cajas.length) {
      setStatus("No hay nada que encajar todavía.", "error");
      return;
    }
    const x0 = Math.min.apply(null, cajas.map((c) => c.x0));
    const y0 = Math.min.apply(null, cajas.map((c) => c.y0));
    const x1 = Math.max.apply(null, cajas.map((c) => c.x1));
    const y1 = Math.max.apply(null, cajas.map((c) => c.y1));
    const margen = 40;
    const dx = margen - x0;
    const dy = margen - y0;
    if (dx || dy) {
      for (const n of state.flow.nodes) {
        n.x += dx;
        n.y += dy;
      }
      for (const img of state.images) {
        img.x += dx;
        img.y += dy;
      }
      for (const t of state.texts) {
        t.x += dx;
        t.y += dy;
      }
      for (const e of state.flow.edges) {
        if (!e.from.node) {
          e.from.x += dx;
          e.from.y += dy;
        }
        if (!e.to.node) {
          e.to.x += dx;
          e.to.y += dy;
        }
        for (const w of e.waypoints) {
          w.x += dx;
          w.y += dy;
        }
      }
      for (const s of state.strokes) {
        for (const p of s.pts) {
          p.x += dx;
          p.y += dy;
        }
      }
      // Los hijos siguen a su padre: solo se desplazan las raíces.
      if (PZUi) {
        for (const n of state.ui.nodes) {
          if (n.parent == null) {
            n.x += dx;
            n.y += dy;
          }
        }
      }
    }
    const w = clamp(Math.ceil(x1 - x0) + margen * 2, 1, LADO_MAX);
    const h = clamp(Math.ceil(y1 - y0) + margen * 2, 1, LADO_MAX);
    fijarLienzo(w, h);
    // Los trazos se redibujan sobre el lienzo nuevo, ya desplazados.
    replayStrokes();
    changed();
    commit();
    setStatus(`Lienzo ajustado a ${W} × ${H}.`, "ok");
  }

  /** Copia el diagrama como Mermaid; las aristas con punta libre las descarta la librería. */
  function copiarMermaid() {
    if (!state.flow.nodes.length) {
      setStatus("El diagrama está vacío: no hay nada que copiar.", "error");
      return;
    }
    const edges = state.flow.edges.map((e) => ({
      from: e.from.node,
      to: e.to.node,
      fromSide: e.from.side,
      toSide: e.to.side,
      dashed: e.dash,
      arrows: arrowsTexto(e),
      label: e.label,
    }));
    const texto = PZFlow.toMermaid({ nodes: state.flow.nodes, edges });
    vscode.postMessage({ type: "copyText", text: texto });
  }

  function abrirAyuda() {
    el.help.hidden = false;
    el.helpClose.focus();
  }

  function cerrarAyuda() {
    el.help.hidden = true;
  }

  function duplicar() {
    if (selUi && state.ui.nodes.indexOf(selUi) >= 0) {
      duplicarUi();
      return;
    }
    if (!selNodes.length) {
      setStatus("Duplicar pide al menos un nodo elegido.", "error");
      return;
    }
    const copias = new Map();
    for (const n of selNodes) {
      const copia = { ...n, id: PZFlow.newId("n"), x: n.x + 16, y: n.y + 16 };
      copias.set(n.id, copia);
      state.flow.nodes.push(copia);
    }
    for (const e of state.flow.edges.slice()) {
      if (copias.has(e.from.node) && copias.has(e.to.node)) {
        state.flow.edges.push({
          ...e,
          id: PZFlow.newId("e"),
          from: { node: copias.get(e.from.node).id, side: e.from.side },
          to: { node: copias.get(e.to.node).id, side: e.to.side },
          waypoints: e.waypoints.map((w) => ({ x: w.x + 16, y: w.y + 16 })),
          labelOffset: { dx: e.labelOffset.dx, dy: e.labelOffset.dy },
        });
      }
    }
    selectNodos(Array.from(copias.values()));
    changed();
    commit();
    setStatus(`${copias.size} nodo(s) duplicados.`, "ok");
  }

  // ── Portapapeles de la selección ──────────────────────────────

  /** Punto hacia el que mira un extremo, para elegir el lado del ancla al soltarlo de su nodo. */
  function haciaDe(x) {
    if (x.node) {
      const n = state.flow.nodes.find((m) => m.id === x.node);
      if (n) return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    }
    return typeof x.x === "number" ? { x: x.x, y: x.y } : { x: 0, y: 0 };
  }

  /** Extremo de una arista copiada: el nodo copiado se queda; el que no va pasa a punto fijo. */
  function extremoCopia(x, ids, hacia) {
    if (!x.node) return { x: x.x, y: x.y };
    if (ids.has(x.node)) return { node: x.node, side: x.side || "auto" };
    const n = state.flow.nodes.find((m) => m.id === x.node);
    if (!n) return null;
    const lado = x.side && x.side !== "auto" ? x.side : ladoCercano(n, hacia);
    const p = PZFlow.anchorPoint(n, lado, hacia);
    return { x: p.x, y: p.y };
  }

  /** Foto de una arista, o `null` si un extremo cuelga de un nodo que ya no está. */
  function copiaArista(e, ids) {
    const from = extremoCopia(e.from, ids, haciaDe(e.to));
    const to = extremoCopia(e.to, ids, haciaDe(e.from));
    if (!from || !to) return null;
    return {
      from,
      to,
      label: e.label || "",
      color: e.color,
      width: e.width,
      dash: Boolean(e.dash),
      startArrow: Boolean(e.startArrow),
      endArrow: Boolean(e.endArrow),
      waypoints: (e.waypoints || []).map((w) => ({ x: w.x, y: w.y })),
      labelOffset: { dx: e.labelOffset ? e.labelOffset.dx : 0, dy: e.labelOffset ? e.labelOffset.dy : 0 },
    };
  }

  /** Foto de lo elegido, sin referencias vivas. `null` si no hay nada: entonces copia el navegador. */
  function fotoSeleccion() {
    const ids = new Set(selNodes.map((n) => n.id));
    const foto = { nodos: selNodes.map((n) => ({ ...n })), aristas: [], ui: [], objeto: null };
    const vistas = new Set();
    const meter = (e) => {
      const copia = copiaArista(e, ids);
      if (!copia) return;
      vistas.add(e);
      foto.aristas.push(copia);
    };
    for (const e of state.flow.edges) {
      if (ids.size && ids.has(e.from.node) && ids.has(e.to.node)) meter(e);
    }
    // Conector elegido sin sus nodos: viaja solo, con las puntas donde estaban.
    if (selEdge && !vistas.has(selEdge)) meter(selEdge);
    if (selUi && state.ui.nodes.indexOf(selUi) >= 0) {
      foto.ui = ramaUi(selUi.id)
        .map((id) => state.ui.nodes.find((n) => n.id === id))
        .filter(Boolean)
        .map(copiaWidget);
    }
    if (sel && (sel.type === "text" || sel.type === "image")) foto.objeto = { ...sel };
    return foto.nodos.length || foto.aristas.length || foto.ui.length || foto.objeto ? foto : null;
  }

  /** Ctrl+C: guarda la foto. Sin selección devuelve `false` y no intercepta la tecla. */
  function copiarSeleccion() {
    const foto = fotoSeleccion();
    if (!foto) return false;
    portapapeles = foto;
    const partes = [];
    if (foto.nodos.length) partes.push(`${foto.nodos.length} nodo(s)`);
    if (foto.aristas.length) partes.push(`${foto.aristas.length} conector(es)`);
    if (foto.ui.length) partes.push(`${foto.ui.length} widget(s)`);
    if (foto.objeto) partes.push(foto.objeto.type === "text" ? "el bloque de texto" : "la imagen");
    setStatus(`Copiado: ${partes.join(", ")}.`, "ok");
    return true;
  }

  /** Caja de todo lo copiado, en coordenadas del lienzo: decide dónde cae el pegado. */
  function cajaDeCopia(foto) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const suma = (b) => {
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
    };
    if (foto.nodos.length) suma(cajaDeNodos(foto.nodos));
    // Conector suelto: la caja son sus puntas y sus codos, para que caiga bajo el puntero.
    if (!foto.nodos.length) {
      for (const e of foto.aristas) {
        for (const p of [e.from, e.to].concat(e.waypoints)) {
          if (!p.node) suma({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }
      }
    }
    if (PZUi) {
      for (const n of foto.ui) {
        const p = PZUi.place(state.ui.nodes, n);
        suma({ x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h });
      }
    }
    if (foto.objeto) suma(cajaDeObjeto(foto.objeto));
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  /** Nodos copiados con ids nuevos y sus aristas remapeadas. Devuelve el resumen o `null`. */
  function pegarNodos(foto, dx, dy) {
    const nuevos = new Map();
    for (const n of foto.nodos) {
      const copia = { ...n, id: PZFlow.newId("n"), x: red(n.x + dx), y: red(n.y + dy) };
      nuevos.set(n.id, copia);
      state.flow.nodes.push(copia);
    }
    const remapear = (x) => {
      if (!x.node) return { x: red(x.x + dx), y: red(x.y + dy) };
      const n = nuevos.get(x.node);
      return n ? { node: n.id, side: x.side } : null;
    };
    let aristas = 0;
    let ultima = null;
    for (const e of foto.aristas) {
      const from = remapear(e.from);
      const to = remapear(e.to);
      if (!from || !to) continue;
      aristas += 1;
      ultima = {
        ...e,
        id: PZFlow.newId("e"),
        from,
        to,
        waypoints: e.waypoints.map((w) => ({ x: red(w.x + dx), y: red(w.y + dy) })),
      };
      state.flow.edges.push(ultima);
    }
    // Un conector suelto se pega solo: no hay nodos nuevos que seleccionar.
    if (nuevos.size) selectNodos(Array.from(nuevos.values()));
    else if (ultima) selectArista(ultima);
    const partes = [];
    if (nuevos.size) partes.push(`${nuevos.size} nodo(s)`);
    if (aristas) partes.push(`${aristas} conector(es)`);
    return partes.join(" y ");
  }

  /** Subárbol copiado de INTERFACES: ids nuevos, padres remapeados y solo la raíz desplazada. */
  function pegarWidgets(foto, dx, dy) {
    if (!PZUi) {
      setStatus("La capa INTERFACES no está cargada.", "error");
      return null;
    }
    if (state.ui.nodes.length + foto.ui.length > UI_MAX) {
      setStatus("La capa INTERFACES llega al tope de 800 widgets.", "error");
      return null;
    }
    const ids = new Map();
    for (const n of foto.ui) ids.set(n.id, nuevoIdUi());
    const copias = [];
    for (const n of foto.ui) {
      const copia = copiaWidget(n);
      copia.id = ids.get(n.id);
      // Un padre que no viaja en la copia deja el widget en la raíz, ya en su sitio absoluto.
      const padre = n.parent != null && ids.has(n.parent) ? ids.get(n.parent) : null;
      copia.parent = padre;
      // Los hijos van relativos a la caja útil del padre: solo la raíz se desplaza, y desde su
      // caja absoluta, que es la que midió `cajaDeCopia`.
      if (padre === null) {
        const caja = PZUi.place(state.ui.nodes, n);
        copia.x = red(caja.x + dx);
        copia.y = red(caja.y + dy);
      }
      copias.push(copia);
      state.ui.nodes.push(copia);
    }
    selectUi(copias[0]);
    return `${copias.length} widget(s)`;
  }

  /** Texto o imagen copiados. La imagen comparte el `drawable` del original. */
  function pegarObjeto(foto, dx, dy) {
    const o = foto.objeto;
    const copia = { ...o, x: red(o.x + dx), y: red(o.y + dy) };
    if (o.type === "image") {
      // El ImageBitmap copiado es el del original: si ya se soltó, no hay nada que pintar.
      if (!o.drawable || !o.drawable.width) {
        setStatus("La imagen copiada ya no está disponible: vuelve a copiarla.", "error");
        return null;
      }
      state.images.push(copia);
    } else {
      state.texts.push(copia);
    }
    select(copia);
    return o.type === "image" ? "la imagen" : "el bloque de texto";
  }

  /**
   * Ctrl+V: pega la copia en memoria con su esquina en el puntero (sin puntero, 16 px más
   * abajo y a la derecha). Un pegado es una sola entrada del historial.
   */
  function pegarPortapapeles() {
    const foto = portapapeles;
    if (!foto) return false;
    // Pegar widgets con la capa oculta no enseña nada: se enciende, como `insertarUi`.
    const capaApagada = Boolean(foto.ui.length) && state.layers.ui === false;
    if (capaApagada) {
      state.layers.ui = true;
      paintLayers();
    }
    const desde = cajaDeCopia(foto);
    const destino = puntero || { x: desde.x0 + 16, y: desde.y0 + 16 };
    const dx = ajusta(destino.x) - desde.x0;
    const dy = ajusta(destino.y) - desde.y0;
    const dicho = foto.nodos.length || foto.aristas.length
      ? pegarNodos(foto, dx, dy)
      : foto.ui.length
        ? pegarWidgets(foto, dx, dy)
        : pegarObjeto(foto, dx, dy);
    if (!dicho) return true;
    changed();
    commit();
    setStatus(`${capaApagada ? "La capa INTERFACES estaba oculta: la enciendo. " : ""}Pegado: ${dicho}.`, "ok");
    return true;
  }

  function seleccionarTodos() {
    if (!state.flow.nodes.length) {
      setStatus("El diagrama está vacío.", "error");
      return;
    }
    setTool("select");
    selectNodos(state.flow.nodes.slice());
  }

  /** Flechas: 1 px; con Mayús, 10. */
  function moverSeleccion(dx, dy) {
    if (selUi && state.ui.nodes.indexOf(selUi) >= 0) {
      selUi.x += dx;
      selUi.y += dy;
      changed();
      commit();
      return;
    }
    if (selNodes.length) {
      for (const n of selNodes) {
        n.x += dx;
        n.y += dy;
      }
      changed();
      commit();
      return;
    }
    if (sel) {
      sel.x += dx;
      sel.y += dy;
      changed();
      commit();
    }
  }

  /** Ctrl+] acerca un paso; Ctrl+[ lo aleja. Solo nodos. */
  function ordenar(adelante) {
    if (!selNodes.length) return;
    const lista = selNodes.slice().sort((a, b) => state.flow.nodes.indexOf(a) - state.flow.nodes.indexOf(b));
    const orden = adelante ? lista.slice().reverse() : lista;
    for (const n of orden) {
      const i = state.flow.nodes.indexOf(n);
      if (i < 0) continue;
      const destino = adelante ? Math.min(state.flow.nodes.length - 1, i + 1) : Math.max(0, i - 1);
      if (destino === i) continue;
      state.flow.nodes.splice(i, 1);
      state.flow.nodes.splice(destino, 0, n);
    }
    changed();
    commit();
  }

  function alinear(modo) {
    const nodos = selNodes.slice();
    if (nodos.length < 2) return;
    const b = cajaDeNodos(nodos);
    for (const n of nodos) {
      if (modo === "l") n.x = b.x0;
      else if (modo === "c") n.x = (b.x0 + b.x1) / 2 - n.w / 2;
      else if (modo === "r") n.x = b.x1 - n.w;
      else if (modo === "t") n.y = b.y0;
      else if (modo === "m") n.y = (b.y0 + b.y1) / 2 - n.h / 2;
      else if (modo === "b") n.y = b.y1 - n.h;
      n.x = Math.round(n.x);
      n.y = Math.round(n.y);
    }
    changed();
    commit();
  }

  function distribuir(eje) {
    const nodos = selNodes.slice();
    if (nodos.length < 3) {
      setStatus("Distribuir pide al menos tres nodos.", "error");
      return;
    }
    const horizontal = eje === "h";
    const clave = horizontal ? "x" : "y";
    const tam = horizontal ? "w" : "h";
    nodos.sort((a, b) => a[clave] + a[tam] / 2 - (b[clave] + b[tam] / 2));
    const primero = nodos[0][clave];
    const ultimo = nodos[nodos.length - 1];
    const fin = ultimo[clave] + ultimo[tam];
    let total = 0;
    for (const n of nodos) total += n[tam];
    const hueco = (fin - primero - total) / (nodos.length - 1);
    let pos = primero;
    for (const n of nodos) {
      n[clave] = Math.round(pos);
      pos += n[tam] + hueco;
    }
    changed();
    commit();
  }

  // ── Enlaces de interfaz ───────────────────────────────────

  el.tools.forEach((b) =>
    b.addEventListener("click", () => {
      const siguiente = b.dataset.tool;
      const propio = PANEL_DE_HERRAMIENTA[siguiente];
      // Volver a pulsar la herramienta activa cierra su ventana y no cambia de herramienta.
      if (siguiente === tool && propio && panelAbierto === propio) {
        abrirPanel(null);
        return;
      }
      setTool(siguiente);
      // SELECT no tiene ajustes propios: cierra la ventana que hubiera, INTERFAZ incluida.
      if (!propio) abrirPanel(null);
    })
  );
  el.btnNew.addEventListener("click", nuevaEnBlanco);
  el.btnPaste.addEventListener("click", desdePortapapeles);
  el.btnBoardAdd.addEventListener("click", anadirPizarra);
  el.btnBoardDel.addEventListener("click", eliminarPizarra);
  el.btnBoardSave.addEventListener("click", guardarPizarra);
  el.btnBoardLoad.addEventListener("click", cargarPizarra);
  el.btnSave.addEventListener("click", guardar);
  el.btnUndo.addEventListener("click", () => void deshacer());
  el.btnRedo.addEventListener("click", () => void rehacer());
  el.btnFit.addEventListener("click", ajustarLienzo);
  el.btnMermaid.addEventListener("click", copiarMermaid);
  el.btnHelp.addEventListener("click", abrirAyuda);
  el.helpClose.addEventListener("click", cerrarAyuda);
  // Ventana flotante: abre y cierra sin tocar la selección, así se puede seguir ajustando.
  el.btnUi.addEventListener("click", () => {
    const abierto = panelAbierto !== "ui";
    abrirPanel(abierto ? "ui" : null);
    // Cerrar la paleta es decir «no quiero colocar nada»: el armado se va con ella.
    if (!abierto) desarmar();
    if (abierto && !PZUi) setStatus("La capa INTERFACES no está cargada: falta media/pizarraUi.js.", "error");
  });
  el.drawerClose.addEventListener("click", () => {
    abrirPanel(null);
    desarmar();
  });
  el.btnGrid.addEventListener("click", () => {
    rejilla = !rejilla;
    el.btnGrid.classList.toggle("on", rejilla);
    el.btnGrid.setAttribute("aria-pressed", rejilla ? "true" : "false");
    vscode.setState({ grid: rejilla });
    changed();
    setStatus(rejilla ? "Rejilla encendida: 8 px, con ajuste." : "Rejilla apagada: sin guías de 8 px.");
  });
  el.aligns.forEach((b) => b.addEventListener("click", () => alinear(b.dataset.align)));
  el.dists.forEach((b) => b.addEventListener("click", () => distribuir(b.dataset.dist)));

  // Cada deslizador pinta su número al moverlo (el `<output>` de al lado).
  [el.penSize, el.erSize, el.erHard, el.txtSize, el.nodeSize, el.edgeWidth].forEach((input) => {
    const out = document.getElementById(input.id + "-out");
    const pinta = () => {
      if (out) out.textContent = input.value;
    };
    input.addEventListener("input", pinta);
    pinta();
  });

  // Capas: `aria-pressed` es visibilidad y `.on`, la capa activa.
  el.layers.forEach((l) => {
    l.addEventListener("click", () => {
      const clave = l.dataset.layer;
      if (clave === "bg") {
        fondoVisible = !fondoVisible;
        if (!fondoVisible) setStatus("Capa FONDO oculta: el PNG exportado sale con el fondo transparente.");
      } else {
        state.layers[clave] = state.layers[clave] === false;
        if (state.layers[clave] === false) {
          if (clave === "flow") limpiarSeleccion();
          if (clave === "ui" && selUi) limpiarSeleccion();
          if (clave === "texts" && sel && sel.type === "text") select(null);
          if (clave === "images" && sel && sel.type === "image") select(null);
        }
      }
      paintLayers();
      changed();
      commit();
    });
  });

  // Color de fondo del lienzo: pinta al momento y el host lo recuerda para la próxima vez.
  el.bgColor.addEventListener("input", () => {
    state.bg.color = el.bgColor.value;
    changed();
    vscode.postMessage({ type: "bgColor", color: el.bgColor.value });
    // Con imagen de fondo el color queda debajo y no se ve: mejor decirlo que parecer roto.
    if (state.bg.image) {
      setStatus("La imagen de fondo tapa el lienzo: el color se verá al vaciar la pizarra.");
    }
  });
  el.bgColor.addEventListener("change", () => commit());

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
  [el.txtColor, el.txtFamily, el.txtSize].forEach((c) => c.addEventListener("change", () => commit()));

  // Estilos del nodo: crean el nuevo y cambian el elegido. Sin nodos elegidos solo cambia el
  // defecto del próximo nodo: ni escena ni historial.
  el.nodeShape.addEventListener("input", () => {
    const forma = el.nodeShape.value;
    let cambia = false;
    for (const n of selNodes) {
      if (n.shape === forma) continue;
      n.shape = forma;
      if (forma === "icon") {
        if (!PZFlow.ICONS[n.icon]) n.icon = "mail";
        n.iconColor = colorIcono(n);
      }
      cambia = true;
    }
    syncOpciones(); // el campo ICONO depende de la forma elegida
    if (!cambia) return;
    changed();
  });
  el.nodeShape.addEventListener("change", () => {
    // La forma no cambia el tamaño del nodo: el texto se ajusta a la caja nueva de la figura.
    commit();
  });
  el.nodeFill.addEventListener("input", () => {
    rellenoSin = false;
    const valor = el.nodeFill.value;
    let cambia = false;
    for (const n of selNodes) {
      if (n.fill === valor) continue;
      n.fill = valor;
      if (n.shape === "icon") n.iconColor = colorIcono(n);
      cambia = true;
    }
    for (const sw of el.swatches) sw.classList.toggle("on", sw.dataset.fill === valor);
    if (textoAuto && selNodes.length) el.nodeText.value = colorTextoNodo(selNodes[0]);
    if (cambia) changed();
  });
  el.nodeStroke.addEventListener("input", () => {
    const valor = el.nodeStroke.value;
    let cambia = false;
    for (const n of selNodes) {
      if (n.stroke === valor) continue;
      n.stroke = valor;
      cambia = true;
    }
    if (textoAuto && selNodes.length) el.nodeText.value = colorTextoNodo(selNodes[0]);
    if (cambia) changed();
  });
  [el.nodeFill, el.nodeStroke].forEach((c) => c.addEventListener("change", () => commit()));
  el.nodeSize.addEventListener("input", () => {
    const valor = Number(el.nodeSize.value);
    let cambia = false;
    for (const n of selNodes) {
      if (n.fontSize === valor) continue;
      n.fontSize = valor;
      cambia = true;
    }
    if (cambia) changed();
  });
  el.nodeSize.addEventListener("change", () => {
    let crece = false;
    for (const n of selNodes) {
      const alto = n.h;
      crecerNodo(n);
      if (n.h !== alto) crece = true;
    }
    if (crece) changed();
    commit();
  });
  el.nodeIcon.addEventListener("input", () => {
    const icono = el.nodeIcon.value;
    let cambia = false;
    for (const n of selNodes) {
      if (n.shape !== "icon" || n.icon === icono) continue;
      n.icon = icono;
      n.iconColor = colorIcono(n);
      cambia = true;
    }
    if (!cambia) return;
    changed();
    commit();
  });
  // Color del texto: el fijado a mano manda; AUTO vuelve a resolverlo con el relleno.
  el.nodeText.addEventListener("input", () => {
    const valor = el.nodeText.value;
    let cambia = false;
    for (const n of selNodes) {
      if (n.textColor === valor) continue;
      n.textColor = valor;
      cambia = true;
    }
    textoAuto = false;
    el.nodeTextAuto.classList.remove("on");
    el.nodeTextAuto.setAttribute("aria-pressed", "false");
    if (cambia) changed();
  });
  el.nodeText.addEventListener("change", () => commit());
  el.nodeTextAuto.addEventListener("click", () => {
    textoAuto = true;
    let cambia = false;
    for (const n of selNodes) {
      if (n.textColor === "auto") continue;
      n.textColor = "auto";
      cambia = true;
    }
    el.nodeTextAuto.classList.add("on");
    el.nodeTextAuto.setAttribute("aria-pressed", "true");
    if (selNodes.length) el.nodeText.value = colorTextoNodo(selNodes[0]);
    if (cambia) {
      changed();
      commit();
    }
  });

  el.swatches.forEach((sw) =>
    sw.addEventListener("click", () => {
      const relleno = sw.dataset.fill;
      const borde = sw.dataset.stroke;
      rellenoSin = relleno === "none";
      if (!rellenoSin) el.nodeFill.value = relleno;
      el.nodeStroke.value = borde;
      let cambia = false;
      for (const n of selNodes) {
        if (n.fill === relleno && n.stroke === borde) continue;
        n.fill = relleno;
        n.stroke = borde;
        if (n.shape === "icon") n.iconColor = colorIcono(n);
        cambia = true;
      }
      for (const s of el.swatches) s.classList.toggle("on", s === sw);
      if (textoAuto && selNodes.length) el.nodeText.value = colorTextoNodo(selNodes[0]);
      if (!cambia) return;
      changed();
      commit();
    })
  );

  // Estilo de los conectores: edita el elegido y se recuerda para los nuevos. Sin arista
  // elegida los controles están ocultos: no hay nada que hacer.
  el.edgeColor.addEventListener("input", () => {
    if (!selEdge || selEdge.color === el.edgeColor.value) return;
    EDGE_STYLE.color = el.edgeColor.value;
    selEdge.color = EDGE_STYLE.color;
    changed();
  });
  el.edgeWidth.addEventListener("input", () => {
    const valor = Number(el.edgeWidth.value);
    if (!selEdge || selEdge.width === valor) return;
    EDGE_STYLE.width = valor;
    selEdge.width = valor;
    changed();
  });
  el.edgeDash.addEventListener("change", () => {
    EDGE_STYLE.dash = el.edgeDash.checked;
    if (selEdge) selEdge.dash = EDGE_STYLE.dash;
    changed();
    commit();
  });
  el.edgeArrows.addEventListener("change", () => {
    const a = el.edgeArrows.value;
    EDGE_STYLE.arrows = a;
    if (selEdge) {
      selEdge.startArrow = a === "both" || a === "back";
      selEdge.endArrow = a === "arrow" || a === "both";
    }
    changed();
    commit();
  });
  [el.edgeColor, el.edgeWidth].forEach((c) => c.addEventListener("change", () => commit()));

  el.frame.addEventListener("pointerdown", onDown);
  el.frame.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  // El SO o Chromium pueden quitar el gesto al lápiz (ink/manejo de Windows): llega
  // `pointercancel` y NUNCA `pointerup`. Sin esto el `drag` queda clavado y el trazo persigue
  // al lápiz cuando solo planea sobre la pantalla.
  el.frame.addEventListener("pointercancel", onUp);
  // Fuera del marco no hay chivato: el puntero deja de ser una posición del lienzo.
  el.frame.addEventListener("pointerleave", () => {
    puntero = null;
    redraw();
  });

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
      const nuevo = zoomEn(view.z, view.tx, view.ty, z2, m.x - el.world.offsetLeft, m.y - el.world.offsetTop);
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
    // Doble clic dentro de un área de edición: es el del navegador seleccionando texto.
    if (event.target === el.editor || event.target === el.edgeEditor) return;
    const p = toCanvas(event);
    // Mismo orden que el golpe de puntero: textos → imágenes → INTERFACES → nodos → aristas.
    const o = hitObject(p);
    if (o && o.type === "text") {
      setTool("select");
      select(o);
      openEditor(o);
      return;
    }
    if (o && o.type === "image") {
      setTool("select");
      select(o);
      return;
    }
    // INTERFACES: doble clic en un widget lleva a su etiqueta en el inspector.
    if (PZUi && state.layers.ui !== false) {
      const golpe = PZUi.hit(state.ui.nodes, p.x, p.y);
      if (golpe) {
        setTool("select");
        selectUi(golpe.node);
        abrirPanel("ui");
        enfocarEtiquetaUi(golpe.node);
        return;
      }
    }
    const n = nodoEn(p);
    if (n) {
      setTool("select");
      setNodoActivo(n);
      abrirEditorNodo(n);
      return;
    }
    if (selEdge) {
      const pts = puntosUsuario(selEdge);
      if (pts && pts.length >= 3) {
        // Doble clic en un codo (lejos de la etiqueta) lo quita.
        const radio = px(10);
        let k = -1;
        for (let i = 1; i < pts.length - 1; i++) {
          if (Math.abs(p.x - pts[i].x) <= radio && Math.abs(p.y - pts[i].y) <= radio) {
            k = i;
            break;
          }
        }
        if (k >= 0) {
          if (!materializar(selEdge)) return;
          // `pts[k]` es `waypoints[k - 1]` antes y después de materializar.
          selEdge.waypoints.splice(k - 1, 1);
          // Deduplicar consecutivos: el codo que quitaba la librería puede dejar un punto
          // repetido justo en su sitio.
          const limpios = [];
          for (const w of selEdge.waypoints) {
            const ult = limpios[limpios.length - 1];
            if (!ult || Math.abs(ult.x - w.x) > 0.01 || Math.abs(ult.y - w.y) > 0.01) limpios.push(w);
          }
          selEdge.waypoints = limpios;
          changed();
          commit();
          setStatus("Codo quitado.");
          return;
        }
      }
    }
    const e = aristaEn(p);
    if (e) {
      setTool("select");
      selectArista(e);
      abrirEditorArista(e);
      return;
    }
    // En el vacío no crea nada: los objetos se crean desde un botón.
  });

  /** Deja un nodo elegido en solitario con la herramienta de selección. */
  function setNodoActivo(n) {
    if (selNodes.length === 1 && selNodes[0] === n) return;
    selectNodos([n]);
  }

  el.editor.addEventListener("input", () => {
    if (nodeEditing) {
      nodeEditing.text = el.editor.value;
      colocaEditorNodo(nodeEditing);
      changed();
      return;
    }
    if (!editing) return;
    editing.text = el.editor.value;
    growEditor();
    changed();
  });
  el.editor.addEventListener("blur", () => {
    if (nodeEditing) confirmarEditorNodo();
    else closeEditor();
  });
  el.editor.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (nodeEditing) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelarEditorNodo();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        confirmarEditorNodo("derecha");
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        confirmarEditorNodo("abajo");
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        confirmarEditorNodo();
      }
      return;
    }
    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      closeEditor();
    }
  });

  el.edgeEditor.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cerrarEditorArista(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      cerrarEditorArista(true);
    }
  });
  el.edgeEditor.addEventListener("blur", () => cerrarEditorArista(true));

  window.addEventListener("paste", (event) => {
    // Dentro de un área de edición se pega el texto, no la imagen.
    if (editing || nodeEditing || editingEdge) return;
    event.preventDefault();
    void pasteImage(event.clipboardData).then((habia) => {
      if (!habia) setStatus("El portapapeles no trae ninguna imagen.", "error");
    });
  });

  document.addEventListener("keydown", (event) => {
    if (editing || nodeEditing || editingEdge) return;
    // Con el foco en un control (color, fuente, deslizadores) las teclas son suyas.
    const objetivo = event.target;
    if (objetivo && /^(?:INPUT|SELECT|TEXTAREA)$/.test(String(objetivo.tagName))) return;
    if (event.key === "Escape" && !el.help.hidden) {
      event.preventDefault();
      cerrarAyuda();
      return;
    }
    if (event.key === "Escape" && cerrarModal) {
      // El mini-modal abierto manda: Escape lo descarta sin tocar la selección.
      event.preventDefault();
      cerrarModal(false);
      return;
    }
    // Con el modal o la ayuda en pantalla, nada de lo de detrás responde: sus botones son
    // BUTTON y no los filtra el guard de arriba.
    if (cerrarModal || !el.help.hidden) return;

    // Colocación armada: Escape la desarma antes de tocar ventana o selección.
    if (event.key === "Escape" && pendiente) {
      event.preventDefault();
      desarmar();
      redraw();
      setStatus("Colocación cancelada.");
      return;
    }

    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && !event.altKey) {
      const clave = String(event.key).toLowerCase();
      if (clave === "z") {
        event.preventDefault();
        if (event.shiftKey) void rehacer();
        else void deshacer();
        return;
      }
      if (clave === "y") {
        event.preventDefault();
        void rehacer();
        return;
      }
      if (clave === "d") {
        event.preventDefault();
        duplicar();
        return;
      }
      if (clave === "c") {
        // Sin selección no se intercepta: en las áreas de edición copia el navegador.
        if (!copiarSeleccion()) return;
        event.preventDefault();
        return;
      }
      if (clave === "v") {
        // Sin copia propia, el evento `paste` de siempre trae la imagen del portapapeles.
        if (!portapapeles) return;
        event.preventDefault();
        pegarPortapapeles();
        return;
      }
      if (clave === "a") {
        event.preventDefault();
        seleccionarTodos();
        return;
      }
      if (event.code === "BracketRight") {
        event.preventDefault();
        ordenar(true);
        return;
      }
      if (event.code === "BracketLeft") {
        event.preventDefault();
        ordenar(false);
        return;
      }
    }

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
      if (sel || selNodes.length || selEdge || selUi) {
        event.preventDefault();
        deleteSelected();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // La ventana abierta se cierra antes de soltar la selección; la herramienta no cambia.
      if (panelAbierto) {
        abrirPanel(null);
        return;
      }
      limpiarSeleccion();
      return;
    }
    const paso = event.shiftKey ? 10 : 1;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moverSeleccion(-paso, 0);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moverSeleccion(paso, 0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moverSeleccion(0, -paso);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moverSeleccion(0, paso);
      return;
    }
    if (ctrl || event.altKey) return;
    const letra = String(event.key).toLowerCase();
    const atajos = { v: "select", n: "node", t: "text", p: "pen", b: "eraser" };
    if (atajos[letra]) {
      event.preventDefault();
      setTool(atajos[letra]);
      // V no tiene panel: cierra el que hubiera, como el botón SELECT.
      if (!PANEL_DE_HERRAMIENTA[atajos[letra]]) abrirPanel(null);
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
    if (nodeEditing) colocaEditorNodo(nodeEditing);
    if (editingEdge) colocaEditorArista(editingEdge);
    redraw();
  });

  // ── Mensajes con la extensión ─────────────────────────────

  window.addEventListener("message", async (event) => {
    const m = event.data;
    if (!m) return;
    if (m.type === "init") {
      const gen = ++initGen;
      // Un `snapshot` de rebote no se cuela en la pizarra que llega.
      iniciada = false;
      pizarraActual = num(m.board, 1);
      pizarras = Array.isArray(m.boards) && m.boards.length ? m.boards.slice() : [1];
      pintaPestanas();
      // Los `init` van en cadena: uno lento no puede aplicar su escena sobre la pizarra siguiente.
      const previa = cargando;
      // Se guarda la promesa: una `capture` que llegue antes de terminar exportaría un lienzo en
      // blanco y la extensión lo escribiría encima de la copia de trabajo.
      cargando = (async () => {
        if (previa) await previa;
        if (gen !== initGen) return;
        // Se compara al aplicar, no al recibir: dos clics de pestaña seguidos dejan `iniciada` en
        // `false` y el `init` viejo ya no delata el cambio. `init` también llega al cambiar de
        // pizarra, y con `scene:null` + `png:null` nada más vaciaría el lienzo.
        const cambiada = pizarraVisible !== pizarraActual;
        if (cambiada) {
          vaciar();
          // Vista limpia: el zoom y el paneo de la otra pizarra no valen aquí. `dirty` a cero
          // para no devolver al host lo que se acaba de dejar.
          dirty = false;
          fijado = false;
          H = SIZE;
          medirMarco(true);
          view.z = 1;
          view.tx = 0;
          view.ty = 0;
          aplicaVista();
          reiniciarHistorial();
        }
        pizarraVisible = pizarraActual;
        const doc = m.scene && typeof m.scene === "object" ? m.scene : null;
        if (doc) {
          await aplicarEscena(doc, { mantenerVista: false });
          // La escena manda: el color del host solo vale para pizarras sin escena.
          if (!doc.bg || !HEX.test(doc.bg.color)) aplicaFondo(m.bgColor);
          setStatus(`Pizarra restaurada: ${W} × ${H}.`);
          reiniciarHistorial();
        } else if (m.png && !hasContent()) {
          try {
            const img = await loadImage(m.png);
            // La copia de trabajo conserva su tamaño: reabrir una pizarra de 100 × 100 no la
            // devuelve a un lienzo enorme con la imagen diminuta en el centro.
            fijarLienzo(img.width, img.height);
            state.bg = { color: BG_DEFAULT, image: { drawable: img, width: W, height: H, src: srcDeImagen(m.png, img) } };
            setStatus("Pizarra anterior restaurada desde la copia de trabajo.");
          } catch {
            setStatus("La copia de trabajo no se ha podido leer.", "error");
          }
          // El color elegido lo guarda el host: vale también con el panel recién abierto.
          aplicaFondo(m.bgColor);
          reiniciarHistorial();
        } else {
          aplicaFondo(m.bgColor);
          setStatus(`Pizarra ${pizarraActual}.`);
          reiniciarHistorial();
        }
        if (gen !== initGen) return;
        paintLayers();
        actualizarContexto();
        // `redraw`, no `changed`: restaurar no es un cambio, y reescribir la copia con la misma
        // imagen no aporta nada.
        redraw();
        // Desde aquí la escena ya está puesta y sus guardados son seguros. Si el marco se midió
        // antes de llegar (lienzo elástico) quedó `dirty` sin temporizador: se guarda ahora.
        iniciada = true;
        // Con escena restaurada se rehace la copia: si otro proceso (el MCP) la cambió con el
        // panel cerrado, el PNG aplanado se quedaría viejo.
        if (doc) dirty = true;
        if (dirty) {
          clearTimeout(snapshotTimer);
          snapshotTimer = setTimeout(flushSnapshot, 600);
        }
      })();
      return;
    }
    if (m.type === "sceneReload") {
      const doc = m.scene && typeof m.scene === "object" ? m.scene : null;
      if (doc) {
        // Otro proceso (el MCP) reescribió la escena: se aplica sin mover la vista y se deja
        // entrada de deshacer, para que el usuario pueda volver a lo que tenía.
        if (cargando) await cargando;
        await aplicarEscena(doc, { mantenerVista: true });
        changed();
        commit();
        setStatus("La escena cambió fuera del panel: recargada.");
      }
      return;
    }
    if (m.type === "boardLoaded") {
      const doc = m.scene && typeof m.scene === "object" ? m.scene : null;
      if (!doc) return;
      // Como `sceneReload`: si la copia de trabajo aún se está aplicando, la carga espera.
      if (cargando) await cargando;
      // Sustituye TODO (lienzo, fondo, capas, diagrama, imágenes, INTERFACES, trazos y textos).
      // `mantenerVista` deja el zoom y el paneo donde estaban, también con lienzo fijado.
      await aplicarEscena(doc, { mantenerVista: true });
      // Una entrada de historial: deshacer devuelve lo que había antes de cargar.
      changed();
      commit();
      setStatus(`Pizarra «${m.name || "guardada"}» cargada: ${W} × ${H}.`, "ok");
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
      // El lienzo pasa a ser el de la imagen: el PNG, la copia de trabajo y lo que sube el
      // dictado salen de ese tamaño, no del panel. Va antes de `vaciar` para que su repintado
      // de trazos ya use el lienzo nuevo.
      fijarLienzo(img.width, img.height);
      vaciar();
      state.bg = { color: el.bgColor.value, image: { drawable: img, width: W, height: H, src: srcDeImagen(m.src, img) } };
      changed();
      commit();
      setStatus(`Lienzo ${W} × ${H} con la imagen del portapapeles.`, "ok");
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
      vscode.postMessage({ type: "snapshot", board: pizarraActual, png: pngBase64(), scene: escenaParaEnviar() });
      return;
    }
    if (m.type === "boardSaved") {
      setStatus(`Pizarra guardada como «${m.name}»${m.dir ? ` en ${m.dir}` : ""}.`, "ok");
      return;
    }
    if (m.type === "saved") {
      setStatus(`Guardado en ${m.path}${m.scenePath ? ` y ${m.scenePath}` : ""}`, "ok");
      return;
    }
    if (m.type === "copied") {
      if (m.ok) setStatus("Diagrama copiado como Mermaid al portapapeles.", "ok");
      else setStatus(`No se pudo copiar: ${m.error || "error desconocido"}`, "error");
      return;
    }
    if (m.type === "sceneRejected") {
      // Se dice, pero no se toca nada de la pantalla: lo dibujado sigue aquí.
      setStatus("La escena no ha pasado la validación del host; la pantalla no se toca.", "error");
    }
  });

  // ── Arranque ──────────────────────────────────────────────

  const guardado = vscode.getState() || {};
  rejilla = guardado.grid !== false;
  el.btnGrid.classList.toggle("on", rejilla);
  el.btnGrid.setAttribute("aria-pressed", rejilla ? "true" : "false");

  // BG_DEFAULT es la única fuente del color por defecto: el HTML solo lleva el valor inicial.
  el.bgColor.value = BG_DEFAULT;
  construirPaleta();
  construirInspector();
  syncUiControls();
  setTool("select");
  pintaPestanas(); // la 1 sola y con el `−` apagado hasta que el host mande su `init`
  aplicaVista();
  medirMarco(true); // primer ajuste con el aspecto real del marco antes de pintar nada
  pintaMedida();
  paintLayers();
  compose();
  reiniciarHistorial();
  vscode.postMessage({ type: "ready" });
})();
