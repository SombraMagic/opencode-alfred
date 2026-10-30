/**
 * Herramientas de pizarra del servidor MCP `mcp_alfred`: leen y escriben la escena editable
 * (`pizarra.json`) del proyecto abierto, capa a capa. Sin `vscode` y sin dependencias nuevas.
 *
 * Toda escritura pasa por `sanitizeScene` y `writeSceneFile`: el fichero nunca queda a medias
 * y lo que se ve en el panel es exactamente lo que se guardó. El panel vigila el fichero, así
 * que lo escrito aquí aparece en la pestaña abierta.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import {
  ALIGNS,
  DATA_IMAGE,
  emptyScene,
  HEX_COLOR,
  isRecord,
  MAX_CANVAS_SIDE,
  MAX_COORD,
  MAX_IMAGE_CHARS,
  sanitizeScene,
  SHAPES,
  SIDES,
} from "../pizarra/scene";
import type {
  Scene,
  SceneEdge,
  SceneEndpoint,
  SceneImage,
  SceneNode,
  SceneText,
} from "../pizarra/scene";
import { readSceneFile, SCENE_FILE, WORK_FILE, writeSceneFile } from "../pizarra/files";
import { MAX_UI_ITEMS, MAX_UI_NODES, sanitizeUi, uiContent, uiDefaults, UI_KINDS } from "../pizarra/ui";
import type { Ui, UiNode } from "../pizarra/ui";
import { readEntorno } from "../voice/core/shared";

/** Iconos de nodo del webview (`media/pizarraWorkflow.js`): aquí solo se validan los nombres. */
const ICONS: readonly string[] = [
  "mail",
  "key",
  "user",
  "database",
  "cloud",
  "api",
  "clock",
  "gear",
  "doc",
  "lock",
  "globe",
  "terminal",
];
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// ── Argumentos ─────────────────────────────────────────────

/** Número del argumento, acotado; `undefined` si no llega. */
function numOf(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`«${key}» tiene que ser un número.`);
  }
  return Math.min(max, Math.max(min, raw));
}

/** Cadena del argumento; `undefined` si no llega (una cadena vacía sí llega). */
function strOf(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new Error(`«${key}» tiene que ser texto.`);
  }
  return raw;
}

function boolOf(args: Record<string, unknown>, key: string): boolean | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "boolean") {
    throw new Error(`«${key}» tiene que ser true o false.`);
  }
  return raw;
}

function enumOf(
  args: Record<string, unknown>,
  key: string,
  opciones: readonly string[],
): string | undefined {
  const raw = strOf(args, key);
  if (raw === undefined) {
    return undefined;
  }
  if (!opciones.includes(raw)) {
    throw new Error(`«${key}» no vale "${raw}": ${opciones.filter(Boolean).join(", ")}.`);
  }
  return raw;
}

/** Color `#rrggbb`, en minúsculas. */
function hexOf(args: Record<string, unknown>, key: string): string | undefined {
  const raw = strOf(args, key);
  if (raw === undefined) {
    return undefined;
  }
  if (!HEX_COLOR.test(raw)) {
    throw new Error(`«${key}» tiene que ser un color #rrggbb.`);
  }
  return raw.toLowerCase();
}

/** Relleno de nodo: hex o `"none"`. */
function rellenoOf(args: Record<string, unknown>): string | undefined {
  if (args.relleno === "none") {
    return "none";
  }
  return hexOf(args, "relleno");
}

/** Color de texto: hex o `"auto"` (contraste con el relleno). */
function colorTextoOf(args: Record<string, unknown>): string | undefined {
  if (args.colorTexto === "auto") {
    return "auto";
  }
  return hexOf(args, "colorTexto");
}

function pesoOf(args: Record<string, unknown>): number | undefined {
  const raw = args.peso;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (raw !== 400 && raw !== 600 && raw !== 700) {
    throw new Error("«peso» tiene que ser 400, 600 o 700.");
  }
  return raw;
}

/** Acción de las herramientas de edición. */
function accionOf(args: Record<string, unknown>): "crear" | "editar" | "borrar" {
  const accion = enumOf(args, "accion", ["crear", "editar", "borrar"]);
  if (!accion) {
    throw new Error("Falta «accion»: crear, editar o borrar.");
  }
  return accion as "crear" | "editar" | "borrar";
}

/** Índice 0-based de una lista sin ids (textos, imágenes). */
function indiceDe(args: Record<string, unknown>, total: number): number {
  const raw = args.indice;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= total) {
    throw new Error(
      `«indice» tiene que ser un entero entre 0 y ${Math.max(0, total - 1)}: pizarra_leer devuelve la lista.`,
    );
  }
  return raw;
}

/** Id nuevo (`n1`, `e2`, …) válido y sin repetir. */
function idNuevo(prefijo: string, usados: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const id = `${prefijo}${n}`;
    if (!usados.has(id)) {
      return id;
    }
  }
}

/** Recorte de un texto para las respuestas. */
function recorte(texto: string, max = 40): string {
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}

// ── Carpeta y escena ───────────────────────────────────────

/**
 * Carpeta de la pizarra: la extensión publica la del proyecto abierto en `entorno.json`
 * porque el MCP no sabe qué carpeta tiene abierta; el `cwd` es el respaldo.
 */
function pizarraDir(args: Record<string, unknown>): string {
  const propia = typeof args.carpeta === "string" && args.carpeta ? args.carpeta : undefined;
  return (
    propia ??
    process.env.ALFRED_PIZARRA_DIR ??
    readEntorno().pizarraDir ??
    join(process.cwd(), ".alfred", "adjuntos")
  );
}

async function loadScene(dir: string): Promise<Scene> {
  const scene = await readSceneFile(dir);
  if (scene) {
    return scene;
  }
  if (await existe(join(dir, SCENE_FILE))) {
    throw new Error(
      "pizarra.json no se puede leer o no pasa el saneado: revísala o bórrala desde el panel antes de tocarla.",
    );
  }
  // Una pizarra sin escena pero con PNG es un estado real (pizarras antiguas y las que el
  // webview deja en `null` por tamaño): escribir encima la dejaría en blanco sin avisar.
  if (await existe(join(dir, WORK_FILE))) {
    throw new Error(
      "La pizarra solo tiene el PNG aplanado, sin escena: ábrela una vez en el panel para que se guarde pizarra.json y vuelve a intentarlo.",
    );
  }
  return emptyScene();
}

