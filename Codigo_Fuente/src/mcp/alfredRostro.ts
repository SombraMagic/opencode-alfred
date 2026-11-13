/**
 * Herramientas MCP del rostro 3D (`rostro_*`). Validan con las tablas de
 * `src/rostro/contract.ts` y dejan cada orden en `rostro.json` (carpeta de estado
 * compartida); el panel de voz las ejecuta. Corren en el proceso MCP: sin `vscode`.
 *
 * Pensadas para modelos pequeños: aceptan mayúsculas, acentos, números como texto y,
 * si algo no vale, el error lista los valores válidos.
 */
import { readRostro, writeRostroCmd } from "../voice/core/index.js";
import {
  EXPRESIONES,
  GESTOS,
  OBJETIVOS,
  PARAMS,
  type Lado,
  type RostroPaso,
} from "../rostro/contract";

const EXPR_NAMES = Object.keys(EXPRESIONES);
const GESTO_NAMES = Object.keys(GESTOS);
const PARAM_NAMES = Object.keys(PARAMS);

/** Lo último enviado, en memoria de este proceso. */
const ultimo: { expresion: string; mirada: { x?: number; y?: number; objetivo?: string } | null } = {
  expresion: "neutral",
  mirada: null,
};

/** Minúsculas, sin acentos y con `_` por espacios o guiones: «Guiñar» → «guinar». */
function norm(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

/** Elige un nombre de la lista, o falla listando los válidos. */
function pick(campo: string, v: unknown, valid: readonly string[]): string {
  const n = norm(v);
  const hit = valid.find((x) => norm(x) === n);
  if (!hit) {
    throw new Error(`${campo} "${String(v ?? "")}" no vale. Valores válidos: ${valid.join(", ")}.`);
  }
  return hit;
}

/** Número (o texto numérico, admite coma) acotado; `def` si falta. */
function num(campo: string, v: unknown, min: number, max: number, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`${campo} "${String(v)}" no es un número (rango ${min}..${max}).`);
  return Math.min(max, Math.max(min, n));
}

function lado(v: unknown): Lado | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = norm(v);
  if (["izq", "izquierda", "izquierdo", "i", "left", "l"].includes(n)) return "izq";
  if (["der", "derecha", "derecho", "d", "right", "r"].includes(n)) return "der";
  throw new Error(`lado "${String(v)}" no vale. Valores válidos: izq, der (también izquierda, derecha).`);
}

/** Acepta un objeto o su JSON como texto (algún modelo lo manda así). */
function objeto(campo: string, v: unknown): Record<string, unknown> {
  let o = v;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      // Cae al error de abajo.
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    throw new Error(`${campo} debe ser un objeto nombre→valor. Nombres válidos: ${PARAM_NAMES.join(", ")}.`);
  }
  return o as Record<string, unknown>;
}

function ajustes(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(objeto("ajustes", v))) {
    const name = pick("Parámetro", k, PARAM_NAMES);
    const p = PARAMS[name];
    out[name] = num(name, val, p.min, p.max, 0);
  }
  if (!Object.keys(out).length) throw new Error(`ajustes está vacío. Nombres válidos: ${PARAM_NAMES.join(", ")}.`);
  return out;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Valida una expresión sin escribir nada. */
export function validarExpresion(v: unknown): string {
  return pick("expresion", v, EXPR_NAMES);
}

/** `rostro_expresar`; también lo usa `speak` con `expresion`. */
export function expresarRostro(args: Record<string, unknown>): string {
  const expresion = pick("expresion", args.expresion, EXPR_NAMES);
  const intensidad = num("intensidad", args.intensidad, 0, 1, 1);
  const duracionMs = num("duracion_ms", args.duracion_ms, 0, 60000, 0);
  const transicionMs = num("transicion_ms", args.transicion_ms, 0, 5000, 400);
  writeRostroCmd({ type: "expresar", expresion, intensidad, duracionMs, transicionMs });
  ultimo.expresion = duracionMs > 0 ? "neutral" : expresion;
  return `Rostro: ${expresion} (intensidad ${fmt(intensidad)})${duracionMs > 0 ? `, vuelve a neutral en ${duracionMs} ms` : ""}.`;
}

