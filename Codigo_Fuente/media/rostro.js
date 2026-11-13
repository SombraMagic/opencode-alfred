/**
 * Rostro 3D de Alfred (panel de voz). Modelado procedural con three.js (media/three/):
 * sin ficheros de modelo. Todo lo que se mueve se reconstruye por fotograma sobre la
 * superficie de la cabeza (`surf`), así que ojos, cejas y boca siempre se ven pegados a ella.
 *
 * Convención: izquierda/derecha (parpadoI, cejaD, sonrisaI, lado "izq"...) son las de
 * PANTALLA: «izquierda» es la que ve el usuario a su izquierda.
 *
 * API (`window.VOZRostro`): envelope(msg), idle(), activity(act), command(cmd).
 * Las tablas EXPRESIONES y GESTOS de aquí cubren exactamente las claves de
 * src/rostro/contract.ts.
 */
import * as THREE from "three";

const canvas = document.getElementById("rostro");

// ── Utilidades ──────────────────────────────────────────
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rand = (a, b) => a + Math.random() * (b - a);

// ── Parámetros (contrato) y los internos de este fichero ─
const RANGE = {
  parpadoI: [-1, 1], parpadoD: [-1, 1], cejaI: [-1, 1], cejaD: [-1, 1], cejasInclina: [-1, 1],
  mirarX: [-1, 1], mirarY: [-1, 1], bocaAbierta: [0, 1], sonrisaI: [-1, 1], sonrisaD: [-1, 1],
  bocaRedonda: [0, 1], bocaAncha: [0, 1], labiosApretados: [0, 1], mejillas: [0, 1], nariz: [0, 1],
  cabezaGiro: [-1, 1], cabezaInclinacion: [-1, 1], cabezaLadeo: [-1, 1], rubor: [0, 1],
  // Internos (no los pide el MCP): ojos entornados, pupila, brillo, lágrimas, corazones.
  entorna: [0, 1], pupila: [-1, 1], brillo: [0, 1], lagrimas: [0, 1], corazones: [0, 1],
};
const KEYS = Object.keys(RANGE);
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));

/** Expresiones: cada una es una combinación de parámetros (los que faltan valen 0). */
const EXPRESIONES = {
  neutral: {},
  feliz: { sonrisaI: 0.62, sonrisaD: 0.62, cejaI: 0.15, cejaD: 0.15, entorna: 0.3, rubor: 0.25, brillo: 0.5 },
  risa: { bocaAbierta: 0.62, sonrisaI: 1, sonrisaD: 1, parpadoI: -0.3, parpadoD: -0.3, entorna: 0.85, cejaI: 0.2, cejaD: 0.2, rubor: 0.4, cabezaInclinacion: 0.2, brillo: 0.7, mejillas: 0.15 },
  triste: { cejasInclina: 0.9, cejaI: -0.15, cejaD: -0.15, sonrisaI: -0.6, sonrisaD: -0.6, mirarY: -0.5, parpadoI: -0.25, parpadoD: -0.25, cabezaInclinacion: -0.22, labiosApretados: 0.15, brillo: 0.4 },
  llorando: { cejasInclina: 1, sonrisaI: -0.85, sonrisaD: -0.85, parpadoI: -0.35, parpadoD: -0.35, mirarY: -0.3, bocaAbierta: 0.22, bocaAncha: 0.45, lagrimas: 1, brillo: 1, cabezaInclinacion: -0.25, rubor: 0.5, entorna: 0.2 },
  enfadado: { cejasInclina: -0.9, cejaI: -0.45, cejaD: -0.45, labiosApretados: 0.85, sonrisaI: -0.3, sonrisaD: -0.3, parpadoI: -0.2, parpadoD: -0.2, entorna: 0.35, nariz: 0.25, cabezaInclinacion: -0.08, pupila: -0.3 },
  furioso: { cejasInclina: -1, cejaI: -0.65, cejaD: -0.65, bocaAbierta: 0.14, bocaAncha: 0.85, sonrisaI: -0.35, sonrisaD: -0.35, nariz: 0.7, parpadoI: 0.2, parpadoD: 0.2, pupila: -0.8, rubor: 0.6, cabezaInclinacion: -0.12 },
  sorprendido: { cejaI: 1, cejaD: 1, parpadoI: 0.95, parpadoD: 0.95, bocaRedonda: 0.85, bocaAbierta: 0.5, pupila: -0.35, cabezaInclinacion: 0.12, brillo: 0.5 },
  asustado: { cejaI: 0.75, cejaD: 0.75, cejasInclina: 0.75, parpadoI: 1, parpadoD: 1, bocaAbierta: 0.3, bocaAncha: 0.75, sonrisaI: -0.35, sonrisaD: -0.35, pupila: -0.75, cabezaInclinacion: -0.1, mirarY: 0.1 },
  asco: { nariz: 1, sonrisaI: -0.7, sonrisaD: -0.15, cejasInclina: -0.5, cejaI: -0.35, cejaD: -0.05, entorna: 0.55, bocaAncha: 0.35, bocaAbierta: 0.14, cabezaGiro: 0.28, cabezaLadeo: 0.12, parpadoI: -0.15, parpadoD: -0.15 },
  pensativo: { mirarX: -0.55, mirarY: 0.65, cejaD: 0.65, cejaI: -0.1, sonrisaI: -0.15, labiosApretados: 0.3, cabezaLadeo: 0.35, cabezaGiro: -0.2, cabezaInclinacion: 0.08 },
  confuso: { cejaI: 0.85, cejaD: -0.35, cabezaLadeo: -0.6, sonrisaI: -0.5, sonrisaD: 0.2, labiosApretados: 0.25, mirarX: 0.2, parpadoD: -0.15 },
  esceptico: { cejaD: 0.95, cejaI: -0.3, sonrisaD: 0.55, sonrisaI: -0.1, parpadoI: -0.3, entorna: 0.15, cabezaLadeo: 0.15, labiosApretados: 0.2 },
  burlon: { sonrisaI: 1, sonrisaD: 0.1, cejaI: 0.9, cejaD: -0.1, parpadoD: -0.3, entorna: 0.3, cabezaGiro: -0.15, cabezaLadeo: -0.22, bocaAbierta: 0.05, brillo: 0.5 },
  cansado: { parpadoI: -0.58, parpadoD: -0.58, cejaI: -0.15, cejaD: -0.15, cejasInclina: 0.35, sonrisaI: -0.2, sonrisaD: -0.2, mirarY: -0.4, cabezaInclinacion: -0.28, bocaAbierta: 0.05 },
  dormido: { parpadoI: -1, parpadoD: -1, cejasInclina: 0.2, sonrisaI: 0.15, sonrisaD: 0.15, cabezaInclinacion: -0.55, cabezaLadeo: 0.4, bocaAbierta: 0.1, rubor: 0.15 },
  concentrado: { cejaI: -0.5, cejaD: -0.5, cejasInclina: -0.35, parpadoI: -0.3, parpadoD: -0.3, entorna: 0.3, labiosApretados: 0.65, cabezaInclinacion: -0.08 },
  avergonzado: { rubor: 1, mirarX: 0.6, mirarY: -0.5, sonrisaI: 0.3, sonrisaD: 0.3, cejasInclina: 0.55, parpadoI: -0.1, parpadoD: -0.1, cabezaLadeo: 0.25, cabezaInclinacion: -0.2 },
  orgulloso: { cabezaInclinacion: 0.32, sonrisaI: 0.5, sonrisaD: 0.5, entorna: 0.4, parpadoI: -0.22, parpadoD: -0.22, cejaI: 0.1, cejaD: 0.1, rubor: 0.12, mirarY: -0.15, labiosApretados: 0.2, brillo: 0.6 },
  preocupado: { cejasInclina: 0.95, cejaI: 0.1, cejaD: 0.1, sonrisaI: -0.3, sonrisaD: -0.3, labiosApretados: 0.5, parpadoI: 0.1, parpadoD: 0.1, mirarY: 0.1, pupila: -0.2 },
  aburrido: { parpadoI: -0.5, parpadoD: -0.5, cejaI: -0.1, cejaD: -0.1, mirarX: 0.55, mirarY: -0.1, cabezaLadeo: -0.3, cabezaInclinacion: -0.1, sonrisaI: -0.08, sonrisaD: -0.08 },
  travieso: { sonrisaI: 1, sonrisaD: 0.8, bocaAncha: 0.35, cejaI: 0.9, cejaD: 0.45, entorna: 0.3, brillo: 1, rubor: 0.2, cabezaLadeo: 0.22, mirarX: 0.25, bocaAbierta: 0.06 },
  amor: { parpadoI: 0.6, parpadoD: 0.6, brillo: 1, pupila: 0.9, rubor: 0.85, sonrisaI: 0.55, sonrisaD: 0.55, cejasInclina: 0.3, cejaI: 0.35, cejaD: 0.35, cabezaLadeo: 0.22, corazones: 1 },
};

