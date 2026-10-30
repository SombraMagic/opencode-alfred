/**
 * Capa INTERFACES de la escena: wireframes de interfaz como árbol de widgets, no como dibujo.
 *
 * Cada widget es plano (posiciones relativas a la caja útil de su padre) y el árbol se
 * resuelve por `parent`; el orden del array es el z-order. Vive fuera de `scene.ts` porque
 * el saneado del árbol es lo bastante largo para tener su propio fichero, y aquí no entra
 * nada de la API de VS Code: esto lo comparten el panel y el servidor MCP.
 *
 * El import va en un solo sentido (`scene.ts` importa de aquí), así que los pocos helpers y
 * topes que se comparten con la escena están copiados abajo a propósito.
 */

export const MAX_UI_NODES = 800;
export const MAX_UI_DEPTH = 8;
export const MAX_UI_ITEMS = 50;
export const MAX_UI_ITEM_TEXT = 200;
export const MAX_UI_TITLE = 200;
export const MAX_UI_PLACEHOLDER = 200;

export const UI_KINDS: readonly string[] = [
  "container",
  "window",
  "tabs-h",
  "tabs-v",
  "accordion",
  "menu",
  "label",
  "input",
  "textarea",
  "choice",
  "button",
  "icon",
  "image",
];

/** Copia de `MAX_NODE_TEXT` (`scene.ts`): el texto de un widget tiene el mismo tope que el de un nodo. */
const MAX_UI_TEXT = 4000;
/** Copia de `MAX_IMAGE_CHARS` (`scene.ts`): 6 MB de texto de data URL, no de binario. */
const MAX_UI_IMAGE_CHARS = 6 * 1024 * 1024;
/** Copia de `DATA_IMAGE` (`scene.ts`): los tipos que el webview sabe pintar. */
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,/;
/** Copia de `MAX_COORD` (`scene.ts`). */
const MAX_COORD = 100000;
/** Copia de `NODE_ID` (`scene.ts`). */
const NODE_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** Copia de `ICON_NAME` (`scene.ts`). */
const ICON_NAME = /^[a-z-]{0,20}$/;
/** Copia de `ALIGNS` (`scene.ts`). */
const ALIGNS: readonly string[] = ["left", "center", "right"];
const CHOICE_VARIANTS: readonly string[] = ["", "check", "radio"];
const BUTTON_VARIANTS: readonly string[] = ["", "primary", "secondary"];

/** Chrome de cada widget, en px: lo que la caja útil deja fuera. */
const WINDOW_BAR = 28;
const TABS_STRIP_H = 26;
const TABS_STRIP_V = 110;
const ACCORDION_ROW = 26;

export interface UiNode {
  id: string;
  kind: string;
  /** `null` = raíz del árbol; el resto de widgets van relativos a la caja útil del padre. */
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  text: string;
  placeholder: string;
  items: string[];
  active: number;
  options: string[];
  checked: number[];
  variant: string;
  align: string;
  icon: string;
  src: string;
  disabled: boolean;
}

export interface Ui {
  nodes: UiNode[];
}

export function emptyUi(): Ui {
  return { nodes: [] };
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** Número acotado obligatorio: sin él el widget se descarta. */
function reqNum(raw: unknown, min: number, max: number): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, raw));
}

function clipText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.slice(0, max) : "";
}

function pick(raw: unknown, options: readonly string[], fallback: string): string {
  return typeof raw === "string" && options.includes(raw) ? raw : fallback;
}

function boolFlag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Id nuevo para su lista: válido y no repetido, o nada. */
function uiId(raw: unknown, used: Set<string>): string | undefined {
  if (typeof raw !== "string" || !NODE_ID.test(raw) || used.has(raw)) {
    return undefined;
  }
  return raw;
}

/** Lista de textos de un widget: solo strings, recortados a su tope y como mucho `MAX_UI_ITEMS`. */
function listOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const list: string[] = [];
  for (const value of raw.slice(0, MAX_UI_ITEMS)) {
    if (typeof value === "string") {
      list.push(value.slice(0, MAX_UI_ITEM_TEXT));
    }
  }
  return list;
}

/** Pestaña activa (tabs), fila abierta (accordion) o resaltada (menu): entero acotado a la lista. */
function activeOf(raw: unknown, kind: string, len: number): number {
  // En tabs manda la primera pestaña; en accordion y menu, -1 es «ninguna» y es el defecto.
  const fallback = kind === "tabs-h" || kind === "tabs-v" ? 0 : -1;
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.min(len - 1, Math.max(-1, value));
}

/** Índices marcados de un `choice`: válidos, sin repetir y en orden. */
function checkedOf(raw: unknown, len: number): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const indices = new Set<number>();
  for (const value of raw) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const indice = Math.round(value);
      if (indice >= 0 && indice < len) {
        indices.add(indice);
      }
    }
  }
  return [...indices].sort((a, b) => a - b);
}

function variantOf(raw: unknown, kind: string): string {
  if (kind === "choice") {
    return pick(raw, CHOICE_VARIANTS, "");
  }
  if (kind === "button") {
    return pick(raw, BUTTON_VARIANTS, "");
  }
  return "";
}