async function existe(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function cuenta(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Cola de toda respuesta de escritura. */
function resumen(scene: Scene): string {
  return (
    `Ahora: ${cuenta(scene.flow.nodes.length, "nodo", "nodos")}, ` +
    `${cuenta(scene.flow.edges.length, "arista", "aristas")}, ` +
    `${cuenta(scene.images.length, "imagen", "imágenes")}, ` +
    `${cuenta(scene.strokes.length, "trazo", "trazos")}, ` +
    `${cuenta(scene.texts.length, "texto", "textos")} en ${scene.canvas.w}×${scene.canvas.h}.`
  );
}

/** Sanea, guarda y devuelve la frase con el resumen. */
async function saveScene(dir: string, next: unknown, hecha: string): Promise<string> {
  const saneada = sanitizeScene(next);
  if (!saneada) {
    throw new Error(
      "La escena resultante no es válida: revisa el lienzo (1 a 4096 por lado), el fondo y las imágenes.",
    );
  }
  await writeSceneFile(dir, saneada);
  return `${hecha} ${resumen(saneada)}`;
}

/** Vista de la escena para el agente: sin base64 ni puntos de trazo, que no caben en una respuesta. */
function vistaEscena(scene: Scene) {
  return {
    lienzo: { ancho: scene.canvas.w, alto: scene.canvas.h, fijo: scene.canvas.fixed },
    fondo: {
      color: scene.bg.color,
      imagen: scene.bg.image ? `«imagen de fondo: ${scene.bg.image.length} caracteres»` : null,
    },
    capas: scene.layers,
    nodos: scene.flow.nodes,
    aristas: scene.flow.edges,
    textos: scene.texts,
    imagenes: scene.images.map(({ src, ...resto }) => ({
      ...resto,
      src: `«imagen: ${src.length} caracteres»`,
    })),
    trazos: {
      total: scene.strokes.length,
      puntos: scene.strokes.reduce((n, trazo) => n + trazo.pts.length, 0),
    },
    // La capa INTERFACES va solo contada: el árbol entero es cosa de pizarra_ui_leer.
    ui: recuentoUi(scene.ui),
  };
}

// ── Imágenes ───────────────────────────────────────────────

/** Data URL de un fichero local, con su tamaño en píxeles si es PNG. */
async function imagenDeFichero(ruta: string): Promise<{ src: string; w?: number; h?: number }> {
  const file = isAbsolute(ruta) ? ruta : resolve(process.cwd(), ruta);
  const mime = MIME[extname(file).toLowerCase()];
  if (!mime) {
    throw new Error(`«ruta» tiene que ser .png, .jpg, .jpeg, .webp o .gif: "${file}".`);
  }
  // El tope se mide en disco antes de leer: no se carga en memoria una imagen de 300 MB.
  const info = await stat(file).catch(() => undefined);
  if (!info) {
    throw new Error(`No se puede leer la imagen "${file}".`);
  }
  if (info.size > (MAX_IMAGE_CHARS * 3) / 4) {
    throw new Error(`La imagen "${file}" pasa del tope de 6 MB ya en data URL.`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new Error(`No se puede leer la imagen "${file}".`);
  }
  const src = `data:${mime};base64,${bytes.toString("base64")}`;
  if (src.length > MAX_IMAGE_CHARS) {
    throw new Error(`La imagen "${file}" pasa del tope de 6 MB ya en data URL.`);
  }
  // Cabecera PNG: ancho y alto son los dos enteros big-endian del IHDR (bytes 16-24).
  const esPng =
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes.toString("ascii", 12, 16) === "IHDR";
  return esPng
    ? { src, w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }
    : { src };
}

/** Data URL que llega tal cual por `dataUrl`. */
function imagenDeDataUrl(raw: string): { src: string; w?: number; h?: number } {
  if (!DATA_IMAGE.test(raw) || raw.length > MAX_IMAGE_CHARS) {
    throw new Error(
      "«dataUrl» tiene que ser una imagen png, jpeg, webp o gif en base64 de menos de 6 MB.",
    );
  }
  return { src: raw };
}

// ── Nodos y aristas ────────────────────────────────────────

function aplicarNodo(nodo: SceneNode, args: Record<string, unknown>): void {
  const forma = enumOf(args, "forma", SHAPES);
  if (forma !== undefined) nodo.shape = forma;
  const x = numOf(args, "x", -MAX_COORD, MAX_COORD);
  if (x !== undefined) nodo.x = x;
  const y = numOf(args, "y", -MAX_COORD, MAX_COORD);
  if (y !== undefined) nodo.y = y;
  const ancho = numOf(args, "ancho", 1, MAX_COORD);
  if (ancho !== undefined) nodo.w = ancho;
  const alto = numOf(args, "alto", 1, MAX_COORD);
  if (alto !== undefined) nodo.h = alto;
  const texto = strOf(args, "texto");
  if (texto !== undefined) nodo.text = texto;
  const relleno = rellenoOf(args);
  if (relleno !== undefined) nodo.fill = relleno;
  const borde = hexOf(args, "borde");
  if (borde !== undefined) nodo.stroke = borde;
  const colorTexto = colorTextoOf(args);
  if (colorTexto !== undefined) nodo.textColor = colorTexto;
  const tamano = numOf(args, "tamanoTexto", 6, 300);
  if (tamano !== undefined) nodo.fontSize = tamano;
  const peso = pesoOf(args);
  if (peso !== undefined) nodo.weight = peso;
  const alinear = enumOf(args, "alinear", ALIGNS);
  if (alinear !== undefined) nodo.align = alinear;
  const icono = enumOf(args, "icono", ICONS);
  if (icono !== undefined) nodo.icon = icono;
  const colorIcono = hexOf(args, "colorIcono");
  if (colorIcono !== undefined) nodo.iconColor = colorIcono;
}

/** Extremo de arista: o el lado de un nodo existente, o un punto suelto. */
function extremoDe(
  args: Record<string, unknown>,
  key: string,
  ids: Set<string>,
): SceneEndpoint | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`«${key}» tiene que ser { nodo, lado } o { x, y }.`);
  }
  const nodo = strOf(raw, "nodo");
  if (nodo !== undefined) {
    if (!ids.has(nodo)) {
      throw new Error(
        `«${key}» apunta al nodo "${nodo}", que no existe: pizarra_leer devuelve los ids.`,
      );
    }
    return { node: nodo, side: enumOf(raw, "lado", SIDES) ?? "auto" };
  }
  const x = numOf(raw, "x", -MAX_COORD, MAX_COORD);
  const y = numOf(raw, "y", -MAX_COORD, MAX_COORD);
  if (x === undefined || y === undefined) {
    throw new Error(`«${key}» necesita «nodo», o «x» e «y».`);
  }
  return { x, y };
}