function gesto(args: Record<string, unknown>): string {
  const g = pick("gesto", args.gesto, GESTO_NAMES);
  const l = lado(args.lado);
  const veces = Math.round(num("veces", args.veces, 1, 5, 1));
  writeRostroCmd({ type: "gesto", gesto: g, ...(l ? { lado: l } : {}), veces });
  return `Rostro: gesto ${g}${l ? ` (${l})` : ""}${veces > 1 ? ` x${veces}` : ""}.`;
}

function mirar(args: Record<string, unknown>): string {
  const cabeza = args.cabeza === true || norm(args.cabeza) === "true" || norm(args.cabeza) === "si";
  const hasXY = args.x !== undefined || args.y !== undefined;
  if (args.objetivo === undefined && !hasXY) {
    throw new Error(`Falta objetivo (${OBJETIVOS.join(", ")}) o las coordenadas x e y (-1..1).`);
  }
  if (args.objetivo !== undefined && args.objetivo !== "") {
    const objetivo = pick("objetivo", args.objetivo, OBJETIVOS);
    writeRostroCmd({ type: "mirar", objetivo, cabeza });
    ultimo.mirada = { objetivo };
    return `Rostro: mira a ${objetivo}${cabeza ? " con la cabeza" : ""}.`;
  }
  const x = num("x", args.x, -1, 1, 0);
  const y = num("y", args.y, -1, 1, 0);
  writeRostroCmd({ type: "mirar", x, y, cabeza });
  ultimo.mirada = { x, y };
  return `Rostro: mira a (${fmt(x)}, ${fmt(y)})${cabeza ? " con la cabeza" : ""}.`;
}

function ajustar(args: Record<string, unknown>): string {
  const a = ajustes(args.ajustes);
  writeRostroCmd({ type: "ajustar", ajustes: a, transicionMs: num("transicion_ms", args.transicion_ms, 0, 5000, 300) });
  return `Rostro: ajustado ${Object.keys(a).join(", ")}.`;
}