// ── Gestos: animaciones puntuales ───────────────────────
/** Pulso suave: sube en [0,a], se mantiene hasta b y baja. */
const pulso = (u, a = 0.25, b = 0.7) => (u < a ? ease(u / a) : u < b ? 1 : ease((1 - u) / (1 - b)));
/** `a` es el acumulador aditivo; `s` es el lado (-1 izquierda de pantalla, 1 derecha). */
const GESTOS = {
  parpadear: { ms: 360, fn: (u, s, a) => { a.blink = Math.max(a.blink, u < 0.4 ? ease(u / 0.4) : ease((1 - u) / 0.6)); } },
  guinar: {
    ms: 950,
    fn: (u, s, a) => {
      const e = pulso(u, 0.22, 0.62);
      a[s < 0 ? "parpadoI" : "parpadoD"] -= 1.8 * e;
      a[s < 0 ? "sonrisaI" : "sonrisaD"] += 0.45 * e;
      a[s < 0 ? "cejaI" : "cejaD"] -= 0.35 * e;
      a.entorna += 0.3 * e;
      a.cabezaLadeo += s * 0.12 * e;
    },
  },
  asentir: {
    ms: 1100,
    fn: (u, s, a) => {
      a.cabezaInclinacion -= 0.42 * Math.sin(u * Math.PI * 4) * Math.sin(u * Math.PI);
      a.parpadoI -= 0.15 * pulso(u);
      a.parpadoD -= 0.15 * pulso(u);
    },
  },
  negar: {
    ms: 1200,
    fn: (u, s, a) => {
      a.cabezaGiro += 0.62 * Math.sin(u * Math.PI * 5) * Math.sin(u * Math.PI);
      a.cejasInclina += 0.25 * pulso(u);
    },
  },
  ladear: {
    ms: 1700,
    fn: (u, s, a) => {
      const e = pulso(u, 0.25, 0.7);
      a.cabezaLadeo += s * 0.85 * e;
      a[s < 0 ? "cejaD" : "cejaI"] += 0.45 * e;
      a.mirarX -= s * 0.15 * e;
      a.mirarY += 0.15 * e;
    },
  },
  levantar_cejas: {
    ms: 1000,
    fn: (u, s, a) => {
      const e = pulso(u, 0.2, 0.55);
      a.cejaI += 0.95 * e;
      a.cejaD += 0.95 * e;
      a.parpadoI += 0.25 * e;
      a.parpadoD += 0.25 * e;
    },
  },
  suspirar: {
    ms: 2700,
    fn: (u, s, a) => {
      // Toma aire (0 a 0,38), lo suelta y baja la mirada.
      const inh = ease(clamp(u / 0.38));
      const exh = u > 0.38 ? pulso((u - 0.38) / 0.62, 0.15, 0.7) : 0;
      a.cabezaInclinacion += 0.2 * inh * (1 - exh) - 0.32 * exh;
      a.bocaRedonda += 0.3 * inh * (1 - exh) + 0.3 * exh;
      a.bocaAbierta += 0.18 * exh;
      a.mirarY -= 0.55 * exh;
      a.parpadoI -= 0.4 * exh;
      a.parpadoD -= 0.4 * exh;
      a.cejasInclina += 0.4 * exh;
      a.cejaI += 0.2 * inh * (1 - exh);
      a.cejaD += 0.2 * inh * (1 - exh);
      a.breath += 1.6 * (u < 0.38 ? inh : 1 - ease((u - 0.38) / 0.62));
    },
  },
  reir: {
    ms: 1500,
    fn: (u, s, a) => {
      const e = pulso(u, 0.12, 0.8);
      const t = u * Math.PI * 2 * 6;
      a.sonrisaI += 1 * e;
      a.sonrisaD += 1 * e;
      a.bocaAbierta += e * (0.45 + 0.2 * Math.sin(t));
      a.parpadoI -= 0.35 * e;
      a.parpadoD -= 0.35 * e;
      a.entorna += 0.85 * e;
      a.cejaI += 0.2 * e;
      a.cejaD += 0.2 * e;
      a.cabezaInclinacion += e * (0.1 + 0.1 * Math.sin(t));
      a.cabezaLadeo += 0.1 * e * Math.sin(t * 0.5);
      a.rubor += 0.3 * e;
      a.mejillas += 0.2 * e;
    },
  },
  mirar_alrededor: {
    ms: 2900,
    fn: (u, s, a) => {
      const x = u < 0.3 ? -0.9 * ease(u / 0.3) : u < 0.7 ? lerp(-0.9, 0.9, ease((u - 0.3) / 0.4)) : lerp(0.9, 0, ease((u - 0.7) / 0.3));
      const y = 0.25 * Math.sin(u * Math.PI * 2) * Math.sin(u * Math.PI);
      a.mirarX += x;
      a.mirarY += y;
      a.cabezaGiro += x * 0.55;
      a.cabezaInclinacion += y * 0.4;
    },
  },
  beso: {
    ms: 1600,
    fx: 0.5,
    fn: (u, s, a) => {
      const e = pulso(u, 0.2, 0.7);
      a.bocaRedonda += 0.95 * e;
      a.bocaAbierta += 0.08 * e;
      a.parpadoD -= 1.8 * pulso(u, 0.25, 0.55);
      a.rubor += 0.6 * e;
      a.cejaI += 0.25 * e;
      a.cabezaLadeo += 0.2 * e;
      a.mejillas += 0.25 * e;
    },
  },
  bostezar: {
    ms: 3000,
    fn: (u, s, a) => {
      const e = pulso(u, 0.3, 0.68);
      a.bocaAbierta += 1 * e;
      a.bocaRedonda += 0.35 * e;
      a.parpadoI -= 1.1 * e;
      a.parpadoD -= 1.1 * e;
      a.cejaI += 0.5 * e;
      a.cejaD += 0.5 * e;
      a.cabezaInclinacion += 0.35 * e;
      a.mejillas += 0.25 * e;
      a.breath += 1.0 * e;
      a.entorna += 0.5 * e;
    },
  },
};

// ── Estado de animación ─────────────────────────────────
let base = zero(); // valores actuales de la expresión
let from = zero();
let to = zero();
const tw = { t0: 0, dur: 1 };
let userExpr = false; // hay una expresión pedida (los gestos de «pensar» no la pisan)
let gazeFixed = false;
let timeline = []; // [{ at, fn }] ordenada por at
let tlToken = 0;
const gestures = []; // { name, def, t0, dur, side, veces, fx }
let actCount = 0;
let actStreaming = false;
const life = { blink: 0, nextBlink: 0, blinkT0: -1, double: false, sacX: 0, sacY: 0, sacTX: 0, sacTY: 0, nextSac: 0, think: 0 };
const speech = { on: false, t0: 0, dur: 0, energy: [], cb: 0.5, seed: 0, jaw: 0, wide: 0, round: 0, lift: 0 };
const seen = new Set();

const RT = { now: 0 }; // reloj del bucle, para los temporizadores internos

function startTween(newTo, ms) {
  from = { ...base };
  to = newTo;
  tw.t0 = performance.now();
  tw.dur = Math.max(1, ms);
}

/** Pone en valor `ajustes` (o las claves de una expresión); lo demás sigue como está. */
function setTarget(vals, ms, keepRest) {
  const t = keepRest ? { ...to } : zero();
  for (const [k, v] of Object.entries(vals)) {
    if (!Object.hasOwn(RANGE, k) || typeof v !== "number" || !Number.isFinite(v)) continue;
    t[k] = clamp(v, RANGE[k][0], RANGE[k][1]);
  }
  startTween(t, ms);
}

function expresar(nombre, intensidad, ms) {
  const def = Object.hasOwn(EXPRESIONES, nombre) ? EXPRESIONES[nombre] : null;
  if (!def) return;
  const k = clamp(Number.isFinite(intensidad) ? intensidad : 1, 0, 1);
  const vals = {};
  for (const [p, v] of Object.entries(def)) vals[p] = v * k;
  setTarget(vals, ms, false);
  userExpr = nombre !== "neutral" && k > 0.01;
  gazeFixed = false;
}

function addGesto(nombre, lado, veces) {
  if (!Object.hasOwn(GESTOS, nombre)) return;
  const def = GESTOS[nombre];
  const n = clamp(Math.round(veces || 1), 1, 6);
  gestures.push({ def, t0: performance.now(), dur: def.ms * n, n, side: lado === "izq" ? -1 : 1, fx: false });
}

function schedule(at, fn) {
  timeline.push({ at, fn });
  timeline.sort((a, b) => a.at - b.at);
}

function cancelTimeline() {
  tlToken++;
  timeline = [];
}

const OBJETIVOS = { camara: [0, 0], centro: [0, 0], izquierda: [-0.9, 0], derecha: [0.9, 0], arriba: [0, 0.8], abajo: [0, -0.8] };

function runCmd(cmd) {
  switch (cmd?.type) {
    case "expresar":
      cancelTimeline();
      expresar(cmd.expresion, cmd.intensidad ?? 1, cmd.transicionMs ?? 400);
      if (cmd.duracionMs > 0 && userExpr) {
        const tok = tlToken;
        schedule(performance.now() + cmd.duracionMs, () => {
          if (tok === tlToken) expresar("neutral", 1, Math.min(900, cmd.transicionMs ?? 600));
        });
      }
      break;
    case "gesto":
      addGesto(cmd.gesto, cmd.lado, cmd.veces);
      break;
    case "mirar": {
      let x = Number(cmd.x);
      let y = Number(cmd.y);
      const o = Object.hasOwn(OBJETIVOS, cmd.objetivo) ? OBJETIVOS[cmd.objetivo] : null;
      if (o) [x, y] = o;
      if (!Number.isFinite(x)) x = to.mirarX;
      if (!Number.isFinite(y)) y = to.mirarY;
      const v = { mirarX: x, mirarY: y };
      if (cmd.cabeza) {
        v.cabezaGiro = x * 0.6;
        v.cabezaInclinacion = y * 0.5;
      }
      setTarget(v, 350, true);
      gazeFixed = true;
      break;
    }
    case "ajustar":
      cancelTimeline();
      setTarget(cmd.ajustes || {}, cmd.transicionMs ?? 300, true);
      userExpr = true;
      break;
    case "secuencia": {
      cancelTimeline();
      const pasos = Array.isArray(cmd.pasos) ? cmd.pasos.slice(0, 60) : [];
      const reps = clamp(Math.round(cmd.repetir || 1), 1, 20);
      const tok = tlToken;
      let at = performance.now();
      for (let r = 0; r < reps; r++) {
        for (const p of pasos) {
          const ms = clamp(Number(p.ms) || 500, 50, 60000);
          schedule(at, () => {
            if (tok !== tlToken) return;
            if (p.expresion) expresar(p.expresion, p.intensidad ?? 1, Math.min(ms, 450));
            if (p.ajustes) {
              setTarget(p.ajustes, Math.min(ms, 350), true);
              userExpr = true;
            }
            if (p.gesto) addGesto(p.gesto, p.lado, 1);
          });
          at += ms;
        }
      }
      break;
    }
  }
}