function codosDe(args: Record<string, unknown>): { x: number; y: number }[] | undefined {
  const raw = args.codos;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("«codos» tiene que ser un array de {x, y}.");
  }
  return raw.map((punto) => {
    if (!isRecord(punto)) {
      throw new Error("Cada codo tiene que ser {x, y}.");
    }
    const x = numOf(punto, "x", -MAX_COORD, MAX_COORD);
    const y = numOf(punto, "y", -MAX_COORD, MAX_COORD);
    if (x === undefined || y === undefined) {
      throw new Error("Cada codo necesita «x» e «y».");
    }
    return { x, y };
  });
}

function aplicarArista(arista: SceneEdge, args: Record<string, unknown>, ids: Set<string>): void {
  const desde = extremoDe(args, "desde", ids);
  if (desde) arista.from = desde;
  const hasta = extremoDe(args, "hasta", ids);
  if (hasta) arista.to = hasta;
  const etiqueta = strOf(args, "etiqueta");
  if (etiqueta !== undefined) arista.label = etiqueta;
  const color = hexOf(args, "color");
  if (color !== undefined) arista.color = color;
  const grosor = numOf(args, "grosor", 0.5, 20);
  if (grosor !== undefined) arista.width = grosor;
  const discontinua = boolOf(args, "discontinua");
  if (discontinua !== undefined) arista.dash = discontinua;
  const flechaInicio = boolOf(args, "flechaInicio");
  if (flechaInicio !== undefined) arista.startArrow = flechaInicio;
  const flechaFin = boolOf(args, "flechaFin");
  if (flechaFin !== undefined) arista.endArrow = flechaFin;
  const codos = codosDe(args);
  if (codos !== undefined) arista.waypoints = codos;
}

/** ¿La arista toca el nodo? Basta con que uno de sus dos extremos sea ese nodo. */
function tocaNodo(arista: SceneEdge, id: string): boolean {
  return (
    ("node" in arista.from && arista.from.node === id) ||
    ("node" in arista.to && arista.to.node === id)
  );
}

// ── Textos e imágenes sin id ───────────────────────────────

function aplicarTexto(texto: SceneText, args: Record<string, unknown>): void {
  const cuerpo = strOf(args, "texto");
  if (cuerpo !== undefined) {
    if (!cuerpo) {
      throw new Error("«texto» no puede quedar vacío: un texto sin cuerpo desaparece de la escena.");
    }
    texto.text = cuerpo;
  }
  const x = numOf(args, "x", -MAX_COORD, MAX_COORD);
  if (x !== undefined) texto.x = x;
  const y = numOf(args, "y", -MAX_COORD, MAX_COORD);
  if (y !== undefined) texto.y = y;
  const ancho = numOf(args, "ancho", 1, MAX_COORD);
  if (ancho !== undefined) texto.w = ancho;
  const alto = numOf(args, "alto", 1, MAX_COORD);
  if (alto !== undefined) texto.h = alto;
  const giro = numOf(args, "giro", -Math.PI * 4, Math.PI * 4);
  if (giro !== undefined) texto.rot = giro;
  const color = hexOf(args, "color");
  if (color !== undefined) texto.color = color;
  const tamano = numOf(args, "tamano", 6, 300);
  if (tamano !== undefined) texto.size = tamano;
  const familia = strOf(args, "familia");
  // Vacía dejaría el `font` sin familia: el lienzo la ignora y el texto sale a 10 px.
  if (familia !== undefined) texto.family = familia || "sans-serif";
}

async function aplicarImagen(imagen: SceneImage, args: Record<string, unknown>): Promise<void> {
  const ruta = strOf(args, "ruta");
  const dataUrl = strOf(args, "dataUrl");
  if (ruta !== undefined && dataUrl !== undefined) {
    throw new Error("Pon «ruta» o «dataUrl», no las dos.");
  }
  if (ruta !== undefined || dataUrl !== undefined) {
    const fuente = ruta !== undefined ? await imagenDeFichero(ruta) : imagenDeDataUrl(dataUrl ?? "");
    imagen.src = fuente.src;
    // Sin tamaño explícito manda el de la imagen, no el de la anterior.
    if (fuente.w) imagen.w = fuente.w;
    if (fuente.h) imagen.h = fuente.h;
  }
  const x = numOf(args, "x", -MAX_COORD, MAX_COORD);
  if (x !== undefined) imagen.x = x;
  const y = numOf(args, "y", -MAX_COORD, MAX_COORD);
  if (y !== undefined) imagen.y = y;
  const ancho = numOf(args, "ancho", 1, MAX_COORD);
  if (ancho !== undefined) imagen.w = ancho;
  const alto = numOf(args, "alto", 1, MAX_COORD);
  if (alto !== undefined) imagen.h = alto;
  const giro = numOf(args, "giro", -Math.PI * 4, Math.PI * 4);
  if (giro !== undefined) imagen.rot = giro;
}

// ── Interfaces (capa `ui`) ─────────────────────────────────

/** ¿Lo recibido es la capa INTERFACES? Solo `{ nodes: [...] }`: el resumen de `pizarra_leer` no vale. */
function esCapaUi(raw: unknown): raw is { nodes: unknown[] } {
  return isRecord(raw) && Array.isArray(raw.nodes);
}

/** Lista del argumento (`items`, `options` o `checked`), validada; `undefined` si no llega. */
function listaDe(
  args: Record<string, unknown>,
  key: string,
  indice = false,
): string[] | number[] | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const vale = (valor: unknown): boolean =>
    indice ? typeof valor === "number" && Number.isFinite(valor) : typeof valor === "string";
  if (!Array.isArray(raw) || !raw.every(vale)) {
    throw new Error(`«${key}» tiene que ser una lista de ${indice ? "índices" : "textos"}.`);
  }
  return raw as string[] | number[];
}

/** `parent` del argumento: id de un widget que exista, `null` para la raíz, `undefined` si no llega. */
function padreOf(
  args: Record<string, unknown>,
  ids: Set<string>,
  propio?: string,
): string | null | undefined {
  const raw = args.parent;
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string" || !raw) {
    throw new Error("«parent» tiene que ser el id de otro widget, o null para la raíz.");
  }
  if (raw === propio) {
    throw new Error(`«parent» no puede ser el propio widget "${propio}".`);
  }
  if (!ids.has(raw)) {
    throw new Error(
      `«parent» apunta al widget "${raw}", que no existe: pizarra_ui_leer devuelve los ids.`,
    );
  }
  return raw;
}