function secuencia(args: Record<string, unknown>): string {
  let raw = args.pasos;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      // Cae al error de abajo.
    }
  }
  if (!Array.isArray(raw) || !raw.length) throw new Error("pasos debe ser una lista con al menos un paso.");
  if (raw.length > 20) throw new Error(`Máximo 20 pasos (llegaron ${raw.length}).`);
  const pasos = raw.map((p, i): RostroPaso => {
    if (!p || typeof p !== "object") throw new Error(`Paso ${i + 1}: debe ser un objeto con expresion, gesto o ajustes, y ms.`);
    const s = p as Record<string, unknown>;
    const paso: RostroPaso = { ms: Math.round(num("ms", s.ms, 50, 10000, 500)) };
    try {
      if (s.expresion) paso.expresion = pick("expresion", s.expresion, EXPR_NAMES);
      if (s.intensidad !== undefined) paso.intensidad = num("intensidad", s.intensidad, 0, 1, 1);
      if (s.gesto) paso.gesto = pick("gesto", s.gesto, GESTO_NAMES);
      const l = lado(s.lado);
      if (l) paso.lado = l;
      if (s.ajustes !== undefined) paso.ajustes = ajustes(s.ajustes);
    } catch (err) {
      throw new Error(`Paso ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return paso;
  });
  const repetir = Math.round(num("repetir", args.repetir, 1, 5, 1));
  writeRostroCmd({ type: "secuencia", pasos, repetir });
  const ultimaExpr = [...pasos].reverse().find((p) => p.expresion)?.expresion;
  if (ultimaExpr) ultimo.expresion = ultimaExpr;
  return `Rostro: secuencia de ${pasos.length} paso(s)${repetir > 1 ? ` x${repetir}` : ""}.`;
}

function estado(): string {
  const f = readRostro();
  return JSON.stringify({
    expresiones: EXPRESIONES,
    gestos: GESTOS,
    parametros: Object.fromEntries(
      Object.entries(PARAMS).map(([k, p]) => [k, { min: p.min, max: p.max, desc: p.desc }]),
    ),
    objetivos: OBJETIVOS,
    ultimo: { expresion: ultimo.expresion, mirada: ultimo.mirada, ordenes: f.seq },
  });
}

const str = (description: string, extra: object = {}) => ({ type: "string", description, ...extra });
const nume = (description: string, minimum: number, maximum: number, def: number) => ({
  type: "number",
  description,
  minimum,
  maximum,
  default: def,
});

export const ROSTRO_TOOLS = [
  {
    name: "rostro_expresar",
    description: "Pone una expresión en el rostro del panel de voz (feliz, triste, enfadado...). Llama a rostro_estado para ver todas.",
    inputSchema: {
      type: "object",
      properties: {
        expresion: str("Expresión a poner.", { enum: EXPR_NAMES }),
        intensidad: nume("Fuerza de la expresión: 0 neutra, 1 completa.", 0, 1, 1),
        duracion_ms: nume("0 = se mantiene; mayor que 0 = vuelve a neutral pasado ese tiempo.", 0, 60000, 0),
        transicion_ms: nume("Tiempo de la transición en ms.", 0, 5000, 400),
      },
      required: ["expresion"],
    },
  },
  {
    name: "rostro_gesto",
    description: "Hace un gesto puntual (parpadear, guiñar, asentir, negar...) y vuelve a la expresión de antes.",
    inputSchema: {
      type: "object",
      properties: {
        gesto: str("Gesto a hacer.", { enum: GESTO_NAMES }),
        lado: str("Lado, para guinar y ladear.", { enum: ["izq", "der"] }),
        veces: { type: "integer", description: "Cuántas veces repetirlo.", minimum: 1, maximum: 5, default: 1 },
      },
      required: ["gesto"],
    },
  },
  {
    name: "rostro_mirar",
    description: "Dirige la mirada: a un objetivo con nombre, o a unas coordenadas x,y entre -1 y 1.",
    inputSchema: {
      type: "object",
      properties: {
        objetivo: str("Destino con nombre.", { enum: [...OBJETIVOS] }),
        x: nume("Horizontal: -1 izquierda, 1 derecha (si no hay objetivo).", -1, 1, 0),
        y: nume("Vertical: -1 abajo, 1 arriba (si no hay objetivo).", -1, 1, 0),
        cabeza: { type: "boolean", description: "Mover también la cabeza.", default: false },
      },
    },
  },
  {
    name: "rostro_ajustar",
    description: "Ajuste fino: fija parámetros sueltos del rostro (cejas, boca, párpados...). Los nombres y rangos salen de rostro_estado.",
    inputSchema: {
      type: "object",
      properties: {
        ajustes: {
          type: "object",
          description: `Nombre→valor. Nombres: ${PARAM_NAMES.join(", ")}. El valor se acota a su rango.`,
          additionalProperties: { type: "number" },
        },
        transicion_ms: nume("Tiempo de la transición en ms.", 0, 5000, 300),
      },
      required: ["ajustes"],
    },
  },
  {
    name: "rostro_secuencia",
    description: "Encadena hasta 20 pasos (expresión, gesto o ajustes), cada uno con su duración en ms.",
    inputSchema: {
      type: "object",
      properties: {
        pasos: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              expresion: str("Expresión del paso.", { enum: EXPR_NAMES }),
              intensidad: nume("Intensidad de la expresión.", 0, 1, 1),
              gesto: str("Gesto del paso.", { enum: GESTO_NAMES }),
              lado: str("Lado del gesto.", { enum: ["izq", "der"] }),
              ajustes: { type: "object", additionalProperties: { type: "number" } },
              ms: { type: "integer", description: "Lo que dura el paso.", minimum: 50, maximum: 10000, default: 500 },
            },
          },
        },
        repetir: { type: "integer", description: "Veces que se repite toda la secuencia.", minimum: 1, maximum: 5, default: 1 },
      },
      required: ["pasos"],
    },
  },
  {
    name: "rostro_estado",
    description: "Ayuda: devuelve en JSON todas las expresiones, gestos, parámetros (con rango), objetivos y lo último enviado al rostro.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Ejecuta una herramienta de rostro; `undefined` si el nombre no es suyo. */
export function callRostroTool(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case "rostro_expresar":
      return expresarRostro(args);
    case "rostro_gesto":
      return gesto(args);
    case "rostro_mirar":
      return mirar(args);
    case "rostro_ajustar":
      return ajustar(args);
    case "rostro_secuencia":
      return secuencia(args);
    case "rostro_estado":
      return estado();
    default:
      return undefined;
  }
}
