/**
 * Escena editable de la pizarra (contrato v1): tipos, topes y saneado.
 *
 * Vive fuera de `panels/` porque la comparten el panel y el servidor MCP: aquí no entra
 * nada de la API de VS Code. El webview manda su estado entero en cada `snapshot`; entra por
 * `sanitizeScene` y de ahí sale lo que se escribe en disco y lo que se le devuelve en `init`.
 */

import { emptyUi, sanitizeUi, Ui } from "./ui";

/** Tope de la escena: texto JSON, con las imágenes ya embebidas en base64. Va por debajo del que corta el webview (`MAX_ESCENA` en `media/pizarra.js`): si el host acepta lo que la webview rechaza, el `snapshot` llega con `scene: null` y el panel borra la escena. */
export const MAX_SCENE_BYTES = 7_500_000;

/** Topes de la escena. Se descartan elementos uno a uno; la escena solo se rechaza entera por raíz, `v`, fondo ilegible o tamaño. */
const MAX_NODES = 1500;
const MAX_EDGES = 3000;
const MAX_IMAGES = 40;
const MAX_STROKES = 5000;
const MAX_TEXTS = 2000;
const MAX_STROKE_POINTS = 200000;
/** Cadena de una data URL de imagen (fondo o capa): son 6 MB de texto, no de binario. */
export const MAX_IMAGE_CHARS = 6 * 1024 * 1024;
const MAX_NODE_TEXT = 4000;
const MAX_EDGE_LABEL = 500;
const MAX_FAMILY_CHARS = 120;
const MAX_WAYPOINTS = 50;
export const MAX_COORD = 100000;
export const MAX_CANVAS_SIDE = 4096;
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const NODE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const ICON_NAME = /^[a-z-]{0,20}$/;
export const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,/;
export const SHAPES: readonly string[] = ["rect", "round", "stadium", "diamond", "ellipse", "icon"];
export const SIDES: readonly string[] = ["auto", "t", "r", "b", "l"];
export const ALIGNS: readonly string[] = ["left", "center", "right"];

export interface SceneNode {
  id: string;
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fill: string;
  stroke: string;
  textColor: string;
  fontSize: number;
  weight: number;
  align: string;
  icon: string;
  iconColor: string;
}

/** Extremo de arista: o el lado de un nodo, o un punto suelto. */
export interface EndpointNode {
  node: string;
  side: string;
}

export interface EndpointPoint {
  x: number;
  y: number;
}

export type SceneEndpoint = EndpointNode | EndpointPoint;

export interface SceneEdge {
  id: string;
  from: SceneEndpoint;
  to: SceneEndpoint;
  label: string;
  color: string;
  width: number;
  dash: boolean;
  startArrow: boolean;
  endArrow: boolean;
  waypoints: EndpointPoint[];
  labelOffset: { dx: number; dy: number };
}

export interface SceneImage {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export interface SceneStroke {
  erase: boolean;
  color: string;
  size: number;
  /** Dureza del borrador, 0..0.95 (el borde del sello). */
  hard: number;
  pts: [number, number][];
}

export interface SceneText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  color: string;
  size: number;
  family: string;
}

export interface Scene {
  v: 1;
  canvas: { w: number; h: number; fixed: boolean };
  bg: { color: string; image: string | null };
  flow: { nodes: SceneNode[]; edges: SceneEdge[] };
  images: SceneImage[];
  strokes: SceneStroke[];
  texts: SceneText[];
  /** Capa INTERFACES: wireframes como árbol de widgets (ver `ui.ts`). */
  ui: Ui;
  layers: { flow: boolean; images: boolean; strokes: boolean; texts: boolean; ui: boolean };
}

/** Escena vacía para una pizarra que aún no existe: lienzo fijo y coordenadas estables. */
export function emptyScene(): Scene {
  return {
    v: 1,
    canvas: { w: 1600, h: 1024, fixed: true },
    bg: { color: "#ffffff", image: null },
    flow: { nodes: [], edges: [] },
    images: [],
    strokes: [],
    texts: [],
    ui: emptyUi(),
    layers: { flow: true, images: true, strokes: true, texts: true, ui: true },
  };
}