/** Campos de contenido de un widget; `sanitizeUi` recorta lo que se pase de largo. */
function aplicarContenido(nodo: UiNode, args: Record<string, unknown>): void {
  const title = strOf(args, "title");
  if (title !== undefined) nodo.title = title;
  const text = strOf(args, "text");
  if (text !== undefined) nodo.text = text;
  const placeholder = strOf(args, "placeholder");
  if (placeholder !== undefined) nodo.placeholder = placeholder;
  const items = listaDe(args, "items");
  if (items) nodo.items = items as string[];
  const active = numOf(args, "active", -1, MAX_UI_ITEMS);
  if (active !== undefined) nodo.active = Math.round(active);
  const options = listaDe(args, "options");
  if (options) nodo.options = options as string[];
  const checked = listaDe(args, "checked", true);
  if (checked) nodo.checked = checked as number[];
  const variant = strOf(args, "variant");
  if (variant !== undefined) nodo.variant = variant;
  const align = enumOf(args, "align", ALIGNS);
  if (align !== undefined) nodo.align = align;
  const icon = strOf(args, "icon");
  if (icon !== undefined) nodo.icon = icon;
  const src = strOf(args, "src");
  if (src !== undefined) {
    if (src && (!DATA_IMAGE.test(src) || src.length > MAX_IMAGE_CHARS)) {
      throw new Error(
        '«src» tiene que ser una imagen png, jpeg, webp o gif en base64 de menos de 6 MB, o "".',
      );
    }
    nodo.src = src;
  }
  const disabled = boolOf(args, "disabled");
  if (disabled !== undefined) nodo.disabled = disabled;
}

/**
 * Caja absoluta de cada widget: su `x`/`y` más la caja útil (`uiContent`) de sus ancestros.
 * `rama` corta un ciclo: la escena guardada viene saneada, pero aquí no se fía de ella.
 */
function cajasAbsolutas(nodos: UiNode[]): Map<string, { x: number; y: number }> {
  const porId = new Map(nodos.map((nodo) => [nodo.id, nodo]));
  const cajas = new Map<string, { x: number; y: number }>();
  const calcular = (nodo: UiNode, rama: Set<string>): { x: number; y: number } => {
    const hecha = cajas.get(nodo.id);
    if (hecha) {
      return hecha;
    }
    let caja = { x: nodo.x, y: nodo.y };
    const padre = nodo.parent === null ? undefined : porId.get(nodo.parent);
    if (padre && !rama.has(padre.id)) {
      rama.add(nodo.id);
      const base = calcular(padre, rama);
      const util = uiContent(padre);
      caja = { x: base.x + util.dx + nodo.x, y: base.y + util.dy + nodo.y };
    }
    cajas.set(nodo.id, caja);
    return caja;
  };
  for (const nodo of nodos) {
    calcular(nodo, new Set());
  }
  return cajas;
}

/** Recuento por tipo de widget, sin volcar el árbol. */
function recuentoUi(ui: Ui): { total: number; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {};
  for (const nodo of ui.nodes) {
    kinds[nodo.kind] = (kinds[nodo.kind] ?? 0) + 1;
  }
  return { total: ui.nodes.length, kinds };
}

/** Vista de la capa INTERFACES para el agente: el árbol entero, con ids y caja absoluta. */
function vistaUi(scene: Scene) {
  const cajas = cajasAbsolutas(scene.ui.nodes);
  return {
    lienzo: { ancho: scene.canvas.w, alto: scene.canvas.h },
    capa: scene.layers.ui,
    total: scene.ui.nodes.length,
    nodos: scene.ui.nodes.map((nodo) => ({ ...nodo, cajaAbsoluta: cajas.get(nodo.id) })),
  };
}

/** Guarda la escena y devuelve el árbol de la capa INTERFACES. */
async function saveUi(dir: string, scene: Scene, hecho: string): Promise<string> {
  // Mismo techo de tamaño que el resto de escrituras (`saveScene`): el presupuesto cuenta
  // imágenes y textos de los widgets, y por encima de él el panel descartaría la pizarra entera.
  const saneada = sanitizeScene(scene);
  if (!saneada) {
    throw new Error(
      "La escena resultante se pasa del tope de tamaño: acorta los textos de los widgets o quita alguno.",
    );
  }
  await writeSceneFile(dir, saneada);
  return JSON.stringify({ hecho, ...vistaUi(saneada) });
}

// ── Herramientas ───────────────────────────────────────────

const CARPETA = {
  type: "string",
  description: "Carpeta de la pizarra. Por defecto, la del proyecto abierto.",
};
const ACCION = {
  type: "string",
  enum: ["crear", "editar", "borrar"],
  description: "Qué hacer con el elemento.",
};
const ID = { type: "string", description: "Id del elemento, tal como lo devuelve pizarra_leer." };
const OP = {
  type: "string",
  enum: ["alta", "editar", "borrar"],
  description: "Qué hacer con el widget.",
};
const X = { type: "number", description: "Coordenada x en píxeles, origen arriba a la izquierda." };
const Y = { type: "number", description: "Coordenada y en píxeles, origen arriba a la izquierda." };
const ANCHO = { type: "number", minimum: 1, description: "Ancho en píxeles." };
const ALTO = { type: "number", minimum: 1, description: "Alto en píxeles." };
const GIRO = { type: "number", description: "Giro en radianes." };
const INDICE = {
  type: "integer",
  minimum: 0,
  description: "Posición 0-based en la lista de pizarra_leer (estos elementos no tienen id).",
};

function color(description: string) {
  return { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description };
}