function runTimeline(now) {
  while (timeline.length && timeline[0].at <= now) timeline.shift().fn();
}

// ── Voz: boca ───────────────────────────────────────────
function gainAt(now) {
  const e = speech.energy;
  if (!e.length || speech.dur <= 0) return 0.55 + 0.35 * Math.sin((now - speech.t0) / 1000 * 13);
  const t = clamp((now - speech.t0) / speech.dur);
  const pos = t * (e.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = e[i] ?? 0;
  const b = e[Math.min(i + 1, e.length - 1)] ?? 0;
  return a + (b - a) * f;
}

function speechStep(now, dt) {
  let jawT = 0;
  let wideT = 0;
  let roundT = 0;
  if (speech.on) {
    const fin = speech.dur > 0 ? speech.dur : 15000;
    if (now - speech.t0 > fin + 300) speech.on = false;
    else {
      const gain = clamp(gainAt(now) * 1.15);
      const ph = (now - speech.t0) / 1000;
      // Las bandas son la forma media de la locución (fija): el visema cambia con el tiempo
      // y se inclina hacia «iii» (agudos) o «ooo» (graves) según ese centroide.
      const noise = 0.5 * Math.sin(ph * 11.3 + speech.seed) + 0.5 * Math.sin(ph * 17.9 + speech.seed * 2.1);
      const v = clamp(0.1 + speech.cb * 0.7 + 0.55 * noise);
      roundT = clamp((0.45 - v) / 0.3) * gain;
      wideT = clamp((v - 0.5) / 0.3) * gain;
      jawT = Math.pow(clamp((gain - 0.08) * 1.7), 0.9) * 0.9 * (1 - 0.5 * wideT) * (1 - 0.35 * roundT);
    }
  }
  const k = (cur, tgt) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? 0.045 : 0.13)));
  speech.jaw = k(speech.jaw, jawT);
  speech.wide = k(speech.wide, wideT);
  speech.round = k(speech.round, roundT);
  speech.lift = k(speech.lift, jawT);
}

// ── Cabeza: forma y superficie ──────────────────────────
const AX = 0.9;
const YM = -0.56; // línea de la boca
const _p = { x: 0, y: 0, z: 0 };

/** Cabeza ovoide con mandíbula estrecha: dirección unitaria → punto. */
function headP(dx, dy, dz, o) {
  const t = sstep(0.1, -1, dy);
  const n = 1 - 0.2 * Math.pow(t, 1.15);
  o.x = AX * dx * n;
  o.y = dy * (1.12 - 0.1 * sstep(-0.6, 0.6, dy));
  o.z = dz * (0.99 - 0.07 * sstep(-0.4, 0.6, dz)) * n;
  return o;
}

/** z de la piel en reposo para un (x, y) de la cara, invirtiendo `headP` por iteración. */
function zAt(x, y) {
  let dx = x / AX;
  let dy = y / 1.1;
  for (let i = 0; i < 7; i++) {
    const m0 = dx * dx + dy * dy;
    if (m0 > 0.985) {
      const k = Math.sqrt(0.985 / m0);
      dx *= k;
      dy *= k;
    }
    headP(dx, dy, Math.sqrt(Math.max(0.0004, 1 - dx * dx - dy * dy)), _p);
    dx += ((x - _p.x) / AX) * 0.85;
    dy += ((y - _p.y) / 1.1) * 0.85;
  }
  const m = dx * dx + dy * dy;
  if (m > 0.985) {
    const k = Math.sqrt(0.985 / m);
    dx *= k;
    dy *= k;
  }
  return headP(dx, dy, Math.sqrt(Math.max(0.0004, 1 - dx * dx - dy * dy)), _p).z;
}

/** Peso de la mandíbula (0 arriba de la boca, 1 en la barbilla). */
const jawW = (y, z) => sstep(YM + 0.12, YM - 0.28, y) * sstep(-0.1, 0.5, z);

// Deformación viva de la cara (la fijan los parámetros cada fotograma).
const DEF = { jaw: 0, puff: 0, smL: 0, smR: 0 };

/** Abultamiento de mejillas: inflar y subir con la sonrisa. */
function bulge(x, y) {
  const g = Math.exp(-(((Math.abs(x) - 0.52) ** 2) / 0.05 + ((y + 0.3) ** 2) / 0.08));
  return g * (0.1 * DEF.puff + 0.028 * Math.max(0, x < 0 ? DEF.smL : DEF.smR));
}

/** z de la piel ya deformada en (x, y) (mismo cálculo que los vértices de la cabeza). */
function surf(x, y) {
  let yr = y;
  let w = 0;
  if (DEF.jaw > 0.0005) {
    // Punto de reposo que acaba en `y` tras bajar la mandíbula (bisección: la función es creciente).
    let lo = y;
    let hi = y + DEF.jaw;
    for (let i = 0; i < 12; i++) {
      yr = (lo + hi) / 2;
      if (yr - DEF.jaw * jawW(yr, 0.8) < y) lo = yr;
      else hi = yr;
    }
    yr = (lo + hi) / 2;
    w = jawW(yr, 0.8);
  }
  return zAt(x, yr) - 0.35 * DEF.jaw * w + bulge(x, y);
}

/** Normal aproximada de la piel (elipsoide): suficiente para iluminar los labios. */
function surfN(x, y, z, o) {
  const nx = x / (AX * AX);
  const ny = y / 1.25;
  const nz = z / 0.87;
  const l = Math.hypot(nx, ny, nz) || 1;
  o[0] = nx / l;
  o[1] = ny / l;
  o[2] = nz / l;
}