/** Data URL de imagen de un widget; `""` es «sin imagen» y también un valor válido. */
function srcImage(raw: unknown): string {
  return typeof raw === "string" && raw.length <= MAX_UI_IMAGE_CHARS && DATA_IMAGE.test(raw) ? raw : "";
}

/**
 * Resuelve el árbol: padre que no existe, ciclo o exceso de profundidad acaban en `null`
 * (el widget se queda, no se descarta). Cortar una rama acorta las cadenas de sus hijos,
 * así que se repite hasta que no quede nada que corregir.
 */
function resolveTree(nodes: UiNode[]): void {
  const byId = new Map<string, UiNode>();
  for (const node of nodes) {
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    if (node.parent !== null && !byId.has(node.parent)) {
      node.parent = null;
    }
  }
  for (let pasada = 0; pasada < MAX_UI_DEPTH + 2; pasada += 1) {
    let cambios = false;
    for (const node of nodes) {
      if (node.parent === null) {
        continue;
      }
      // `profundidad` cuenta ancestros: la raíz tiene 0 y el tope es MAX_UI_DEPTH.
      const visto = new Set<string>([node.id]);
      let actual = node;
      let profundidad = 0;
      let ciclo = false;
      while (actual.parent !== null) {
        const padre = byId.get(actual.parent);
        if (!padre || visto.has(padre.id)) {
          // Este es el eslabón que cierra el ciclo: pasa a raíz.
          actual.parent = null;
          ciclo = true;
          break;
        }
        visto.add(padre.id);
        profundidad += 1;
        actual = padre;
      }
      if (ciclo) {
        cambios = true;
      } else if (profundidad > MAX_UI_DEPTH) {
        // El más profundo paga el exceso: se queda como raíz y sus hijos se recolocan solos.
        node.parent = null;
        cambios = true;
      }
    }
    if (!cambios) {
      return;
    }
  }
}

/** Escena INTERFACES saneada. Nunca es `undefined`: lo que no vale se descarta widget a widget. */
export function sanitizeUi(raw: unknown): Ui {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) {
    return emptyUi();
  }
  const used = new Set<string>();
  const nodes: UiNode[] = [];
  for (const item of raw.nodes.slice(0, MAX_UI_NODES)) {
    if (!isRecord(item)) {
      continue;
    }
    const id = uiId(item.id, used);
    if (!id) {
      continue;
    }
    if (typeof item.kind !== "string" || !UI_KINDS.includes(item.kind)) {
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
    const items = listOf(item.items);
    const options = listOf(item.options);
    nodes.push({
      id,
      kind: item.kind,
      parent: typeof item.parent === "string" ? item.parent : null,
      x,
      y,
      w,
      h,
      title: clipText(item.title, MAX_UI_TITLE),
      text: clipText(item.text, MAX_UI_TEXT),
      placeholder: clipText(item.placeholder, MAX_UI_PLACEHOLDER),
      items,
      active: activeOf(item.active, item.kind, items.length),
      options,
      checked: checkedOf(item.checked, options.length),
      variant: variantOf(item.variant, item.kind),
      align: pick(item.align, ALIGNS, "left"),
      icon: typeof item.icon === "string" && ICON_NAME.test(item.icon) ? item.icon : "",
      src: srcImage(item.src),
      disabled: boolFlag(item.disabled, false),
    });
  }
  resolveTree(nodes);
  return { nodes };
}

/**
 * Caja útil local de un widget: dónde caben sus hijos, según el chrome que gasta.
 * Nunca con un lado por debajo de 1 px.
 */
export function uiContent(node: UiNode): { dx: number; dy: number; w: number; h: number } {
  let dx = 0;
  let dy = 0;
  let w = Math.max(1, node.w);
  let h = Math.max(1, node.h);
  switch (node.kind) {
    case "window":
      dy = WINDOW_BAR;
      h -= WINDOW_BAR;
      break;
    case "tabs-h":
      dy = TABS_STRIP_H;
      h -= TABS_STRIP_H;
      break;
    case "tabs-v":
      dx = TABS_STRIP_V;
      w -= TABS_STRIP_V;
      break;
    case "accordion":
      // Debajo de todas las filas: cada una se come su alto aunque esté cerrada.
      dy = ACCORDION_ROW * node.items.length;
      h -= ACCORDION_ROW * node.items.length;
      break;
  }
  return { dx, dy, w: Math.max(1, w), h: Math.max(1, h) };
}

/** Tamaño con el que nace un widget de cada tipo; un tipo desconocido nace como `container`. */
export function uiDefaults(kind: string): { w: number; h: number } {
  switch (kind) {
    case "window":
      return { w: 320, h: 220 };
    case "tabs-h":
    case "tabs-v":
      return { w: 360, h: 240 };
    case "accordion":
      return { w: 320, h: 200 };
    case "menu":
      return { w: 160, h: 140 };
    case "label":
      return { w: 160, h: 24 };
    case "input":
      return { w: 200, h: 28 };
    case "textarea":
      return { w: 240, h: 80 };
    case "choice":
      return { w: 200, h: 44 };
    case "button":
      return { w: 120, h: 32 };
    case "icon":
      return { w: 32, h: 32 };
    case "image":
      return { w: 160, h: 120 };
    default:
      return { w: 240, h: 160 };
  }
}