export const PIZARRA_TOOLS = [
  {
    name: "pizarra_leer",
    description:
      "Lee la pizarra del proyecto: lienzo, fondo, capas, nodos, aristas, textos e imágenes, con sus ids e índices, y la ruta del PNG. Léela antes de editar: los ids de nodos y aristas y los índices de textos e imágenes salen de aquí. Las imágenes vienen resumidas por tamaño y los trazos por número.",
    inputSchema: { type: "object", properties: { carpeta: CARPETA } },
  },
  {
    name: "pizarra_escribir",
    description:
      "Sustituye la pizarra entera por una escena completa (v, canvas, bg, flow, images, strokes, texts, layers), saneada. Sirve para restaurar o clonar una pizarra entera; en una que solo tenga el PNG aplanado, ese dibujo se pierde al reabrir. No vale lo que devuelve pizarra_leer: ese resumen omite las imágenes y los trazos. Para retocar lo leído, usa las demás herramientas. La capa INTERFACES (`ui`) se pasa como { nodes: [...] }; sin eso (el resumen { total, kinds } de pizarra_leer no vale) se conserva la que ya había. Para cambiar la capa, usa pizarra_ui_escribir.",
    inputSchema: {
      type: "object",
      properties: {
        escena: {
          type: "object",
          description: "Escena completa, con las imágenes en data URL.",
        },
        ui: {
          type: "object",
          description:
            "Capa INTERFACES ({ nodes: [...] }) que sustituye a la de la escena; sin un array de nodos se conserva la que ya había.",
        },
        carpeta: CARPETA,
      },
      required: ["escena"],
    },
  },
  {
    name: "pizarra_lienzo",
    description:
      "Ajusta el lienzo: tamaño, fondo, imagen de fondo, capas visibles o limpieza de una capa. Solo cambia lo que llegue.",
    inputSchema: {
      type: "object",
      properties: {
        ancho: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CANVAS_SIDE,
          description: "Ancho del lienzo; va con «alto» y fija el lienzo.",
        },
        alto: {
          type: "integer",
          minimum: 1,
          maximum: MAX_CANVAS_SIDE,
          description: "Alto del lienzo; va con «ancho» y fija el lienzo.",
        },
        fijo: { type: "boolean", description: "Lienzo de tamaño fijo (true) o elástico (false)." },
        fondo: color("Color de fondo."),
        imagenFondo: {
          type: ["string", "null"],
          description: "Ruta local o data URL de la imagen de fondo; null la quita.",
        },
        capas: {
          type: "object",
          description: "Visibilidad de las capas; solo se tocan las que lleguen.",
          properties: {
            flow: { type: "boolean", description: "Capa de diagrama (nodos y aristas)." },
            images: { type: "boolean" },
            strokes: { type: "boolean" },
            texts: { type: "boolean" },
          },
        },
        limpiar: {
          type: "string",
          enum: ["nodos", "aristas", "imagenes", "trazos", "textos", "todo"],
          description: "Borra una capa entera. «nodos» se lleva también sus aristas.",
        },
        carpeta: CARPETA,
      },
    },
  },
  {
    name: "pizarra_nodo",
    description:
      "Crea, edita o borra un nodo del diagrama. Al borrar se llevan por delante las aristas que lo tocan.",
    inputSchema: {
      type: "object",
      properties: {
        accion: ACCION,
        id: ID,
        forma: { type: "string", enum: SHAPES, description: "Forma del nodo; al crear, round." },
        x: X,
        y: Y,
        ancho: ANCHO,
        alto: ALTO,
        texto: { type: "string", description: "Etiqueta del nodo." },
        relleno: { type: "string", description: 'Color de relleno #rrggbb o "none".' },
        borde: color("Color del borde."),
        colorTexto: { type: "string", description: 'Color del texto #rrggbb o "auto".' },
        tamanoTexto: {
          type: "number",
          minimum: 6,
          maximum: 300,
          description: "Tamaño de la letra en píxeles.",
        },
        peso: { type: "integer", enum: [400, 600, 700], description: "Grosor de la letra." },
        alinear: { type: "string", enum: ALIGNS, description: "Alineación del texto." },
        icono: {
          type: "string",
          enum: ICONS,
          description: 'Icono del nodo; solo se pinta con forma "icon".',
        },
        colorIcono: color("Color del icono."),
        carpeta: CARPETA,
      },
      required: ["accion"],
    },
  },
  {
    name: "pizarra_arista",
    description:
      "Crea, edita o borra una arista que une dos nodos, o un nodo con un punto suelto. Los nodos de sus extremos tienen que existir.",
    inputSchema: {
      type: "object",
      properties: {
        accion: ACCION,
        id: ID,
        desde: {
          type: "object",
          description: "Extremo de salida: { nodo, lado } o { x, y }.",
          properties: {
            nodo: { type: "string", description: "Id del nodo del extremo." },
            lado: {
              type: "string",
              enum: SIDES,
              description: "Lado por el que sale; auto lo calcula.",
            },
            x: X,
            y: Y,
          },
        },
        hasta: {
          type: "object",
          description: "Extremo de llegada: { nodo, lado } o { x, y }.",
          properties: {
            nodo: { type: "string" },
            lado: { type: "string", enum: SIDES },
            x: X,
            y: Y,
          },
        },
        etiqueta: { type: "string", description: "Texto sobre la línea." },
        color: color("Color de la línea; al crear, #3d5566."),
        grosor: {
          type: "number",
          minimum: 0.5,
          maximum: 20,
          description: "Grosor de la línea; al crear, 2.",
        },
        discontinua: { type: "boolean", description: "Línea de puntos." },
        flechaInicio: { type: "boolean", description: "Flecha en el extremo de salida." },
        flechaFin: { type: "boolean", description: "Flecha en el extremo de llegada; al crear, true." },
        codos: {
          type: "array",
          description: "Codos de la ruta, en orden; se arrastran a mano en el panel.",
          items: { type: "object", properties: { x: X, y: Y }, required: ["x", "y"] },
        },
        carpeta: CARPETA,
      },
      required: ["accion"],
    },
  },
  {
    name: "pizarra_texto",
    description:
      "Crea, edita o borra un texto suelto. Los textos no tienen id: se nombran por su índice en la lista de pizarra_leer, y al borrar los siguientes bajan uno.",
    inputSchema: {
      type: "object",
      properties: {
        accion: ACCION,
        indice: INDICE,
        texto: { type: "string", description: "Contenido; obligatorio al crear." },
        x: X,
        y: Y,
        ancho: ANCHO,
        alto: ALTO,
        giro: GIRO,
        color: color("Color del texto; al crear, #000000."),
        tamano: {
          type: "number",
          minimum: 6,
          maximum: 300,
          description: "Tamaño de la letra; al crear, 24.",
        },
        familia: { type: "string", description: "Familia tipográfica." },
        carpeta: CARPETA,
      },
      required: ["accion"],
    },
  },
  {
    name: "pizarra_imagen",
    description:
      "Crea, edita o borra una imagen. Las imágenes no tienen id: se nombran por su índice en la lista de pizarra_leer. Al crear, sin tamaño explícito se usa el de la cabecera PNG (480×320 si no es PNG).",
    inputSchema: {
      type: "object",
      properties: {
        accion: ACCION,
        indice: INDICE,
        ruta: {
          type: "string",
          description:
            "Fichero local png, jpg, jpeg, webp o gif; absoluta o relativa al directorio actual.",
        },
        dataUrl: {
          type: "string",
          description: "La imagen ya embebida en base64, máximo 6 MB.",
        },
        x: X,
        y: Y,
        ancho: ANCHO,
        alto: ALTO,
        giro: GIRO,
        carpeta: CARPETA,
      },
      required: ["accion"],
    },
  },
  {
    name: "pizarra_ui_leer",
    description:
      "Lee la capa INTERFACES de la pizarra: el árbol de widgets con sus ids, sus campos y la caja absoluta de cada uno (x, y sumando los ancestros). Léela antes de editar: los ids salen de aquí.",
    inputSchema: { type: "object", properties: { carpeta: CARPETA } },
  },
  {
    name: "pizarra_ui_escribir",
    description:
      "Sustituye la capa INTERFACES entera por una lista de widgets, saneada, y deja el resto de la escena como estaba. La pizarra no puede quedarse solo con el PNG aplanado: en ese caso, ábrela una vez en el panel para que se guarde su escena. Para añadir o retocar un widget suelto, usa pizarra_ui_nodo.",
    inputSchema: {
      type: "object",
      properties: {
        nodos: {
          type: "array",
          description:
            "Árbol completo de widgets; el orden es el z-order. Cada uno lleva id, kind, parent, x, y, w, h y sus campos.",
          items: {
            type: "object",
            description:
              "Widget: id, kind, parent (id o null), x, y, w, h (x e y relativos a la caja útil del padre), title, text, placeholder, items, active, options, checked, variant, align, icon, src, disabled.",
          },
        },
        carpeta: CARPETA,
      },
      required: ["nodos"],
    },
  },
  {
    name: "pizarra_ui_nodo",
    description:
      "Da de alta, edita o borra un widget de la capa INTERFACES. Al dar de alta sin x/y se apila debajo de los hijos que ya tenga su padre; al borrar se lleva por delante sus descendientes. Devuelve el árbol resultante, igual que pizarra_ui_leer.",
    inputSchema: {
      type: "object",
      properties: {
        op: OP,
        id: {
          type: "string",
          description: "Id del widget, tal como lo devuelve pizarra_ui_leer.",
        },
        kind: {
          type: "string",
          enum: UI_KINDS,
          description: "Tipo de widget; obligatorio al dar de alta.",
        },
        parent: {
          type: ["string", "null"],
          description: "Id del widget que lo contiene, o null para la raíz.",
        },
        x: { type: "number", description: "Coordenada x relativa a la caja útil del padre." },
        y: { type: "number", description: "Coordenada y relativa a la caja útil del padre." },
        w: ANCHO,
        h: ALTO,
        title: { type: "string", description: "Título: barra de la ventana, pestaña, fila…" },
        text: { type: "string", description: "Texto del widget (etiqueta, contenido, botón)." },
        placeholder: { type: "string", description: "Texto de ayuda de input y textarea." },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Pestañas, filas o entradas del widget.",
        },
        active: {
          type: "integer",
          description: "Pestaña, fila o entrada resaltada; -1 es ninguna.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Opciones de un choice.",
        },
        checked: {
          type: "array",
          items: { type: "integer" },
          description: "Índices marcados de un choice.",
        },
        variant: {
          type: "string",
          description: 'Estilo de un choice ("check", "radio") o de un button ("primary", "secondary").',
        },
        align: { type: "string", enum: ALIGNS, description: "Alineación del texto." },
        icon: { type: "string", description: "Nombre del icono del widget." },
        src: { type: "string", description: 'Imagen del widget en data URL, o "" sin imagen.' },
        disabled: { type: "boolean", description: "Widget apagado." },
        carpeta: CARPETA,
      },
      required: ["op"],
    },
  },
];