export function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** Número acotado; si no es finito, el valor por defecto. */
function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

/** Número acotado obligatorio: sin él el elemento se descarta. */
function reqNum(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, raw));
}

/** Lado del lienzo: entero 1..4096 o nada. Aquí no se recorta: de él depende la escena entera. */
function canvasSide(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const lado = Math.round(raw);
  return lado >= 1 && lado <= MAX_CANVAS_SIDE ? lado : undefined;
}

function clipText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.slice(0, max) : "";
}

function pick(raw: unknown, options: readonly string[], fallback: string): string {
  return typeof raw === "string" && options.includes(raw) ? raw : fallback;
}

/** Booleano solo si llega como tal; cualquier otra cosa vale el valor por defecto. */
function boolFlag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Color de relleno: hex o `"none"`. */
function fillColor(raw: unknown): string {
  if (raw === "none") {
    return "none";
  }
  return typeof raw === "string" && HEX_COLOR.test(raw) ? raw.toLowerCase() : "#ffffff";
}

/** Color de texto: hex o `"auto"`. */
function textColorOf(raw: unknown): string {
  if (raw === "auto") {
    return "auto";
  }
  return typeof raw === "string" && HEX_COLOR.test(raw) ? raw.toLowerCase() : "#ffffff";
}

function hexColor(raw: unknown, fallback = "#ffffff"): string {
  return typeof raw === "string" && HEX_COLOR.test(raw) ? raw.toLowerCase() : fallback;
}

/** Data URL de imagen: solo los tipos que el webview sabe pintar y con el tope del contrato. */
function dataImage(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length <= MAX_IMAGE_CHARS && DATA_IMAGE.test(raw) ? raw : undefined;
}

/** Id nuevo para su lista: válido y no repetido, o nada. */
function sceneId(raw: unknown, used: Set<string>): string | undefined {
  if (typeof raw !== "string" || !NODE_ID.test(raw) || used.has(raw)) {
    return undefined;
  }
  return raw;
}

function sanitizeNodes(raw: unknown): SceneNode[] {
  const items = Array.isArray(raw) ? raw.slice(0, MAX_NODES) : [];
  const used = new Set<string>();
  const nodes: SceneNode[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const id = sceneId(item.id, used);
    if (!id) {
      continue;
    }
    const x = reqNum(item.x, -MAX_COORD, MAX_COORD);
    const y = reqNum(item.y, -MAX_COORD, MAX_COORD);
    const w = reqNum(item.w, 1, MAX_COORD);
    const h = reqNum(item.h, 1, MAX_COORD);
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      continue;
    }
    used.add(id);
    nodes.push({
      id,
      shape: pick(item.shape, SHAPES, "rect"),
      x,
      y,
      w,
      h,
      text: clipText(item.text, MAX_NODE_TEXT),
      fill: fillColor(item.fill),
      stroke: hexColor(item.stroke),
      textColor: textColorOf(item.textColor),
      fontSize: clampNum(item.fontSize, 6, 300, 16),
      weight: item.weight === 400 || item.weight === 600 || item.weight === 700 ? item.weight : 400,
      align: pick(item.align, ALIGNS, "left"),
      icon: typeof item.icon === "string" && ICON_NAME.test(item.icon) ? item.icon : "",
      iconColor: hexColor(item.iconColor),
    });
  }
  return nodes;
}