// ── Cuadrículas dinámicas sobre la superficie ───────────
/** Malla de `rows × cols` vértices cuyos puntos 2D (x, y) se proyectan sobre la piel. */
class Grid {
  constructor(rows, cols, mat, opts = {}) {
    this.rows = rows;
    this.cols = cols;
    this.loop = !!opts.loop;
    const n = rows * cols;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    if (opts.lit) {
      this.nor = new Float32Array(n * 3);
      g.setAttribute("normal", new THREE.BufferAttribute(this.nor, 3));
    }
    if (opts.attr) {
      this.extra = new Float32Array(n * opts.attr);
      g.setAttribute("aEye", new THREE.BufferAttribute(this.extra, opts.attr));
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < (this.loop ? cols : cols - 1); c++) {
        const a = r * cols + c;
        const b = r * cols + ((c + 1) % cols);
        const d = (r + 1) * cols + c;
        const e = (r + 1) * cols + ((c + 1) % cols);
        idx.push(a, b, d, b, e, d);
      }
    }
    g.setIndex(idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    if (opts.order) this.mesh.renderOrder = opts.order;
    this.xy = new Float32Array(n * 2);
  }
  /** `xy` ya está relleno; `lift` puede ser número o función (índice de fila). */
  commit(lift, lat) {
    const { pos, xy, nor } = this;
    const n = this.rows * this.cols;
    const nn = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const x = xy[i * 2];
      const y = xy[i * 2 + 1];
      const l = typeof lift === "function" ? lift(Math.floor(i / this.cols)) : lift;
      const z = surf(x, y) + l;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      if (nor) {
        surfN(x, y, z, nn);
        const lx = lat ? lat[i * 2] : 0;
        const ly = lat ? lat[i * 2 + 1] : 0;
        const m = Math.hypot(nn[0] + lx, nn[1] + ly, nn[2]) || 1;
        nor[i * 3] = (nn[0] + lx) / m;
        nor[i * 3 + 1] = (nn[1] + ly) / m;
        nor[i * 3 + 2] = nn[2] / m;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    if (nor) this.geo.attributes.normal.needsUpdate = true;
    if (this.extra) this.geo.attributes.aEye.needsUpdate = true;
  }
  /** Cinta: dos filas a ambos lados de un camino 2D con grosor por punto. */
  ribbon(path, widths, lift) {
    const n = path.length / 2;
    const xy = this.xy;
    for (let k = 0; k < n; k++) {
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(n - 1, k + 1);
      let tx = path[k1 * 2] - path[k0 * 2];
      let ty = path[k1 * 2 + 1] - path[k0 * 2 + 1];
      const l = Math.hypot(tx, ty) || 1;
      tx /= l;
      ty /= l;
      const h = widths[k] / 2;
      xy[k * 2] = path[k * 2] + ty * h;
      xy[k * 2 + 1] = path[k * 2 + 1] - tx * h;
      xy[(n + k) * 2] = path[k * 2] - ty * h;
      xy[(n + k) * 2 + 1] = path[k * 2 + 1] + tx * h;
    }
    this.commit(lift);
  }
}

// ── Escena ──────────────────────────────────────────────
let renderer = null;
let scene;
let camera;
let pivot;
let head;
let mats = {};
let envTex = null;
let pmrem = null;
const parts = {};
let themeKey = "";

/** Color de un token del tema; el lienzo no entiende `var()`. */
function token(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function colorOf(str, fb) {
  const c = new THREE.Color();
  try {
    c.set(str);
  } catch {
    c.set(fb);
  }
  return c;
}

const SKIN = "#f3e5dc";

function applyTheme() {
  themeKey = document.body.dataset.theme || "";
  const accent = colorOf(token("--neon", "#00e5ff"), "#00e5ff");
  const magenta = colorOf(token("--magenta", "#ff2d95"), "#ff2d95");
  const skin = new THREE.Color(SKIN).lerp(accent, 0.06);
  mats.skin.color.copy(skin);
  mats.neck.color.copy(skin).multiplyScalar(0.82);
  mats.ear.color.copy(skin).multiplyScalar(0.96);
  mats.hair.color.set("#3b4352").lerp(accent, 0.015);
  mats.brow.color.set("#2b313c");
  mats.accent.color.copy(accent);
  mats.bow.color.copy(accent).multiplyScalar(0.8);
  mats.bow.emissive.copy(accent).multiplyScalar(0.18);
  mats.halo.color.copy(accent);
  mats.blush.color.set("#ff8f8f").lerp(magenta, 0.25);
  mats.heart.color.copy(magenta);
  mats.lip.color.set("#d98486").lerp(magenta, 0.12);
  const iris = accent.clone();
  mats.eye.uniforms.uIrisO.value.copy(iris).multiplyScalar(0.55);
  mats.eye.uniforms.uIrisI.value.copy(iris).lerp(new THREE.Color("#ffffff"), 0.3);
  parts.rimL.color.copy(accent);
  parts.rimR.color.copy(accent).lerp(magenta, 0.35);
  buildEnv(accent);
}

/** Entorno de estudio (softboxes) para los reflejos de la porcelana y el brillo del pelo. */
function buildEnv(accent) {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color("#2a2f3a"), side: THREE.BackSide })));
  const box = (c, k, w, h, p) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...p);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  box("#fff4ea", 7, 9, 7, [-8, 6, 8]);
  box("#e8f0ff", 2.2, 7, 9, [9, 1, 7]);
  box("#ffffff", 3, 12, 4, [0, 10, 3]);
  box(accent, 3, 8, 12, [-10, 2, -8]);
  box(accent, 2.2, 8, 12, [10, 2, -8]);
  const old = envTex;
  envTex = pmrem.fromScene(env, 0.04).texture;
  scene.environment = envTex;
  if (old) old.dispose();
  env.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });
}

function radialTexture(stops) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [o, a] of stops) grad.addColorStop(o, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const EYE_VERT = `
attribute vec4 aEye;
varying vec4 vEye;
void main(){ vEye = aEye; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Ojo procedural: esclerótica, iris con fibras, pupila, reflejos fijos y sombra del párpado.
const EYE_FRAG = `
uniform vec2 uGaze; uniform float uPupil; uniform float uShine; uniform float uWet; uniform float uSide;
uniform vec3 uSclera; uniform vec3 uIrisO; uniform vec3 uIrisI; uniform vec3 uPupilC;
varying vec4 vEye;
float disc(vec2 p, vec2 c, float r, float soft){ return 1.0 - smoothstep(r - soft, r + soft, length(p - c)); }
void main(){
  vec2 ps = vec2(vEye.x * uSide, vEye.y);
  vec2 q = ps - uGaze;
  float r = length(q);
  float R = 0.74;
  vec3 col = uSclera * (1.0 - 0.26 * smoothstep(0.5, 1.05, abs(vEye.x)));
  float a = atan(q.y, q.x);
  float fib = 0.5 + 0.5 * sin(a * 26.0 + r * 5.0) * sin(a * 9.0 - r * 3.0);
  vec3 iris = mix(uIrisI, uIrisO, smoothstep(0.1, R, r));
  iris *= 0.86 + 0.26 * fib * smoothstep(0.12, 0.5, r);
  iris = mix(iris, uIrisO * 0.3, smoothstep(R - 0.13, R, r) * 0.85);
  iris += uIrisI * 0.28 * smoothstep(-0.1, 0.65, -q.y / R) * (1.0 - smoothstep(0.2, R, r));
  float irisM = 1.0 - smoothstep(R - 0.02, R + 0.012, r);
  col = mix(col, iris, irisM);
  float pr = 0.30 * (1.0 + 0.55 * uPupil);
  col = mix(col, uPupilC, 1.0 - smoothstep(pr - 0.02, pr + 0.012, r));
  col *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.2, vEye.z)) * (0.55 + 0.45 * irisM);
  float wetBand = (1.0 - smoothstep(0.0, 0.11, vEye.w)) * uWet;
  col = mix(col, vec3(0.78, 0.9, 1.0), wetBand * 0.6);
  float s = uShine;
  col = mix(col, vec3(1.0), disc(ps, vec2(-0.27, 0.3), 0.15 * (0.85 + 0.35 * s), 0.025) * 0.97);
  col = mix(col, vec3(1.0), disc(ps, vec2(0.25, -0.27), 0.065 * (0.8 + 0.5 * s), 0.02) * 0.85);
  col = mix(col, vec3(1.0), disc(ps, vec2(0.02, 0.43), 0.045, 0.02) * s * 0.9);
  col = mix(col, vec3(1.0), disc(ps, vec2(-0.45, -0.08), 0.04, 0.02) * s * 0.8);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(27, 0.8, 0.1, 50);
  camera.position.set(0, -0.25, 7.4);
  camera.lookAt(0, -0.3, 0);

  pmrem = new THREE.PMREMGenerator(renderer);

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const flat = (o) => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, ...o });
  mats.skin = new THREE.MeshPhysicalMaterial({ color: SKIN, roughness: 0.5, clearcoat: 0.18, clearcoatRoughness: 0.45, envMapIntensity: 0.9 });
  mats.neck = std({ color: SKIN, roughness: 0.7 });
  mats.ear = std({ color: SKIN, roughness: 0.55 });
  mats.hair = new THREE.MeshPhysicalMaterial({ vertexColors: true, color: "#3b4352", roughness: 0.5, metalness: 0.15, clearcoat: 0.12, clearcoatRoughness: 0.5 });
  mats.brow = flat({ color: "#2b313c" });
  mats.lash = flat({ color: "#1d222b" });
  mats.lowLash = flat({ color: "#6b4b50", transparent: true, opacity: 0.55 });
  mats.crease = flat({ color: "#a8746f", transparent: true, opacity: 0.3 });
  mats.accent = new THREE.MeshBasicMaterial({ color: "#00e5ff", toneMapped: false });
  mats.bow = std({ color: "#00b5cc", roughness: 0.4, emissive: "#003844" });
  mats.suit = std({ color: "#232a36", roughness: 0.6, metalness: 0.1 });
  mats.shirt = std({ color: "#eef1f5", roughness: 0.7 });
  mats.lip = new THREE.MeshPhysicalMaterial({ color: "#d98486", roughness: 0.34, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  mats.mouth = new THREE.MeshBasicMaterial({ color: "#3a1420", side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  mats.tongue = flat({ color: "#d8707e" });
  mats.teeth = flat({ color: "#efe9e1" });
  mats.nostril = flat({ color: "#6b4650", transparent: true, opacity: 0.5 });
  mats.blush = new THREE.MeshBasicMaterial({ color: "#ff8f8f", map: radialTexture([[0, 0.95], [0.45, 0.45], [1, 0]]), transparent: true, depthWrite: false, opacity: 0.2, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  mats.tear = flat({ color: "#bfe3ff", transparent: true, opacity: 0 });
  mats.heart = new THREE.MeshBasicMaterial({ color: "#ff2d95", transparent: true, opacity: 0, depthTest: false, toneMapped: false });
  mats.halo = new THREE.MeshBasicMaterial({ color: "#00e5ff", map: radialTexture([[0, 0.55], [0.5, 0.18], [1, 0]]), transparent: true, depthWrite: false, opacity: 0.2, toneMapped: false });
  mats.eye = new THREE.ShaderMaterial({
    vertexShader: EYE_VERT,
    fragmentShader: EYE_FRAG,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uGaze: { value: new THREE.Vector2() },
      uPupil: { value: 0 },
      uShine: { value: 0.3 },
      uWet: { value: 0 },
      uSide: { value: 1 },
      uSclera: { value: new THREE.Color("#fbf8f4") },
      uIrisO: { value: new THREE.Color("#006a78") },
      uIrisI: { value: new THREE.Color("#7ff1ff") },
      uPupilC: { value: new THREE.Color("#070b14") },
    },
  });

  // Luces: principal cálida, relleno frío y dos contraluces con el acento del tema.
  scene.add(new THREE.HemisphereLight("#ffffff", "#8a7f86", 0.3));
  const key = new THREE.DirectionalLight("#fff1e4", 2.6);
  key.position.set(-3, 4, 6);
  const fill = new THREE.DirectionalLight("#dfe9ff", 0.6);
  fill.position.set(4, -1, 5);
  parts.rimL = new THREE.DirectionalLight("#00e5ff", 1.3);
  parts.rimL.position.set(-5, 2, -4);
  parts.rimR = new THREE.DirectionalLight("#00e5ff", 1.1);
  parts.rimR.position.set(5, 2, -4);
  scene.add(key, fill, parts.rimL, parts.rimR);
  scene.environmentIntensity = 0.5;

  // Halo detrás de la cabeza.
  parts.halo = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 5.4), mats.halo);
  parts.halo.position.set(0, -0.2, -2.2);
  scene.add(parts.halo);

  // Torso con traje, camisa y pajarita (el detalle de mayordomo).
  const torso = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), mats.suit);
  torso.scale.set(1.75, 0.85, 0.95);
  torso.position.set(0, -2.25, -0.1);
  const shirt = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 0.55, 32, 1, true), mats.shirt);
  shirt.position.set(0, -1.42, 0);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.3, 28), mats.neck);
  neck.position.set(0, -0.98, -0.1);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.085, 12, 40), mats.shirt);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, -1.3, 0);
  collar.scale.set(1, 1.05, 1);
  const bow = new THREE.Group();
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), mats.bow);
  const wingGeo = new THREE.ConeGeometry(0.17, 0.3, 4);
  const wl = new THREE.Mesh(wingGeo, mats.bow);
  wl.rotation.z = Math.PI / 2;
  wl.position.x = -0.17;
  const wr = new THREE.Mesh(wingGeo, mats.bow);
  wr.rotation.z = -Math.PI / 2;
  wr.position.x = 0.17;
  wl.scale.z = wr.scale.z = 0.5;
  bow.add(knot, wl, wr);
  bow.position.set(0, -1.5, 0.74);
  parts.torso = torso;
  scene.add(torso, shirt, neck, collar, bow);

  // Pivote del cuello: la cabeza gira y se inclina desde aquí.
  pivot = new THREE.Group();
  pivot.position.set(0, -1.1, 0);
  head = new THREE.Group();
  head.position.set(0, 1.1, 0);
  pivot.add(head);
  scene.add(pivot);

  buildHead();
  buildFeatures();
  applyTheme();
}