// ── Llamadas ───────────────────────────────────────────────

async function pizarraLeer(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  // Leer no se niega aunque no haya escena: se dice lo que hay y por qué no se puede editar.
  const guardada = await readSceneFile(dir);
  const png = join(dir, WORK_FILE);
  const hayPng = await existe(png);
  return JSON.stringify({
    archivo: join(dir, SCENE_FILE),
    png: hayPng ? png : null,
    ...(guardada || !hayPng
      ? {}
      : {
          aviso:
            "Solo queda el PNG aplanado, sin escena: ábrela una vez en el panel para poder editarla.",
        }),
    ...vistaEscena(guardada ?? emptyScene()),
  });
}

async function pizarraEscribir(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  if (!isRecord(args.escena)) {
    throw new Error("«escena» tiene que ser el objeto de la escena completa.");
  }
  const escena: Record<string, unknown> = { ...args.escena };
  if (esCapaUi(args.ui)) {
    escena.ui = args.ui;
  }
  if (!esCapaUi(escena.ui)) {
    // Colar el resumen de `pizarra_leer` (`ui: { total, kinds }`) vaciaba la capa en silencio, y
    // reconstruir la escena sin `ui` también: sin un `{ nodes: [...] }` de verdad, se queda la
    // que ya había en disco.
    const actual = await readSceneFile(dir);
    if (actual) {
      escena.ui = actual.ui;
    }
  }
  return saveScene(dir, escena, "Pizarra escrita.");
}

async function pizarraLienzo(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);

  const ancho = numOf(args, "ancho", 1, MAX_CANVAS_SIDE);
  const alto = numOf(args, "alto", 1, MAX_CANVAS_SIDE);
  if ((ancho === undefined) !== (alto === undefined)) {
    throw new Error("«ancho» y «alto» van juntos: cambian el lienzo y lo fijan.");
  }
  if (ancho !== undefined && alto !== undefined) {
    scene.canvas.w = Math.round(ancho);
    scene.canvas.h = Math.round(alto);
    scene.canvas.fixed = true;
  }
  const fijo = boolOf(args, "fijo");
  if (fijo !== undefined) scene.canvas.fixed = fijo;

  const fondo = hexOf(args, "fondo");
  if (fondo !== undefined) scene.bg.color = fondo;

  if ("imagenFondo" in args) {
    const raw = args.imagenFondo;
    if (raw === null) {
      scene.bg.image = null;
    } else if (typeof raw === "string" && raw) {
      scene.bg.image = DATA_IMAGE.test(raw)
        ? imagenDeDataUrl(raw).src
        : (await imagenDeFichero(raw)).src;
    } else {
      throw new Error("«imagenFondo» tiene que ser una ruta, una data URL o null.");
    }
  }

  if (isRecord(args.capas)) {
    for (const capa of ["flow", "images", "strokes", "texts"] as const) {
      const valor = args.capas[capa];
      if (typeof valor === "boolean") scene.layers[capa] = valor;
    }
  }

  const limpiar = enumOf(args, "limpiar", [
    "nodos",
    "aristas",
    "imagenes",
    "trazos",
    "textos",
    "todo",
  ]);
  if (limpiar === "nodos" || limpiar === "todo") {
    // Sin nodos no hay a quién unir las aristas: se van con ellos.
    scene.flow.nodes = [];
    scene.flow.edges = [];
  }
  if (limpiar === "aristas") scene.flow.edges = [];
  if (limpiar === "imagenes" || limpiar === "todo") scene.images = [];
  if (limpiar === "trazos" || limpiar === "todo") scene.strokes = [];
  if (limpiar === "textos" || limpiar === "todo") scene.texts = [];

  return saveScene(dir, scene, "Lienzo actualizado.");
}