function sanitizeEndpoint(raw: unknown, nodeIds: Set<string>): SceneEndpoint | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (typeof raw.node === "string") {
    return nodeIds.has(raw.node) ? { node: raw.node, side: pick(raw.side, SIDES, "auto") } : undefined;
  }
  const x = reqNum(raw.x, -MAX_COORD, MAX_COORD);
  const y = reqNum(raw.y, -MAX_COORD, MAX_COORD);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function sanitizeEdges(raw: unknown, nodeIds: Set<string>): SceneEdge[] {
  const items = Array.isArray(raw) ? raw.slice(0, MAX_EDGES) : [];
  const used = new Set<string>();
  const edges: SceneEdge[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const id = sceneId(item.id, used);
    if (!id) {
      continue;
    }
    const from = sanitizeEndpoint(item.from, nodeIds);
    const to = sanitizeEndpoint(item.to, nodeIds);
    if (!from || !to) {
      continue;
    }
    const waypoints: EndpointPoint[] = [];
    if (Array.isArray(item.waypoints)) {
      for (const point of item.waypoints.slice(0, MAX_WAYPOINTS)) {
        if (!isRecord(point)) {
          continue;
        }
        const px = reqNum(point.x, -MAX_COORD, MAX_COORD);
        const py = reqNum(point.y, -MAX_COORD, MAX_COORD);
        if (px !== undefined && py !== undefined) {
          waypoints.push({ x: px, y: py });
        }
      }
    }
    const offset = isRecord(item.labelOffset) ? item.labelOffset : {};
    used.add(id);
    edges.push({
      id,
      from,
      to,
      label: clipText(item.label, MAX_EDGE_LABEL),
      color: hexColor(item.color),
      width: clampNum(item.width, 0.5, 20, 2),
      // `dash` es el check DISCONTINUA del panel: booleano, no un nombre de estilo.
      dash: boolFlag(item.dash, false),
      startArrow: boolFlag(item.startArrow, false),
      // Sin dato, flecha al final: es el defecto que pinta el webview.
      endArrow: boolFlag(item.endArrow, true),
      waypoints,
      labelOffset: {
        dx: clampNum(offset.dx, -MAX_COORD, MAX_COORD, 0),
        dy: clampNum(offset.dy, -MAX_COORD, MAX_COORD, 0),
      },
    });
  }
  return edges;
}

function sanitizeImages(raw: unknown): SceneImage[] {
  const items = Array.isArray(raw) ? raw.slice(0, MAX_IMAGES) : [];
  const images: SceneImage[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const src = dataImage(item.src);
    const x = reqNum(item.x, -MAX_COORD, MAX_COORD);
    const y = reqNum(item.y, -MAX_COORD, MAX_COORD);
    const w = reqNum(item.w, 1, MAX_COORD);
    const h = reqNum(item.h, 1, MAX_COORD);
    if (!src || x === undefined || y === undefined || w === undefined || h === undefined) {
      continue;
    }
    images.push({ src, x, y, w, h, rot: clampNum(item.rot, -Math.PI * 4, Math.PI * 4, 0) });
  }
  return images;
}

function sanitizeStrokes(raw: unknown): SceneStroke[] {
  const items = Array.isArray(raw) ? raw.slice(0, MAX_STROKES) : [];
  const strokes: SceneStroke[] = [];
  let puntos = 0;
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const pts: [number, number][] = [];
    if (Array.isArray(item.pts)) {
      for (const point of item.pts) {
        if (puntos >= MAX_STROKE_POINTS) {
          break;
        }
        if (!Array.isArray(point) || point.length < 2) {
          continue;
        }
        const x = reqNum(point[0], -MAX_COORD, MAX_COORD);
        const y = reqNum(point[1], -MAX_COORD, MAX_COORD);
        if (x === undefined || y === undefined) {
          continue;
        }
        pts.push([x, y]);
        puntos += 1;
      }
    }
    // Un trazo sin puntos no pinta nada.
    if (!pts.length) {
      continue;
    }
    strokes.push({
      erase: boolFlag(item.erase, false),
      color: hexColor(item.color),
      // `size` de trazo tampoco viene detallado: se acota al mismo rango útil del pincel.
      size: clampNum(item.size, 1, 200, 4),
      hard: clampNum(item.hard, 0, 1, 1),
      pts,
    });
  }
  return strokes;
}