function buildHead() {
  // Rejilla latitud/longitud con polos únicos: sin costura, así computeVertexNormals queda liso.
  const L = 56;
  const M = 72;
  const n = (L - 1) * M + 2;
  const rest = new Float32Array(n * 3);
  const pos = new Float32Array(n * 3);
  const put = (i, dx, dy, dz) => {
    headP(dx, dy, dz, _p);
    rest[i * 3] = _p.x;
    rest[i * 3 + 1] = _p.y;
    rest[i * 3 + 2] = _p.z;
  };
  put(0, 0, 1, 0);
  for (let i = 1; i < L; i++) {
    const th = (Math.PI * i) / L;
    for (let j = 0; j < M; j++) {
      const ph = (2 * Math.PI * j) / M;
      put(1 + (i - 1) * M + j, Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph));
    }
  }
  put(n - 1, 0, -1, 0);
  const idx = [];
  const ring = (i, j) => 1 + (i - 1) * M + (j % M);
  for (let j = 0; j < M; j++) {
    idx.push(0, ring(1, j + 1), ring(1, j));
    idx.push(n - 1, ring(L - 1, j), ring(L - 1, j + 1));
  }
  for (let i = 1; i < L - 1; i++) {
    for (let j = 0; j < M; j++) idx.push(ring(i, j), ring(i, j + 1), ring(i + 1, j), ring(i, j + 1), ring(i + 1, j + 1), ring(i + 1, j));
  }
  // Los triángulos salen en sentido horario visto desde fuera: se invierten.
  for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  const g = new THREE.BufferGeometry();
  pos.set(rest);
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const skull = new THREE.Mesh(g, mats.skin);
  skull.frustumCulled = false;
  head.add(skull);
  // Vértices que se mueven (mandíbula y mejillas).
  const dyn = [];
  for (let i = 0; i < n; i++) {
    const x = rest[i * 3];
    const y = rest[i * 3 + 1];
    const z = rest[i * 3 + 2];
    if (jawW(y, z) > 0.001 || (Math.abs(x) > 0.2 && Math.abs(x) < 0.95 && y < 0.2 && y > -0.8 && z > 0)) dyn.push(i);
  }
  parts.skull = { g, rest, pos, dyn, key: "" };

  // Pelo peinado hacia atrás, con tupé: casquete sobre la cabeza.
  const HL = 30;
  const HM = 72;
  const hp = new Float32Array((HL + 1) * HM * 3);
  const hc = new Float32Array((HL + 1) * HM * 3);
  const hidx = [];
  for (let i = 0; i <= HL; i++) {
    for (let j = 0; j < HM; j++) {
      const ph = (2 * Math.PI * j) / HM;
      const c = Math.cos(ph);
      const thMax = 1.4 + c * (c > 0 ? -0.4 : -0.5);
      const th = (thMax * i) / HL;
      const dx = Math.sin(th) * Math.sin(ph);
      const dy = Math.cos(th);
      const dz = Math.sin(th) * Math.cos(ph);
      headP(dx, dy, dz, _p);
      const edge = sstep(0, 0.16, thMax - th);
      let s = 1.014 + 0.032 * edge;
      // Tupé: abultamiento delante, un poco a la izquierda de pantalla.
      s += 0.16 * Math.exp(-(((ph > Math.PI ? ph - 2 * Math.PI : ph) + 0.35) ** 2) / 0.18 - ((th - 0.62) ** 2) / 0.09);
      const o = (i * HM + j) * 3;
      hp[o] = _p.x * s;
      hp[o + 1] = _p.y * s + 0.02 * edge;
      hp[o + 2] = _p.z * s;
      // Mechones: bandas suaves que parten del tupé y se peinan hacia atrás.
      const k = 0.82 + 0.18 * Math.sin(ph * 34 + th * 4) * (0.6 + 0.4 * Math.sin(ph * 11)) + 0.05 * edge;
      hc[o] = hc[o + 1] = hc[o + 2] = k;
    }
  }
  for (let i = 0; i < HL; i++) {
    for (let j = 0; j < HM; j++) {
      const a = i * HM + j;
      const b = i * HM + ((j + 1) % HM);
      const d = (i + 1) * HM + j;
      const e = (i + 1) * HM + ((j + 1) % HM);
      hidx.push(a, d, b, b, d, e);
    }
  }
  const hg = new THREE.BufferGeometry();
  hg.setAttribute("position", new THREE.BufferAttribute(hp, 3));
  hg.setAttribute("color", new THREE.BufferAttribute(hc, 3));
  hg.setIndex(hidx);
  hg.computeVertexNormals();
  const hair = new THREE.Mesh(hg, mats.hair);
    head.add(hair);

  // Orejas con un anillo luminoso: sensores de androide elegante.
  parts.rings = [];
  for (const sg of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mats.ear);
    ear.scale.set(0.09, 0.24, 0.15);
    ear.position.set(sg * 0.9, -0.12, -0.06);
    const ringM = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.022, 10, 36), mats.accent.clone());
    ringM.rotation.y = Math.PI / 2;
    ringM.position.set(sg * 0.985, -0.12, -0.06);
    head.add(ear, ringM);
    parts.rings.push(ringM);
  }
}

function buildFeatures() {
  const A = 0.215;
  const NU = 16;
  const NV = 6;
  parts.eyes = [-1, 1].map((sg) => {
    const grid = new Grid(NV + 1, NU + 1, mats.eye.clone(), { attr: 4, order: 1 });
    head.add(grid.mesh);
    const lash = new Grid(2, NU + 3, mats.lash, { order: 3 });
    const lowLash = new Grid(2, NU + 1, mats.lowLash, { order: 3 });
    const crease = new Grid(2, NU + 1, mats.crease.clone(), { order: 2 });
    const tear = new Grid(2, 8, mats.tear.clone(), { order: 4 });
    head.add(lash.mesh, lowLash.mesh, crease.mesh, tear.mesh);
    return { sg, cx: sg * 0.37, cy: -0.02, A, grid, lash, lowLash, crease, tear, NU, NV, bead: { x: 0, y: 0 } };
  });
  parts.brows = [-1, 1].map((sg) => {
    const g = new Grid(2, 14, mats.brow, { order: 3 });
    head.add(g.mesh);
    return { sg, g };
  });

  // Nariz sencilla: bola, puente y fosas.
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mats.skin);
  nose.scale.set(0.085, 0.078, 0.08);
  head.add(nose);
  parts.nose = nose;
  parts.nostrils = [-1, 1].map((sg) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(1, 12), mats.nostril);
    m.scale.set(0.017, 0.011, 1);
    m.renderOrder = 3;
    head.add(m);
    return { sg, m };
  });
  parts.wrinkles = [0, 1, 2].map((i) => {
    const g = new Grid(2, 6, mats.crease.clone(), { order: 3 });
    head.add(g.mesh);
    return g;
  });

  // Rubor.
  parts.blush = [-1, 1].map((sg) => {
    const g = new Grid(8, 8, mats.blush, { order: 1 });
    const w = 0.4;
    const h = 0.3;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        g.xy[(r * 8 + c) * 2] = sg * 0.52 + (c / 7 - 0.5) * w;
        g.xy[(r * 8 + c) * 2 + 1] = -0.3 + (r / 7 - 0.5) * h;
      }
    }
    // Coordenadas de textura: se rellenan una vez.
    const uv = new Float32Array(64 * 2);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { uv[(r * 8 + c) * 2] = c / 7; uv[(r * 8 + c) * 2 + 1] = r / 7; }
    g.geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    head.add(g.mesh);
    return g;
  });

  // Boca: interior, lengua, dientes y labios (anillo de tres filas).
  const K = 14;
  parts.K = K;
  parts.mouthInt = new Grid(2, K + 1, mats.mouth, { order: 1 });
  parts.tongue = new Grid(2, 11, mats.tongue, { order: 2 });
  parts.teethU = new Grid(2, 11, mats.teeth, { order: 3 });
  parts.teethL = new Grid(2, 11, mats.teeth, { order: 3 });
  parts.lips = new Grid(3, 2 * K, mats.lip, { loop: true, lit: true, order: 4 });
  parts.lips.mesh.material.side = THREE.FrontSide;
  head.add(parts.mouthInt.mesh, parts.tongue.mesh, parts.teethU.mesh, parts.teethL.mesh, parts.lips.mesh);

  // Corazones (beso y amor).
  const sh = new THREE.Shape();
  sh.moveTo(0, -0.5);
  sh.bezierCurveTo(-0.9, 0.05, -0.55, 0.8, 0, 0.35);
  sh.bezierCurveTo(0.55, 0.8, 0.9, 0.05, 0, -0.5);
  const hg = new THREE.ShapeGeometry(sh, 12);
  parts.hearts = [];
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(hg, mats.heart.clone());
    m.visible = false;
    m.renderOrder = 10;
    head.add(m);
    parts.hearts.push({ m, t0: -1, x: 0, dx: 0 });
  }
}