async function pizarraNodo(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);
  const accion = accionOf(args);
  const nodes = scene.flow.nodes;

  if (accion === "crear") {
    const x = numOf(args, "x", -MAX_COORD, MAX_COORD);
    const y = numOf(args, "y", -MAX_COORD, MAX_COORD);
    const nodo: SceneNode = {
      id: idNuevo("n", new Set(nodes.map((n) => n.id))),
      shape: "round",
      x: x ?? (nodes.length ? Math.max(...nodes.map((n) => n.x + n.w)) + 80 : 60),
      y: y ?? 60,
      w: 200,
      h: 90,
      text: "",
      fill: "#ffffff",
      stroke: "#5b7385",
      textColor: "auto",
      fontSize: 16,
      weight: 400,
      align: "center",
      icon: "",
      iconColor: "#14232b",
    };
    aplicarNodo(nodo, args);
    nodes.push(nodo);
    return saveScene(dir, scene, `Nodo "${nodo.id}" creado en ${nodo.x}, ${nodo.y}.`);
  }

  const id = strOf(args, "id");
  const nodo = id === undefined ? undefined : nodes.find((n) => n.id === id);
  if (!nodo) {
    throw new Error(`No hay ningún nodo con id "${id ?? ""}": pizarra_leer devuelve los ids.`);
  }

  if (accion === "borrar") {
    scene.flow.nodes = nodes.filter((n) => n !== nodo);
    const antes = scene.flow.edges.length;
    scene.flow.edges = scene.flow.edges.filter((e) => !tocaNodo(e, nodo.id));
    const fuera = antes - scene.flow.edges.length;
    return saveScene(
      dir,
      scene,
      `Nodo "${nodo.id}" borrado${fuera ? `, y con él ${cuenta(fuera, "arista", "aristas")}` : ""}.`,
    );
  }

  aplicarNodo(nodo, args);
  return saveScene(dir, scene, `Nodo "${nodo.id}" actualizado en ${nodo.x}, ${nodo.y}.`);
}

async function pizarraArista(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);
  const accion = accionOf(args);
  const ids = new Set(scene.flow.nodes.map((n) => n.id));
  const edges = scene.flow.edges;

  if (accion === "crear") {
    if (!isRecord(args.desde) || !isRecord(args.hasta)) {
      throw new Error("Para crear una arista hacen falta «desde» y «hasta».");
    }
    const arista: SceneEdge = {
      id: idNuevo("e", new Set(edges.map((e) => e.id))),
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      label: "",
      color: "#3d5566",
      width: 2,
      dash: false,
      startArrow: false,
      endArrow: true,
      waypoints: [],
      labelOffset: { dx: 0, dy: 0 },
    };
    aplicarArista(arista, args, ids);
    edges.push(arista);
    return saveScene(dir, scene, `Arista "${arista.id}" creada.`);
  }

  const id = strOf(args, "id");
  const arista = id === undefined ? undefined : edges.find((e) => e.id === id);
  if (!arista) {
    throw new Error(`No hay ninguna arista con id "${id ?? ""}": pizarra_leer devuelve los ids.`);
  }

  if (accion === "borrar") {
    scene.flow.edges = edges.filter((e) => e !== arista);
    return saveScene(dir, scene, `Arista "${arista.id}" borrada.`);
  }

  aplicarArista(arista, args, ids);
  return saveScene(dir, scene, `Arista "${arista.id}" actualizada.`);
}

async function pizarraTexto(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);
  const textos = scene.texts;
  const accion = accionOf(args);

  if (accion === "crear") {
    if (!strOf(args, "texto")) {
      throw new Error("Hace falta «texto» para crear un texto.");
    }
    const nuevo: SceneText = {
      text: "",
      x: 80,
      y: 80,
      w: 360,
      h: 48,
      rot: 0,
      color: "#000000",
      size: 24,
      family: "sans-serif",
    };
    aplicarTexto(nuevo, args);
    textos.push(nuevo);
    return saveScene(
      dir,
      scene,
      `Texto creado en el índice ${textos.length - 1} («${recorte(nuevo.text)}»).`,
    );
  }

  const indice = indiceDe(args, textos.length);
  if (accion === "borrar") {
    const [fuera] = textos.splice(indice, 1);
    return saveScene(
      dir,
      scene,
      `Texto del índice ${indice} borrado («${recorte(fuera.text)}»); los siguientes bajan uno.`,
    );
  }

  aplicarTexto(textos[indice], args);
  return saveScene(dir, scene, `Texto del índice ${indice} actualizado.`);
}

async function pizarraImagen(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);
  const imagenes = scene.images;
  const accion = accionOf(args);

  if (accion === "crear") {
    if (strOf(args, "ruta") === undefined && strOf(args, "dataUrl") === undefined) {
      throw new Error("Para crear una imagen hace falta «ruta» o «dataUrl».");
    }
    const nueva: SceneImage = { src: "", x: 80, y: 80, w: 480, h: 320, rot: 0 };
    await aplicarImagen(nueva, args);
    imagenes.push(nueva);
    return saveScene(
      dir,
      scene,
      `Imagen creada en el índice ${imagenes.length - 1} (${nueva.w}×${nueva.h}).`,
    );
  }

  const indice = indiceDe(args, imagenes.length);
  if (accion === "borrar") {
    imagenes.splice(indice, 1);
    return saveScene(dir, scene, `Imagen del índice ${indice} borrada; las siguientes bajan uno.`);
  }

  await aplicarImagen(imagenes[indice], args);
  return saveScene(dir, scene, `Imagen del índice ${indice} actualizada.`);
}

async function pizarraUiLeer(args: Record<string, unknown>): Promise<string> {
  const scene = await loadScene(pizarraDir(args));
  return JSON.stringify(vistaUi(scene));
}

async function pizarraUiEscribir(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);
  if (!Array.isArray(args.nodos)) {
    throw new Error("«nodos» tiene que ser la lista de widgets del árbol.");
  }
  scene.ui = sanitizeUi({ nodes: args.nodos });
  const fuera = args.nodos.length - scene.ui.nodes.length;
  return saveUi(
    dir,
    scene,
    fuera
      ? `Interfaces escritas, pero ${cuenta(fuera, "widget se descartó", "widgets se descartaron")} por el saneado.`
      : `Interfaces escritas: ${cuenta(scene.ui.nodes.length, "widget", "widgets")}.`,
  );
}