function sanitizeTexts(raw: unknown): SceneText[] {
  const items = Array.isArray(raw) ? raw.slice(0, MAX_TEXTS) : [];
  const texts: SceneText[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const x = reqNum(item.x, -MAX_COORD, MAX_COORD);
    const y = reqNum(item.y, -MAX_COORD, MAX_COORD);
    const w = reqNum(item.w, 1, MAX_COORD);
    const h = reqNum(item.h, 1, MAX_COORD);
    const text = clipText(item.text, MAX_NODE_TEXT);
    if (!text || x === undefined || y === undefined || w === undefined || h === undefined) {
      continue;
    }
    texts.push({
      text,
      x,
      y,
      w,
      h,
      rot: clampNum(item.rot, -Math.PI * 4, Math.PI * 4, 0),
      color: hexColor(item.color),
      size: clampNum(item.size, 6, 300, 24),
      // Una familia vacía deja el `font` del lienzo sin familia y el texto sale a 10 px.
      family: clipText(item.family, MAX_FAMILY_CHARS) || "sans-serif",
    });
  }
  return texts;
}

/**
 * Escena del webview, saneada, o `undefined` si no vale. La raíz no es objeto, `v` no es 1,
 * falta un lienzo válido, el fondo no es una imagen legible o las imágenes pasan del tope:
 * ahí se rechaza entera (guardarla sin fondo sería perderlo en silencio). Lo demás se
 * descarta elemento a elemento.
 */
export function sanitizeScene(raw: unknown): Scene | undefined {
  if (!isRecord(raw) || raw.v !== 1) {
    return undefined;
  }
  const canvas = isRecord(raw.canvas) ? raw.canvas : undefined;
  const w = canvas ? canvasSide(canvas.w) : undefined;
  const h = canvas ? canvasSide(canvas.h) : undefined;
  if (!canvas || w === undefined || h === undefined) {
    return undefined;
  }
  const bg = isRecord(raw.bg) ? raw.bg : {};
  const flow = isRecord(raw.flow) ? raw.flow : {};
  const layers = isRecord(raw.layers) ? raw.layers : {};
  // Fondo: `null` es «sin imagen»; cualquier otra cosa tiene que ser una data URL de imagen.
  const bgImage = bg.image == null ? null : dataImage(bg.image);
  if (bgImage === undefined) {
    return undefined;
  }
  const nodes = sanitizeNodes(flow.nodes);
  const images = sanitizeImages(raw.images);
  // La capa INTERFACES no rechaza la escena entera: se sanea widget a widget.
  const ui = sanitizeUi(raw.ui);
  // Presupuesto de imágenes y textos, contado al vuelo: si no cabe, se corta aquí y no se
  // llega a montar la escena ni a medir el JSON entero.
  let chars = bgImage ? bgImage.length : 0;
  for (const image of images) {
    chars += image.src.length;
    if (chars > MAX_SCENE_BYTES) {
      return undefined;
    }
  }
  // Los textos y las imágenes de los widgets cuentan en el mismo presupuesto: 800 widgets con
  // textos largos también pasan del tope del webview, y ahí la escena se pierde entera.
  for (const widget of ui.nodes) {
    let largo =
      widget.src.length + widget.title.length + widget.text.length + widget.placeholder.length;
    for (const item of widget.items) {
      largo += item.length;
    }
    for (const option of widget.options) {
      largo += option.length;
    }
    chars += largo;
    if (chars > MAX_SCENE_BYTES) {
      return undefined;
    }
  }
  const scene: Scene = {
    v: 1,
    canvas: { w, h, fixed: boolFlag(canvas.fixed, false) },
    bg: { color: hexColor(bg.color, "#000000"), image: bgImage },
    flow: { nodes, edges: sanitizeEdges(flow.edges, new Set(nodes.map((node) => node.id))) },
    images,
    strokes: sanitizeStrokes(raw.strokes),
    texts: sanitizeTexts(raw.texts),
    ui,
    layers: {
      flow: boolFlag(layers.flow, true),
      images: boolFlag(layers.images, true),
      strokes: boolFlag(layers.strokes, true),
      texts: boolFlag(layers.texts, true),
      ui: boolFlag(layers.ui, true),
    },
  };
  return scene;
}