function spawnHeart(now, x = 0.1, y = -0.4) {
  const h = parts.hearts.find((q) => q.t0 < 0);
  if (!h) return;
  h.t0 = now;
  h.x = x;
  h.y = y;
  h.dx = rand(-0.25, 0.35);
  h.m.visible = true;
}

// ── Cálculo por fotograma ───────────────────────────────
const F = zero(); // valores finales

/** Combina expresión, vida, voz y gestos en `F`. */
function compose(now, dt) {
  // Expresión actual (tween).
  const e = ease(clamp((now - tw.t0) / tw.dur));
  for (const k of KEYS) base[k] = from[k] + (to[k] - from[k]) * e;

  // Gestos activos.
  const add = zero();
  add.blink = 0;
  add.breath = 0;
  for (let i = gestures.length - 1; i >= 0; i--) {
    const g = gestures[i];
    const u = (now - g.t0) / g.dur;
    if (u >= 1) {
      gestures.splice(i, 1);
      continue;
    }
    g.def.fn((u * g.n) % 1, g.side, add);
    if (g.def.fx && !g.fx && u > g.def.fx / g.n) {
      g.fx = true;
      spawnHeart(now, g.side * 0.05 + 0.08, -0.62);
    }
  }

  // Vida: parpadeo, microsacádicos y respiración.
  if (!life.nextBlink) life.nextBlink = now + rand(1200, 3000);
  if (life.blinkT0 < 0 && now >= life.nextBlink) {
    life.blinkT0 = now;
    life.double = Math.random() < 0.18;
  }
  let blink = 0;
  if (life.blinkT0 >= 0) {
    const u = (now - life.blinkT0) / 170;
    if (u >= 1) {
      life.blinkT0 = -1;
      life.nextBlink = life.double ? now + 120 : now + rand(2400, 5800);
      life.double = false;
    } else blink = u < 0.4 ? ease(u / 0.4) : ease((1 - u) / 0.6);
  }
  blink = Math.max(blink, add.blink);
  if (now >= life.nextSac) {
    const calm = speech.on ? 0.6 : 1;
    life.sacTX = rand(-0.14, 0.14) * calm;
    life.sacTY = rand(-0.1, 0.1) * calm;
    life.nextSac = now + rand(500, actCount > 0 ? 1100 : 2600);
  }
  const ks = 1 - Math.exp(-dt / 0.07);
  life.sacX += (life.sacTX - life.sacX) * ks;
  life.sacY += (life.sacTY - life.sacY) * ks;
  const t = now / 1000;
  const breath = Math.sin((t * Math.PI * 2) / 4.4);

  // Aire pensativo con agentes trabajando, solo sin expresión pedida.
  const thinkT = actCount > 0 && !userExpr && !speech.on ? 1 : 0;
  life.think += (thinkT - life.think) * (1 - Math.exp(-dt / 0.55));
  const th = life.think;

  for (const k of KEYS) F[k] = base[k] + add[k];
  if (!gazeFixed) {
    F.mirarX += life.sacX + th * (-0.32 + 0.12 * Math.sin(t * 0.7));
    F.mirarY += life.sacY + th * (0.3 + 0.06 * Math.sin(t * 0.9));
  } else {
    F.mirarX += life.sacX * 0.2;
    F.mirarY += life.sacY * 0.2;
  }
  F.cejaD += th * 0.22;
  F.cabezaLadeo += th * 0.12 + 0.03 * Math.sin(t * 0.29 + 2);
  F.cabezaGiro += 0.04 * Math.sin(t * 0.37) + 0.02 * Math.sin(t * 0.71 + 1) + th * -0.06;
  F.cabezaInclinacion += 0.018 * breath + 0.012 * Math.sin(t * 0.5 + 1);

  // Voz: la boca se suma a la de la expresión (la sonrisa no se pierde).
  speechStep(now, dt);
  const sj = speech.jaw;
  F.bocaAbierta += sj;
  F.bocaAncha += speech.wide * 0.9;
  F.bocaRedonda += speech.round * 0.85;
  F.labiosApretados *= 1 - clamp(sj * 2.2);
  F.cejaI += sj * 0.12;
  F.cejaD += sj * 0.12;
  F.cabezaInclinacion += sj * 0.07;
  F.cabezaLadeo += 0.02 * Math.sin(t * 2.1) * sj;

  for (const k of KEYS) F[k] = clamp(F[k], RANGE[k][0], RANGE[k][1]);
  F.blink = blink;
  F.breath = breath * (1 + add.breath);
  F.glow = clamp(sj * 1.2 + (actCount > 0 ? 0.35 + 0.25 * Math.sin(t * (actStreaming ? 5 : 2.4)) : 0));
  return F;
}

// ── Pintado de rasgos ───────────────────────────────────
let lastBase = null;

function updateHead() {
  const s = parts.skull;
  const k = `${DEF.jaw.toFixed(3)}|${DEF.puff.toFixed(3)}|${DEF.smL.toFixed(3)}|${DEF.smR.toFixed(3)}`;
  if (k === s.key) return;
  s.key = k;
  const { rest, pos, dyn } = s;
  for (const i of dyn) {
    const x = rest[i * 3];
    const y = rest[i * 3 + 1];
    const z = rest[i * 3 + 2];
    const w = jawW(y, z);
    pos[i * 3] = x;
    pos[i * 3 + 1] = y - DEF.jaw * w;
    pos[i * 3 + 2] = z - 0.35 * DEF.jaw * w + bulge(x, y);
  }
  s.g.attributes.position.needsUpdate = true;
  s.g.computeVertexNormals();
}