/** Un widget de la capa INTERFACES: alta (apilada bajo los hijos del padre), edición o borrado. */
async function pizarraUiNodo(args: Record<string, unknown>): Promise<string> {
  const dir = pizarraDir(args);
  const scene = await loadScene(dir);
  const op = enumOf(args, "op", ["alta", "editar", "borrar"]);
  if (!op) {
    throw new Error("Falta «op»: alta, editar o borrar.");
  }
  const nodos = scene.ui.nodes;
  const ids = new Set(nodos.map((nodo) => nodo.id));

  if (op === "alta") {
    if (nodos.length >= MAX_UI_NODES) {
      throw new Error(
        `La capa INTERFACES ya tiene el tope de ${MAX_UI_NODES} widgets: borra alguno antes de dar de alta otro.`,
      );
    }
    const kind = enumOf(args, "kind", UI_KINDS);
    if (!kind) {
      throw new Error(`Para dar de alta un widget hace falta «kind»: ${UI_KINDS.join(", ")}.`);
    }
    const dado = strOf(args, "id");
    if (dado !== undefined && ids.has(dado)) {
      throw new Error(`Ya hay un widget con id "${dado}".`);
    }
    const id = dado ?? idNuevo("u", ids);
    const parent = padreOf(args, ids) ?? null;
    // Apilado: debajo de los hijos que ya tenga el padre, 8 px de aire. Sus coordenadas van
    // relativas a la caja útil del padre (`uiContent`), así que su chrome no entra aquí.
    const hermanos = nodos.filter((nodo) => nodo.parent === parent);
    const tamano = uiDefaults(kind);
    const nodo: UiNode = {
      id,
      kind,
      parent,
      x: numOf(args, "x", -MAX_COORD, MAX_COORD) ?? (hermanos.length ? hermanos[0].x : 0),
      y:
        numOf(args, "y", -MAX_COORD, MAX_COORD) ??
        (hermanos.length ? Math.max(...hermanos.map((hijo) => hijo.y + hijo.h)) + 8 : 0),
      w: numOf(args, "w", 1, MAX_COORD) ?? tamano.w,
      h: numOf(args, "h", 1, MAX_COORD) ?? tamano.h,
      title: "",
      text: "",
      placeholder: "",
      items: [],
      active: -1,
      options: [],
      checked: [],
      variant: "",
      align: "left",
      icon: "",
      src: "",
      disabled: false,
    };
    aplicarContenido(nodo, args);
    const saneada = sanitizeUi({ nodes: [...nodos, nodo] });
    if (saneada.nodes.length !== nodos.length + 1) {
      throw new Error(
        "El widget no pasa el saneado: «id» admite letras, números, «_» y «-», hasta 32.",
      );
    }
    scene.ui = saneada;
    return saveUi(dir, scene, `Widget "${id}" (${kind}) creado en ${nodo.x}, ${nodo.y}.`);
  }

  const id = strOf(args, "id");
  const actual = id === undefined ? undefined : nodos.find((nodo) => nodo.id === id);
  if (!actual) {
    throw new Error(`No hay ningún widget con id "${id ?? ""}": pizarra_ui_leer devuelve los ids.`);
  }

  if (op === "borrar") {
    const fuera = new Set([actual.id]);
    // Los descendientes caen con él: se cierra el conjunto hasta que deje de crecer.
    for (let antes = 0; antes !== fuera.size; ) {
      antes = fuera.size;
      for (const nodo of nodos) {
        if (nodo.parent !== null && fuera.has(nodo.parent)) {
          fuera.add(nodo.id);
        }
      }
    }
    scene.ui = sanitizeUi({ nodes: nodos.filter((nodo) => !fuera.has(nodo.id)) });
    const resto = fuera.size - 1;
    return saveUi(
      dir,
      scene,
      `Widget "${actual.id}" borrado${resto ? `, y con él ${cuenta(resto, "descendiente", "descendientes")}` : ""}.`,
    );
  }

  const nuevo: UiNode = { ...actual };
  const kind = enumOf(args, "kind", UI_KINDS);
  if (kind !== undefined) nuevo.kind = kind;
  const parent = padreOf(args, ids, actual.id);
  if (parent !== undefined) {
    // El árbol no puede cerrarse en ciclo: subiendo desde el nuevo padre no se puede llegar a él.
    for (let sube: string | null = parent, pasos = 0; sube && pasos <= nodos.length; pasos += 1) {
      if (sube === actual.id) {
        throw new Error(`«parent» crearía un ciclo: "${parent}" ya cuelga de "${actual.id}".`);
      }
      sube = nodos.find((nodo) => nodo.id === sube)?.parent ?? null;
    }
    nuevo.parent = parent;
  }
  const x = numOf(args, "x", -MAX_COORD, MAX_COORD);
  if (x !== undefined) nuevo.x = x;
  const y = numOf(args, "y", -MAX_COORD, MAX_COORD);
  if (y !== undefined) nuevo.y = y;
  const w = numOf(args, "w", 1, MAX_COORD);
  if (w !== undefined) nuevo.w = w;
  const h = numOf(args, "h", 1, MAX_COORD);
  if (h !== undefined) nuevo.h = h;
  aplicarContenido(nuevo, args);
  const saneada = sanitizeUi({
    nodes: nodos.map((nodo) => (nodo === actual ? nuevo : nodo)),
  });
  if (!saneada.nodes.some((nodo) => nodo.id === actual.id)) {
    throw new Error(`El widget "${actual.id}" no pasa el saneado con esos campos.`);
  }
  scene.ui = saneada;
  return saveUi(dir, scene, `Widget "${actual.id}" actualizado en ${nuevo.x}, ${nuevo.y}.`);
}

const PIZARRA_CALLS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  pizarra_leer: pizarraLeer,
  pizarra_escribir: pizarraEscribir,
  pizarra_lienzo: pizarraLienzo,
  pizarra_nodo: pizarraNodo,
  pizarra_arista: pizarraArista,
  pizarra_texto: pizarraTexto,
  pizarra_imagen: pizarraImagen,
  pizarra_ui_leer: pizarraUiLeer,
  pizarra_ui_escribir: pizarraUiEscribir,
  pizarra_ui_nodo: pizarraUiNodo,
};

/** Ejecuta una herramienta de pizarra; `undefined` si el nombre no es suyo. */
export async function callPizarraTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const call = PIZARRA_CALLS[name];
  return call ? call(args) : undefined;
}
