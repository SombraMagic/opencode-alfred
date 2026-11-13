/**
 * Contrato del rostro 3D: lo comparten el servidor MCP (`mcp_alfred`, sin `vscode`), el
 * host del panel de voz y, por nombre, el webview (`media/rostro.js`).
 *
 * El MCP no dibuja nada: escribe órdenes en `%APPDATA%\voz\rostro.json` (`RostroFile`) y
 * el panel las ejecuta. Las tablas de abajo son la ÚNICA lista de nombres: el webview debe
 * implementar exactamente estas claves y el MCP las usa para validar y para el esquema.
 * Regla común de los parámetros: 0 = neutro; los de un solo sentido van de 0 a 1.
 */

export interface ParamDef {
  min: number;
  max: number;
  desc: string;
}

/** Controles finos del rostro (equivalen a los blendshapes). */
export const PARAMS: Record<string, ParamDef> = {
  parpadoI: { min: -1, max: 1, desc: "párpado del ojo izquierdo: -1 cerrado, 0 normal, 1 muy abierto" },
  parpadoD: { min: -1, max: 1, desc: "párpado del ojo derecho: -1 cerrado, 0 normal, 1 muy abierto" },
  cejaI: { min: -1, max: 1, desc: "ceja izquierda: -1 baja, 0 normal, 1 alzada" },
  cejaD: { min: -1, max: 1, desc: "ceja derecha: -1 baja, 0 normal, 1 alzada" },
  cejasInclina: { min: -1, max: 1, desc: "inclinación de las cejas: -1 enfado (interiores abajo), 1 pena (interiores arriba)" },
  mirarX: { min: -1, max: 1, desc: "mirada horizontal: -1 izquierda, 1 derecha" },
  mirarY: { min: -1, max: 1, desc: "mirada vertical: -1 abajo, 1 arriba" },
  bocaAbierta: { min: 0, max: 1, desc: "apertura de la mandíbula: 0 cerrada, 1 abierta del todo" },
  sonrisaI: { min: -1, max: 1, desc: "comisura izquierda: -1 caída, 0 normal, 1 sonrisa" },
  sonrisaD: { min: -1, max: 1, desc: "comisura derecha: -1 caída, 0 normal, 1 sonrisa" },
  bocaRedonda: { min: 0, max: 1, desc: "labios en «o» (sorpresa, silbido, beso)" },
  bocaAncha: { min: 0, max: 1, desc: "labios estirados a los lados, como en «iii»" },
  labiosApretados: { min: 0, max: 1, desc: "labios apretados (enfado contenido, esfuerzo)" },
  mejillas: { min: 0, max: 1, desc: "mejillas infladas" },
  nariz: { min: 0, max: 1, desc: "nariz arrugada (asco)" },
  cabezaGiro: { min: -1, max: 1, desc: "giro de la cabeza: -1 izquierda, 1 derecha" },
  cabezaInclinacion: { min: -1, max: 1, desc: "cabeza: -1 baja, 1 sube" },
  cabezaLadeo: { min: -1, max: 1, desc: "cabeza ladeada: -1 hacia el hombro izquierdo, 1 hacia el derecho" },
  rubor: { min: 0, max: 1, desc: "rubor en las mejillas (vergüenza, ternura)" },
};

/** Expresiones con nombre: cada una es una combinación de `PARAMS` que define el webview. */
export const EXPRESIONES: Record<string, string> = {
  neutral: "cara en reposo",
  feliz: "sonrisa suave y ojos alegres",
  risa: "carcajada: boca abierta, ojos entornados",
  triste: "cejas de pena, comisuras caídas, mirada baja",
  llorando: "tristeza fuerte con ojos húmedos",
  enfadado: "ceño fruncido y labios apretados",
  furioso: "ira: ceño, dientes apretados, ojos abiertos",
  sorprendido: "cejas arriba, ojos muy abiertos, boca en «o»",
  asustado: "miedo: ojos muy abiertos, cejas de pena, boca tensa",
  asco: "nariz arrugada, boca torcida hacia abajo",
  pensativo: "mirada arriba a un lado, una ceja alzada",
  confuso: "cejas desiguales, cabeza ladeada, boca torcida",
  esceptico: "una ceja alzada y media sonrisa",
  burlon: "sonrisa de medio lado con ceja alzada",
  cansado: "párpados caídos, mirada baja",
  dormido: "ojos cerrados, cabeza caída",
  concentrado: "cejas bajas, ojos entornados, labios apretados",
  avergonzado: "rubor, mirada esquiva, sonrisa tímida",
  orgulloso: "cabeza alta, sonrisa serena, ojos entornados",
  preocupado: "cejas de pena y boca tensa",
  aburrido: "párpados medio caídos, comisuras planas, mirada al lado",
  travieso: "sonrisa ancha, cejas alzadas, ojos chispeantes",
  amor: "ojos grandes y brillantes, rubor, sonrisa tierna",
};

/** Gestos puntuales: animan y vuelven solos a la expresión de antes. */
export const GESTOS: Record<string, string> = {
  parpadear: "un parpadeo",
  guinar: "guiño (lado: izq o der)",
  asentir: "cabeceo de sí",
  negar: "cabeceo de no",
  ladear: "ladea la cabeza con curiosidad (lado: izq o der)",
  levantar_cejas: "alza las cejas y las baja",
  suspirar: "toma aire, lo suelta y baja la mirada",
  reir: "risa corta con sacudida de cabeza",
  mirar_alrededor: "recorre la sala con la mirada",
  beso: "labios en «o» y guiño",
  bostezar: "bostezo con la boca muy abierta",
};

/** Destinos de `rostro_mirar` además de x/y. */
export const OBJETIVOS = ["camara", "izquierda", "derecha", "arriba", "abajo", "centro"] as const;

export type Lado = "izq" | "der";

/** Una orden ya validada, tal como viaja por `rostro.json`. */
export type RostroCmd = { seq: number; t: number } & (
  | { type: "expresar"; expresion: string; intensidad: number; duracionMs: number; transicionMs: number }
  | { type: "gesto"; gesto: string; lado?: Lado; veces: number }
  | { type: "mirar"; x?: number; y?: number; objetivo?: string; cabeza: boolean }
  | { type: "ajustar"; ajustes: Record<string, number>; transicionMs: number }
  | { type: "secuencia"; pasos: RostroPaso[]; repetir: number }
);

/** Paso de una secuencia: lo que se aplica y cuánto se mantiene antes del siguiente. */
export interface RostroPaso {
  expresion?: string;
  intensidad?: number;
  gesto?: string;
  lado?: Lado;
  ajustes?: Record<string, number>;
  ms: number;
}

/** `%APPDATA%\voz\rostro.json`: las últimas órdenes (tope 20) y el contador. */
export interface RostroFile {
  seq: number;
  cmds: RostroCmd[];
}