function updateEye(e, P, now) {
  const left = e.sg < 0;
  const p = left ? P.parpadoI : P.parpadoD;
  let o = p < 0 ? 0.62 * (1 + p) : 0.62 + 0.5 * p;
  o *= 1 - P.blink;
  const op = o / 0.62;
  const smile = Math.max(0, (P.sonrisaI + P.sonrisaD) / 2);
  const lift = clamp(0.55 * P.entorna + 0.3 * smile + 0.3 * P.mejillas + 0.4 * P.nariz);
  const { A, cx, cy, NU, NV } = e;
  const g = e.grid;
  const gy = P.mirarY;
  const yu = new Float32Array(NU + 1);
  const yl = new Float32Array(NU + 1);
  for (let i = 0; i <= NU; i++) {
    const u = -1 + (2 * i) / NU;
    const s = Math.pow(Math.max(0, 1 - u * u), 0.7);
    const tilt = 0.16 * u;
    const el = -(0.62 - 0.95 * lift) * s + tilt + gy * 0.04 * s;
    const EU = 0.86 * (1 - 0.22 * P.entorna) * s + tilt + gy * 0.1 * s;
    const eu = Math.max(el, el + (EU - el) * op);
    yu[i] = cy + A * eu;
    yl[i] = cy + A * el;
    for (let j = 0; j <= NV; j++) {
      // Fila 0 abajo, fila NV arriba (el orden no importa: el material es de doble cara).
      const v = j / NV;
      const y = yl[i] + (yu[i] - yl[i]) * v;
      const n = j * (NU + 1) + i;
      g.xy[n * 2] = cx + e.sg * A * u;
      g.xy[n * 2 + 1] = y;
      g.extra[n * 4] = u;
      g.extra[n * 4 + 1] = (y - cy) / A;
      g.extra[n * 4 + 2] = ((yu[i] - y) / A);
      g.extra[n * 4 + 3] = ((y - yl[i]) / A);
    }
  }
  g.commit(0.008);
  const U = g.mesh.material.uniforms;
  // La mirada se mueve en pantalla; el ojo ya está orientado «hacia fuera».
  U.uGaze.value.set(P.mirarX * 0.34, P.mirarY * 0.3);
  U.uSide.value = e.sg;
  U.uPupil.value = P.pupila;
  U.uShine.value = 0.3 + P.brillo * 0.9;
  U.uWet.value = Math.max(P.lagrimas, P.brillo * 0.25);
  U.uSclera.value.copy(mats.eye.uniforms.uSclera.value);
  U.uIrisO.value.copy(mats.eye.uniforms.uIrisO.value);
  U.uIrisI.value.copy(mats.eye.uniforms.uIrisI.value);
  U.uPupilC.value.copy(mats.eye.uniforms.uPupilC.value);

  // Pestañas superiores: línea gruesa en el párpado, más densa hacia fuera, con rabillo.
  const path = [];
  const w = [];
  for (let i = 0; i <= NU; i++) {
    const u = -1 + (2 * i) / NU;
    const th = A * (0.085 + 0.1 * Math.max(0, u)) * (0.85 + 0.15 * Math.min(1, op + 0.4));
    path.push(cx + e.sg * A * u, yu[i] + th / 2);
    w.push(th);
  }
  const yEnd = yu[NU];
  path.push(cx + e.sg * A * 1.12, yEnd + A * (0.1 + 0.08 * clamp(op)) + 0.005, cx + e.sg * A * 1.26, yEnd + A * (0.2 + 0.14 * clamp(op)));
  w.push(A * 0.09, A * 0.04);
  e.lash.ribbon(path, w, 0.011);
  // Pestaña inferior, fina.
  const lp = [];
  const lw = [];
  for (let i = 0; i <= NU; i++) {
    const u = -1 + (2 * i) / NU;
    lp.push(cx + e.sg * A * u, yl[i] - A * 0.015);
    lw.push(A * 0.035 * (1 - u * u * 0.6));
  }
  e.lowLash.ribbon(lp, lw, 0.01);
  // Pliegue del párpado.
  const cp = [];
  const cw = [];
  for (let i = 0; i <= NU; i++) {
    const u = -1 + (2 * i) / NU;
    const s = Math.pow(Math.max(0, 1 - u * u), 0.7);
    cp.push(cx + e.sg * A * u * 1.02, yu[i] + A * (0.3 + 0.2 * clamp(op, 0, 1.4) * s));
    cw.push(A * 0.05 * s);
  }
  e.crease.ribbon(cp, cw, 0.007);
  e.crease.mesh.material.opacity = 0.35 * clamp(op * 1.6);

  // Lágrimas: un hilo por la mejilla con una gota que baja.
  const tl = P.lagrimas;
  e.tear.mesh.visible = tl > 0.02;
  if (tl > 0.02) {
    const tp = [];
    const tw2 = [];
    const x0 = cx + e.sg * A * 0.35;
    for (let i = 0; i < 8; i++) {
      const f = i / 7;
      const dropF = (now / 1000 * 0.45 + (e.sg > 0 ? 0.4 : 0)) % 1;
      tp.push(x0 + e.sg * 0.05 * f + e.sg * 0.015 * Math.sin(f * 3), yl[Math.round(NU * 0.35)] - 0.02 - f * 0.55);
      // La gota: el hilo se ensancha cerca de `dropF`.
      tw2.push(0.014 + 0.03 * Math.exp(-(((f - dropF) / 0.09) ** 2)) * tl);
    }
    e.tear.ribbon(tp, tw2, 0.014);
    e.tear.mesh.material.opacity = 0.6 * tl;
  }
}

function updateBrows(P) {
  for (const b of parts.brows) {
    const left = b.sg < 0;
    const r = left ? P.cejaI : P.cejaD;
    const inc = P.cejasInclina;
    const xin = b.sg * (0.1 - 0.06 * Math.max(0, -inc));
    const xout = b.sg * 0.6;
    const yin = 0.34 + 0.12 * r + 0.1 * inc - 0.015 * Math.max(0, -inc);
    const yout = 0.37 + 0.11 * r * 0.8 - 0.1 * inc + 0.02 * Math.max(0, -inc);
    const arch = 0.05 * (1 - 0.7 * Math.abs(inc)) + 0.02 * Math.max(0, r);
    const path = [];
    const w = [];
    for (let i = 0; i < 14; i++) {
      const f = i / 13;
      const x = lerp(xin, xout, f);
      const y = lerp(yin, yout, f) + arch * Math.sin(Math.PI * Math.pow(f, 0.85));
      path.push(x, y);
      w.push(0.042 * (1 - 0.7 * Math.pow(f, 1.6)) * (0.8 + 0.2 * Math.sin(Math.PI * Math.min(1, f * 2.4))) + 0.006);
    }
    b.g.ribbon(path, w, 0.012);
  }
}

function updateNose(P) {
  const y0 = -0.27 + 0.02 * P.nariz;
  const nz = surf(0, y0) + 0.03;
  parts.nose.position.set(0, y0, nz);
  parts.nose.scale.set(0.085 * (1 + 0.15 * P.nariz), 0.078 * (1 - 0.15 * P.nariz), 0.08);
  for (const n of parts.nostrils) {
    const x = n.sg * 0.043 * (1 + 0.15 * P.nariz);
    n.m.position.set(x, y0 - 0.052, surf(x, y0 - 0.052) + 0.012);
    n.m.rotation.set(-0.5, 0, n.sg * -0.3);
  }
  parts.wrinkles.forEach((g, i) => {
    const y = -0.05 + i * 0.045;
    const path = [];
    const w = [];
    for (let k = 0; k < 6; k++) {
      const f = k / 5 - 0.5;
      path.push(f * (0.16 - i * 0.03), y + 0.02 * Math.abs(f) * 4 - 0.015);
      w.push(0.01 * (1 - Math.abs(f)));
    }
    g.ribbon(path, w, 0.014);
    g.mesh.material.opacity = 0.5 * P.nariz;
    g.mesh.visible = P.nariz > 0.05;
  });
}

function updateBlush(P) {
  const a = 0.2 + 0.65 * P.rubor;
  for (const g of parts.blush) {
    g.commit(0.02);
    g.mesh.material.opacity = a;
  }
}

/** Boca: contornos superior e inferior → labios, interior, dientes y lengua. */
function updateMouth(P) {
  const K = parts.K;
  const dj = P.bocaAbierta;
  const red = P.bocaRedonda;
  const wide = P.bocaAncha;
  const press = P.labiosApretados;
  const smL = P.sonrisaI;
  const smR = P.sonrisaD;
  const jawD = DEF.jaw;
  const w0 = 0.27 * (1 + 0.3 * wide - 0.4 * red - 0.1 * press);
  const wL = w0 * (1 + 0.1 * smL);
  const wR = w0 * (1 + 0.1 * smR);
  const up = new Float32Array((K + 1) * 2);
  const lo = new Float32Array((K + 1) * 2);
  const gaps = new Float32Array(K + 1);
  for (let k = 0; k <= K; k++) {
    const s = -1 + (2 * k) / K;
    const x = s < 0 ? s * wL : s * wR;
    const c = 0.085 * (s < 0 ? Math.pow(-s, 2.2) * smL : Math.pow(s, 2.2) * smR);
    const yb = YM + c + 0.012 * s * s - 0.01 * press * (1 - s * s);
    const pr = Math.pow(Math.max(0, 1 - s * s), 0.72 - 0.22 * red);
    const bow = (0.012 * Math.exp(-(((Math.abs(s) - 0.28) / 0.2) ** 2)) - 0.005 * Math.exp(-((s / 0.08) ** 2))) * (1 - 0.8 * press) * (1 - 0.5 * red);
    let yu = yb + 0.004 + pr * (0.012 * dj + 0.075 * red) + bow;
    let yl = yb - 0.004 - 0.075 * red * pr - jawD * (0.25 + 0.75 * pr);
    if (yu - yl < 0.006 * pr + 0.002) yu = yl + 0.006 * pr + 0.002;
    up[k * 2] = lo[k * 2] = x;
    up[k * 2 + 1] = yu;
    lo[k * 2 + 1] = yl;
    gaps[k] = yu - yl;
  }
  const gap = gaps[K >> 1];

  // Anillo de labios: contorno interior (arriba izq→der, abajo der→izq) y dos filas hacia fuera.
  const N = 2 * K;
  const lips = parts.lips;
  const inner = new Float32Array(N * 2);
  const thick = new Float32Array(N);
  for (let k = 0; k <= K; k++) {
    inner[k * 2] = up[k * 2];
    inner[k * 2 + 1] = up[k * 2 + 1];
  }
  for (let k = 1; k < K; k++) {
    const i = K + k;
    inner[i * 2] = lo[(K - k) * 2];
    inner[i * 2 + 1] = lo[(K - k) * 2 + 1];
  }
  const thin = 1 - 0.65 * press;
  for (let i = 0; i < N; i++) {
    const kk = i <= K ? i : 2 * K - i;
    const s = -1 + (2 * kk) / K;
    const edge = 0.3 + 0.7 * Math.sqrt(Math.max(0, 1 - s * s));
    const base2 = i <= K ? 0.036 : 0.05;
    thick[i] = base2 * edge * thin * (1 + 0.5 * red) * (1 - 0.2 * wide);
  }
  const lat = new Float32Array(3 * N * 2);
  for (let i = 0; i < N; i++) {
    const a = (i + N - 1) % N;
    const b = (i + 1) % N;
    let tx = inner[b * 2] - inner[a * 2];
    let ty = inner[b * 2 + 1] - inner[a * 2 + 1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const nx = -ty;
    const ny = tx;
    for (let r = 0; r < 3; r++) {
      const o = r * N + i;
      lips.xy[o * 2] = inner[i * 2] + nx * thick[i] * (r / 2);
      lips.xy[o * 2 + 1] = inner[i * 2 + 1] + ny * thick[i] * (r / 2);
      const ls = (r - 1) * 0.95;
      lat[o * 2] = nx * ls;
      lat[o * 2 + 1] = ny * ls;
    }
  }
  lips.commit((r) => (r === 1 ? 0.024 : 0.005), lat);

  // Interior oscuro: abanico desde el centro.
  const mi = parts.mouthInt;
  const cy2 = (up[(K >> 1) * 2 + 1] + lo[(K >> 1) * 2 + 1]) / 2;
  for (let k = 0; k <= K; k++) {
    mi.xy[k * 2] = up[k * 2];
    mi.xy[k * 2 + 1] = up[k * 2 + 1] + 0.003;
    mi.xy[(K + 1 + k) * 2] = lo[k * 2];
    mi.xy[(K + 1 + k) * 2 + 1] = lo[k * 2 + 1] - 0.003;
  }
  mi.commit(0.004);

  // Dientes de arriba, dientes de abajo y lengua (tiras entre curvas).
  const tU = parts.teethU;
  const tL = parts.teethL;
  const tg = parts.tongue;
  const show = gap > 0.012;
  tU.mesh.visible = show;
  tL.mesh.visible = gap > 0.07;
  tg.mesh.visible = gap > 0.06;
  if (show) {
    for (let c = 0; c < 11; c++) {
      const k = c + 2;
      const h = Math.min(0.05, gaps[k] * 0.95);
      tU.xy[c * 2] = up[k * 2];
      tU.xy[c * 2 + 1] = up[k * 2 + 1] + 0.0005;
      tU.xy[(11 + c) * 2] = up[k * 2];
      tU.xy[(11 + c) * 2 + 1] = up[k * 2 + 1] - Math.max(0.002, h);
      const hl = Math.min(0.03, gaps[k] * 0.3);
      tL.xy[c * 2] = lo[k * 2];
      tL.xy[c * 2 + 1] = lo[k * 2 + 1] + hl;
      tL.xy[(11 + c) * 2] = lo[k * 2];
      tL.xy[(11 + c) * 2 + 1] = lo[k * 2 + 1] - 0.0005;
      const f = (c - 5) / 5;
      const kk = c + 2;
      const th = Math.min(0.065, gaps[kk] * 0.45) * Math.pow(Math.max(0, 1 - f * f * 0.9), 0.6);
      tg.xy[c * 2] = lo[kk * 2] * 0.8;
      tg.xy[c * 2 + 1] = lo[kk * 2 + 1] + 0.003 + th;
      tg.xy[(11 + c) * 2] = lo[kk * 2] * 0.8;
      tg.xy[(11 + c) * 2 + 1] = lo[kk * 2 + 1] + 0.003;
    }
    tU.commit(0.007);
    tL.commit(0.007);
    if (tg.mesh.visible) tg.commit(0.0055);
  }
  return cy2;
}

function paint(P, now) {
  DEF.jaw = P.bocaAbierta * 0.22;
  DEF.puff = P.mejillas;
  DEF.smL = P.sonrisaI;
  DEF.smR = P.sonrisaD;
  updateHead();
  for (const e of parts.eyes) updateEye(e, P, now);
  updateBrows(P);
  updateNose(P);
  updateBlush(P);
  updateMouth(P);

  // Pose: la cabeza gira desde el cuello.
  pivot.rotation.set(-P.cabezaInclinacion * 0.28, P.cabezaGiro * 0.42, -P.cabezaLadeo * 0.3, "YXZ");
  pivot.position.y = -1.1 + 0.008 * P.breath;
  parts.torso.scale.y = 0.85 * (1 + 0.012 * P.breath);

  // Corazones.
  if (P.corazones > 0.5 && Math.random() < 0.025) spawnHeart(now, rand(-0.3, 0.35), -0.3);
  for (const h of parts.hearts) {
    if (h.t0 < 0) continue;
    const u = (now - h.t0) / 1800;
    if (u >= 1) {
      h.t0 = -1;
      h.m.visible = false;
      continue;
    }
    h.m.position.set(h.x + h.dx * u + 0.05 * Math.sin(u * 9), h.y + u * 1.4, 1.15);
    const sc = 0.2 * Math.sin(Math.min(1, u * 4) * Math.PI * 0.5) * (1 + 0.2 * Math.sin(u * 20));
    h.m.scale.setScalar(sc);
    h.m.material.opacity = 0.9 * (1 - ease(Math.max(0, (u - 0.6) / 0.4)));
  }

  // Brillo de las orejas y del halo: sigue a la voz y al trabajo de los agentes.
  const gl = P.glow;
  for (const r of parts.rings) r.material.color.copy(mats.accent.color).multiplyScalar(0.3 + 0.7 * gl);
  mats.halo.opacity = 0.1 + 0.22 * gl;
}

// ── Bucle ───────────────────────────────────────────────
let raf = 0;
let last = 0;
let visible = true;
let framesDrawn = 0;
let lost = false;
const running = () => renderer && !lost && !document.hidden && visible;

function busy(now) {
  return speech.on || speech.jaw > 0.01 || gestures.length > 0 || life.blinkT0 >= 0 || now - tw.t0 < tw.dur + 40 || actCount > 0 || timeline.length > 0 || life.think > 0.02;
}

function loop() {
  if (!raf && running()) raf = requestAnimationFrame(tick);
}

function tick() {
  raf = 0;
  if (!running()) return;
  const now = performance.now();
  // ~30 fps con animación, ~15 en reposo.
  const gap = busy(now) ? 1000 / 30 : 1000 / 15;
  if (now - last < gap - 4) {
    loop();
    return;
  }
  const dt = Math.min(0.1, (now - last) / 1000 || 0.033);
  last = now;
  if ((document.body.dataset.theme || "") !== themeKey) applyTheme();
  runTimeline(now);
  paint(compose(now, dt), now);
  renderer.render(scene, camera);
  framesDrawn++;
  loop();
}

function resize() {
  if (!renderer) return;
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  last = 0;
  loop();
}

function fallback() {
  const c = canvas.getContext("2d");
  if (!c) return;
  c.canvas.width = 320;
  c.canvas.height = 400;
  c.fillStyle = token("--text-soft", "#8aa");
  c.font = "14px sans-serif";
  c.textAlign = "center";
  c.fillText("Rostro 3D no disponible", 160, 195);
  c.fillText("(WebGL desactivado en esta vista)", 160, 218);
}

// ── API ─────────────────────────────────────────────────
const API = {
  envelope(msg) {
    const values = msg?.values ?? [];
    let sw = 0;
    let sv = 0;
    for (let i = 0; i < values.length; i++) {
      const v = Number(values[i]) > 0 ? Math.min(1, Number(values[i])) : 0;
      sw += i * v;
      sv += v;
    }
    speech.cb = sv > 0 ? clamp(sw / sv / Math.max(1, values.length - 1)) : 0.5;
    speech.seed = (speech.cb * 97 + sv) % 6.28;
    speech.energy = Array.isArray(msg?.energy) ? msg.energy : [];
    speech.dur = Number(msg?.durationMs) || 0;
    // ageMs permite arrancar a mitad cuando la voz ya lleva sonando.
    speech.t0 = performance.now() - (Number(msg?.ageMs) || 0);
    speech.on = true;
    loop();
  },
  idle() {
    speech.on = false;
    loop();
  },
  /** Actividad de los agentes: `{ count, streaming }`. Sin cambios no hace nada. */
  activity(act) {
    const c = Number(act?.count) || 0;
    const s = Boolean(act?.streaming);
    if (c === actCount && s === actStreaming) return;
    actCount = c;
    actStreaming = s;
    loop();
  },
  command(cmd) {
    if (!cmd || typeof cmd !== "object") return;
    const key = `${cmd.seq}:${cmd.t}`;
    if (cmd.seq != null) {
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 80) seen.delete(seen.values().next().value);
    }
    runCmd(cmd);
    loop();
  },
  stats() {
    return { frames: framesDrawn, raf: raf !== 0, webgl: Boolean(renderer), speaking: speech.on, visible };
  },
};

try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  buildScene();
} catch (err) {
  console.warn("Rostro 3D: sin WebGL", err);
  if (renderer) renderer.dispose();
  renderer = null;
  fallback();
}

window.VOZRostro = API;
if (renderer) {
  // Si el sistema pierde el contexto WebGL (GPU ocupada, suspensión), se espera y se reconstruye el entorno.
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lost = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = false;
    buildEnv(mats.accent.color);
    last = 0;
    loop();
  });
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver((es) => {
    visible = es[es.length - 1].isIntersecting;
    if (visible) {
      last = 0;
      loop();
    }
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else {
      last = 0;
      loop();
    }
  });
  // Sin fugas: al descargar la vista se libera el contexto WebGL.
  window.addEventListener("pagehide", () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    scene.traverse((o) => {
      o.geometry?.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
    envTex?.dispose();
    pmrem?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = null;
  });
  resize();
}

// Llamadas que panel.js dejó en cola antes de que este módulo cargara.
const queued = window.VOZRostroQ;
window.VOZRostroQ = null;
if (Array.isArray(queued)) {
  for (const [fn, arg, at] of queued) {
    if (typeof API[fn] !== "function") continue;
    if (fn === "envelope" && arg && at) API.envelope({ ...arg, ageMs: (Number(arg.ageMs) || 0) + (performance.now() - at) });
    else API[fn](arg);
  }
}
