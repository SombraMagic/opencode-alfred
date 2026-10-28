/* Visor Alfred 3D — pinta el GLB que el host exporta de un .blend con three.js y lanza
   renders PNG del frame actual o de un rango. El .blend no se toca nunca desde aquí.
   Tres columnas: objetos y cámaras a la izquierda, lienzo en el centro y luces, animación
   y render a la derecha. La escena se pinta con su cámara libre (órbita) o con una cámara
   del propio GLB, que se casa por nombre. */
import * as THREE from "three";
import { GLTFLoader } from "./three/loaders/GLTFLoader.js";
import { OrbitControls } from "./three/controls/OrbitControls.js";

const vscode = acquireVsCodeApi();

const el = {
  file: document.getElementById("bv-file"),
  hud: document.getElementById("bv-hud"),
  meta: document.getElementById("bv-meta"),
  objects: document.getElementById("bv-objects"),
  objectsEmpty: document.getElementById("bv-objects-empty"),
  cameras: document.getElementById("bv-cameras"),
  stage: document.getElementById("bv-stage"),
  canvas: document.getElementById("bv-canvas"),
  overlay: document.getElementById("bv-overlay"),
  overlayText: document.getElementById("bv-overlay-text"),
  lights: document.getElementById("bv-lights"),
  lightsEmpty: document.getElementById("bv-lights-empty"),
  clips: document.getElementById("bv-clips"),
  start: document.getElementById("bv-start"),
  end: document.getElementById("bv-end"),
  frame: document.getElementById("bv-frame"),
  frameOut: document.getElementById("bv-frame-out"),
  btnIni: document.getElementById("bv-btn-ini"),
  btnPlay: document.getElementById("bv-btn-play"),
  btnStop: document.getElementById("bv-btn-stop"),
  btnLoop: document.getElementById("bv-btn-loop"),
  btnStill: document.getElementById("bv-btn-still"),
  btnAnim: document.getElementById("bv-btn-anim"),
  engine: document.getElementById("bv-engine"),
  base: document.getElementById("bv-base"),
  dir: document.getElementById("bv-dir"),
  btnDir: document.getElementById("bv-btn-dir"),
  textures: document.getElementById("bv-textures"),
  render: document.getElementById("bv-render"),
  bar: document.getElementById("bv-bar"),
  progress: document.getElementById("bv-progress"),
  btnCancel: document.getElementById("bv-btn-cancel"),
  status: document.getElementById("bv-status"),
  blender: document.getElementById("bv-blender"),
  blenderVersion: document.getElementById("bv-blender-version"),
  blenderPath: document.getElementById("bv-blender-path"),
  btnBlender: document.getElementById("bv-btn-blender"),
};

const clock = new THREE.Clock();

let meta = null;
let fps = 24;
let initSeen = false;
let glbCargado = null;
let initSeq = 0;
let booted = false;

let renderer = null;
let scene = null;
let root = null;
let freeCamera = null;
let sceneCamera = null;
let activeCamera = null;
let controls = null;
let mixer = null;
let action = null;
/** Rejilla de suelo: se oculta durante la captura, no sale en el PNG. */
let gridHelper = null;

let clips = [];
let ranges = [];
let clip = null;

/** Nodos, luces y cámaras de la escena, por nombre. Se rellenan en un solo recorrido. */
const objectsByName = new Map();
const lightsByName = new Map();
const camerasByName = new Map();
/** Intensidad original del GLB y base normalizada (la que vale al 100 %). */
const lightInfo = new Map();
/** Porcentaje del deslizador de cada luz. */
const lightDim = new Map();
/** Fila del selector de cámara por nombre ("" = cámara libre). */
const cameraRows = new Map();

let rangeStart = 1;
let rangeEnd = 1;
let frame = 1;
let playPos = 1;
let playing = false;
let loop = true;

let rendering = null;
let renderStart = 0;
let renderEnd = 0;
let lastProgress = -1;
let lastProgressKind = "";
/** Sello del último `pickBlender`: el diálogo del host no responde, así que no se encadenan. */
const PICK_GUARD_MS = 1000;
let lastPick = 0;

/** Estado del visor que sobrevive a la recreación de la pestaña (`vscode.setState`). */
let estadoListo = false;
let selectedCamera = null;
let textures = true;
let clayMaterial = null;
const originalMaterials = new Map();
let lastAutoSave = 0;

/** El exportador glTF pasa la energía de Blender a unidades físicas: 683 lm por vatio. */
const LUX_PER_WATT = 683;
/** Tope de un sol en W/m²: los soles normales de Blender van de 3 a 15 y pasan enteros. */
const MAX_SUN_W = 15;
/** Tope de una lámpara point/spot en W, para no reventar la escena con valores absurdos. */
const MAX_LAMP_W = 1000;

/** Ajustes de render: los persiste el host y llegan en `init.render`. */
let renderDir = null;
/** Motor del bloque RENDER: `visor` captura aquí; `blender` lanza el proceso del host. */
let renderEngine = "visor";
let settingsTimer = 0;
/** Tanda del motor visor en curso y su bandera de cancelación entre frames. */
let renderingVisor = false;
let cancelVisor = false;

let lastW = 0;
let lastH = 0;
let rafId = 0;
let drawFailed = false;

// ── Utilidades ──────────────────────────────────────────────

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/** El cargador de three sanea los nombres (`Cube.001` → `Cube001`) y el meta trae los de Blender. */
function clave(nombre) {
  const texto = String(nombre || "");
  const saneador = THREE.PropertyBinding && THREE.PropertyBinding.sanitizeNodeName;
  return typeof saneador === "function" ? saneador(texto) : texto;
}

/** Busca por el nombre saneado y, si no, por el literal (por si el nodo no venía del GLB). */
function porNombre(mapa, nombre) {
  return mapa.get(clave(nombre)) || mapa.get(nombre) || null;
}

function detailOf(error) {
  return error instanceof Error && error.message ? ` ${error.message}` : "";
}

function cuenta(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = "bv-status" + (kind ? " " + kind : "");
}

function setHud(text, kind) {
  el.hud.textContent = text;
  el.hud.className = "hud-status" + (kind ? " " + kind : "");
}

function showOverlay(text) {
  el.overlayText.textContent = text;
  el.overlay.hidden = false;
}

/** Error de la extensión o de la carga: mensaje en el centro, sin romper el panel. */
function showError(text) {
  showOverlay(text);
  setHud("ERROR", "error");
  setStatus(text, "error");
}

// ── Renderer y escena ───────────────────────────────────────

function ensureRenderer() {
  if (renderer) return true;
  try {
    // Alfa: el fondo lo pinta el CSS con `--bg` y sigue solo al tema claro u oscuro.
    renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true });
  } catch (error) {
    showError(
      "No se ha podido crear el contexto WebGL del visor. Comprueba que la aceleración por hardware esté activa en VS Code." +
        detailOf(error)
    );
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearAlpha(0);
  // Blender pinta con AgX (look None): ACES dejaba la escena ~25 % más oscura que el .blend.
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return true;
}

/** Color de un token del HUD, para la rejilla. Los tokens no se releen si cambia el tema. */
function themeColor(name, fallback) {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  if (!value) return fallback;
  try {
    return new THREE.Color(value);
  } catch {
    return fallback;
  }
}

function paintHeader() {
  const res = meta.resolution;
  el.file.textContent = meta.file || "—";
  el.file.title = meta.file || "";
  const engine = meta.engine || "Blender";
  if (!res || typeof res !== "object") {
    // Sidecar sin meta de resolución: el visor captura al tamaño del lienzo.
    el.meta.textContent = `${engine} · sin resolución`;
    el.meta.title = "El sidecar no trae resolución: el visor captura al tamaño del lienzo.";
    return;
  }
  const x = intOr(res.x, 0);
  const y = intOr(res.y, 0);
  const percent = intOr(res.percent, 100);
  el.meta.textContent = `${engine} · ${x}×${y} · ${percent} %`;
  el.meta.title = `Resolución del .blend: ${x}×${y} píxeles al ${percent} %.`;
}

/** Qué Blender usa el host. Sin ruta es un estado apagado de verdad, no un error de escena. */
function paintBlender(message) {
  lastPick = 0;

  const path = typeof message.path === "string" ? message.path.trim() : "";
  if (!path) {
    el.blender.classList.add("off");
    el.blenderVersion.textContent = "Sin Blender";
    el.blenderPath.textContent = "";
    el.blenderPath.removeAttribute("title");
    el.blender.title = "No se ha encontrado Blender en el ajuste ni en el PATH.";
    return;
  }

  const version = typeof message.version === "string" ? message.version.trim() : "";
  el.blender.classList.remove("off");
  el.blenderVersion.textContent = version || "Blender";
  el.blenderPath.textContent = path;
  el.blenderPath.title = path;
  el.blender.title = `${version || "Blender"} · ${path}`;
}

/** Objetos de la lista: cámaras y luces ya tienen su bloque propio. */
function objetosDeEscena() {
  return meta && Array.isArray(meta.objects)
    ? meta.objects.filter((info) => info.type !== "CAMERA" && info.type !== "LIGHT")
    : [];
}

function paintDir() {
  if (renderDir) {
    el.dir.textContent = renderDir;
    el.dir.title = renderDir;
    el.dir.classList.remove("off");
    return;
  }
  el.dir.textContent = "Sin carpeta";
  el.dir.title = "El host pedirá la carpeta al renderizar.";
  el.dir.classList.add("off");
}

function datosRender() {
  return { base: el.base.value.trim(), dir: renderDir, engine: renderEngine };
}

/** `base`, `dir` y el motor no viven en el estado del webview: los persiste el host. */
function enviarAjustes() {
  clearTimeout(settingsTimer);
  settingsTimer = 0;
  if (!meta) return;
  vscode.postMessage({ type: "renderSettings", ...datosRender() });
}

function programarAjustes() {
  clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(enviarAjustes, 400);
}

/** Estado que el host reenvía al recrear la pestaña. Cámara, visibilidad, clip, frames y texturas. */
function saveState() {
  if (!estadoListo || !meta) return;

  const hidden = [];
  for (const info of objetosDeEscena()) {
    const target = porNombre(objectsByName, info.name);
    if (target && target.visible === false) hidden.push(info.name);
  }

  const lightsOff = [];
  for (const info of Array.isArray(meta.lights) ? meta.lights : []) {
    const light = porNombre(lightsByName, info.name);
    if (light && light.visible === false) lightsOff.push(info.name);
  }

  const lightsDim = {};
  for (const info of Array.isArray(meta.lights) ? meta.lights : []) {
    const light = porNombre(lightsByName, info.name);
    if (light) lightsDim[info.name] = lightDim.get(light) ?? 100;
  }

  vscode.setState({
    camera: selectedCamera,
    hidden,
    lightsOff,
    lightsDim,
    clip: clip ? clip.name : null,
    frame,
    rangeStart,
    rangeEnd,
    textures,
  });
}

/** Reproduciendo, guardar cada frame sobra: cada 500 ms ya recoge el avance. */
function savePlayback() {
  const now = Date.now();
  if (now - lastAutoSave < 500) return;
  lastAutoSave = now;
  saveState();
}

/** Vista de arcilla: un gris neutro para todas las mallas, con los materiales originales a salvo. */
function aplicarMateriales() {
  if (!root) return;

  if (textures) {
    for (const [mesh, materials] of originalMaterials) mesh.material = materials;
    originalMaterials.clear();
    if (clayMaterial) {
      clayMaterial.dispose();
      clayMaterial = null;
    }
    return;
  }

  if (!clayMaterial) {
    clayMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9bec4,
      roughness: 0.85,
      metalness: 0.05,
      name: "vista de arcilla",
    });
  }
  root.traverse((node) => {
    if (!node.isMesh) return;
    if (!originalMaterials.has(node)) originalMaterials.set(node, node.material);
    node.material = clayMaterial;
  });
}

function setTextures(on) {
  textures = Boolean(on);
  el.textures.checked = textures;
  aplicarMateriales();
  saveState();
}

/** Cámara, frames y texturas guardados; sin cámara guardada manda la del `.blend`. */
function restaurarEstado(guardado) {
  if (!guardado || typeof guardado !== "object") return;

  const start = Number.isInteger(guardado.rangeStart) ? guardado.rangeStart : null;
  const end = Number.isInteger(guardado.rangeEnd) ? guardado.rangeEnd : null;
  if (start !== null && end !== null && start <= end) {
    rangeStart = start;
    rangeEnd = end;
  }
  if (Number.isInteger(guardado.frame)) {
    frame = clamp(guardado.frame, rangeStart, rangeEnd);
  }
  playPos = frame;
  paintRange();
  poseAt(playPos);

  if (typeof guardado.camera === "string" && porNombre(camerasByName, guardado.camera)) {
    selectView(guardado.camera);
  } else if (guardado.camera === null) {
    // Cámara libre elegida a mano: un restore explícito manda sobre la del .blend.
    selectView(null);
  } else if (typeof meta.camera === "string" && porNombre(camerasByName, meta.camera)) {
    // Sin estado de pestaña, se arranca con la cámara del .blend: es la vista de Blender.
    selectView(meta.camera);
  }

  setTextures(guardado.textures !== false);
}

/** Suelta la escena anterior antes de montar la nueva (segundo init tras cambiar de Blender). */
function liberarEscena() {
  playing = false;

  if (mixer) {
    mixer.stopAllAction();
    if (root) mixer.uncacheRoot(root);
    mixer = null;
  }
  action = null;
  clip = null;

  // OrbitControls cuelga sus listeners del canvas: sin dispose se acumularían.
  if (controls) {
    controls.dispose();
    controls = null;
  }

  const materiales = new Set();
  for (const guardados of originalMaterials.values()) {
    for (const material of Array.isArray(guardados) ? guardados : [guardados]) {
      if (material) materiales.add(material);
    }
  }
  originalMaterials.clear();
  if (clayMaterial) {
    clayMaterial.dispose();
    clayMaterial = null;
  }

  if (root) {
    if (scene) scene.remove(root);
    root.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      const actuales = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      for (const material of actuales) materiales.add(material);
    });
  }
  for (const material of materiales) material.dispose();

  root = null;
  scene = null;
  gridHelper = null;
  freeCamera = null;
  sceneCamera = null;
  activeCamera = null;
  selectedCamera = null;
  lightInfo.clear();
  lightDim.clear();
}

function buildScene(gltf) {
  liberarEscena();
  scene = new THREE.Scene();
  root = gltf.scene || (gltf.scenes && gltf.scenes[0]) || null;
  if (!root) throw new Error("El GLB no trae ninguna escena.");
  scene.add(root);
  root.updateMatrixWorld(true);

  // Un único recorrido para todos los mapas: ocultar objetos no vuelve a buscar por nombre.
  objectsByName.clear();
  lightsByName.clear();
  camerasByName.clear();
  root.traverse((node) => {
    if (!node.name) return;
    if (!objectsByName.has(node.name)) objectsByName.set(node.name, node);
    if (node.isLight && !lightsByName.has(node.name)) lightsByName.set(node.name, node);
    if (node.isCamera) camerasByName.set(node.name, node); // el GLB manda si repite nombre
  });
  for (const camera of gltf.cameras || []) {
    if (camera.name) camerasByName.set(camera.name, camera);
  }

  const box = new THREE.Box3().setFromObject(root);
  const hasBox = !box.isEmpty();
  const size = hasBox ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(2, 2, 2);
  const center = hasBox ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const floorY = hasBox ? box.min.y : 0;
  const radius = Math.max(size.length() * 0.5, 0.75);

  freeCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 1000);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(freeCamera.fov / 2));
  freeCamera.position
    .copy(center)
    .add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance * 1.15));
  freeCamera.near = Math.max(distance / 500, 0.01);
  freeCamera.far = Math.max(distance * 50, 100);
  freeCamera.updateProjectionMatrix();
  activeCamera = freeCamera;

  // Controles estilo Blender: botón central orbita, Mayús + central desplaza y la rueda
  // acerca. El izquierdo orbita también por comodidad.
  controls = new OrbitControls(freeCamera, el.canvas);
  controls.target.copy(center);
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
  controls.screenSpacePanning = true;
  controls.minDistance = Math.max(radius / 100, 0.001);
  controls.maxDistance = Math.max(radius * 50, 10);
  controls.update();

  const gridSpan = Math.max(size.x, size.z, 1);
  gridHelper = new THREE.GridHelper(
    Math.ceil(gridSpan * 2),
    20,
    themeColor("--neon", 0x00e5ff),
    themeColor("--text-dim", 0x2a4a5a)
  );
  gridHelper.position.set(center.x, floorY, center.z);
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.24;
  gridHelper.material.depthWrite = false;
  scene.add(gridHelper);

  // Relleno fijo: no sale en LUCES ni cuenta para la normalización.
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x1b2430, 0.9));

  // Unidades físicas: el glTF trae el sol en lux (energía de Blender × 683) y se devuelve a
  // W/m², la escala que three espera de una direccional; point/spot vienen en candelas
  // (W × 683/4π), que ya es unidad de three, y solo se recortan por encima de MAX_LAMP_W.
  // Un sol normal (3-15 W/m²) pasa entero y el deslizador va sobre esa base.
  for (const light of lightsByName.values()) {
    const original = light.intensity;
    let base;
    if (light.isDirectionalLight) {
      base = Math.min(original / LUX_PER_WATT, MAX_SUN_W);
    } else {
      const vatios = (original * 4 * Math.PI) / LUX_PER_WATT;
      base = vatios > MAX_LAMP_W ? (MAX_LAMP_W * LUX_PER_WATT) / (4 * Math.PI) : original;
    }
    lightInfo.set(light, { original, base });
    light.intensity = base;
  }

  clips = Array.isArray(gltf.animations) ? gltf.animations : [];
  ranges = clips.map(rangeOf);
  if (clips.length > 0) mixer = new THREE.AnimationMixer(root);

  // Estado de la pestaña anterior: visibilidad, cámara, clip, frames y texturas. base y dir no.
  const guardado = vscode.getState && vscode.getState();
  const previo = guardado && typeof guardado === "object" ? guardado : {};
  const ocultos = new Set(
    (Array.isArray(previo.hidden) ? previo.hidden : []).filter((n) => typeof n === "string")
  );
  const apagadas = new Set(
    (Array.isArray(previo.lightsOff) ? previo.lightsOff : []).filter((n) => typeof n === "string")
  );

  fillClips();
  fillObjects(ocultos);
  fillLights(apagadas, previo.lightsDim);
  fillCameras();

  rangeStart = intOr(meta.frameStart, 1);
  rangeEnd = Math.max(rangeStart, intOr(meta.frameEnd, rangeStart));
  frame = clamp(intOr(meta.frameCurrent, rangeStart), rangeStart, rangeEnd);
  playPos = frame;

  paintRange();
  booted = true;
  refresh();

  // El clip guardado se busca por nombre; si el .blend lo cambió, se queda sin animación.
  const clipPrevio = typeof previo.clip === "string" ? previo.clip : null;
  const clipIndex = clipPrevio ? clips.findIndex((c) => c.name === clipPrevio) : -1;
  if (clipIndex >= 0) selectClip(clipIndex);
  restaurarEstado(previo);
  estadoListo = true;
  saveState();

  // Un fallo anterior de dibujo o un mensaje de error no deben tapar la escena nueva.
  drawFailed = false;
  el.overlay.hidden = true;

  setHud("ESCENA LISTA", "ok");
  setStatus(
    `Escena lista: ${cuenta(objetosDeEscena().length, "objeto", "objetos")} · ` +
      `${cuenta((meta.lights || []).length, "luz", "luces")} · ` +
      `${cuenta(clips.length, "animación", "animaciones")}.`
  );
  startLoop();
  // El observer pudo medir antes de que hubiera escena: se fuerza una medida con cámaras.
  lastW = 0;
  lastH = 0;
  resize();
  draw();
}

function rangeOf(animation) {
  const listed = (meta.animations || []).find((item) => item.name === animation.name);
  if (listed) {
    const start = intOr(listed.start, 1);
    return { start, end: Math.max(start, intOr(listed.end, start)) };
  }
  // Sin rango en el meta, el de siempre: frames del clip a los fps de la escena.
  const start = 1;
  return { start, end: Math.max(start, Math.round((animation.duration || 0) * fps)) };
}

// ── Listas de la izquierda y la derecha ─────────────────────

function fillObjects(ocultos) {
  el.objects.textContent = "";
  const list = objetosDeEscena();
  const guardados = ocultos instanceof Set ? ocultos : new Set();
  el.objectsEmpty.hidden = list.length > 0;

  for (const info of list) {
    const target = porNombre(objectsByName, info.name);
    const row = document.createElement("label");
    row.className = "bv-row";
    row.title = info.name;

    const checked = info.visible === false || guardados.has(info.name);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;

    const name = document.createElement("span");
    name.className = "bv-name";
    name.textContent = info.name;

    const type = document.createElement("span");
    type.className = "bv-type";
    type.textContent = info.type || "";

    row.append(box, name, type);
    if (checked) row.classList.add("off");

    if (!target) {
      box.dataset.lock = "1";
      box.checked = false;
      box.disabled = true;
      row.classList.remove("off");
      row.setAttribute("aria-disabled", "true");
      row.title = "Este objeto no está en la escena exportada.";
    } else {
      target.visible = !checked;
      box.title = "Ocultar o mostrar este objeto en el visor";
      box.addEventListener("change", () => {
        target.visible = !box.checked;
        row.classList.toggle("off", box.checked);
        saveState();
      });
    }
    el.objects.append(row);
  }
}

function aplicarIntensidad(light, percent) {
  const info = lightInfo.get(light);
  if (!info) return;
  light.intensity = info.base * (percent / 100);
}

/** `title` del deslizador: la energía física (W/m² en el sol, W en point/spot) al porcentaje dado. */
function tituloIntensidad(light, percent) {
  const info = lightInfo.get(light);
  if (!info) return "Esta luz no está en la escena exportada.";
  const escala = percent / 100;
  if (light.isDirectionalLight) {
    const vatio = Number((info.base * escala).toFixed(2));
    const glb = Number(((info.original * escala) / LUX_PER_WATT).toFixed(2));
    return glb === vatio ? `Energía: ${vatio} W/m²` : `Energía: ${vatio} W/m² (GLB: ${glb})`;
  }
  const vatio = Number((((info.base * escala) * 4 * Math.PI) / LUX_PER_WATT).toFixed(2));
  const glb = Number((((info.original * escala) * 4 * Math.PI) / LUX_PER_WATT).toFixed(2));
  return glb === vatio ? `Energía: ${vatio} W` : `Energía: ${vatio} W (GLB: ${glb})`;
}

function fillLights(lucesOff, dimsGuardadas) {
  el.lights.textContent = "";
  const list = Array.isArray(meta.lights) ? meta.lights : [];
  const apagadas = lucesOff instanceof Set ? lucesOff : new Set();
  const dims = dimsGuardadas && typeof dimsGuardadas === "object" ? dimsGuardadas : {};
  el.lightsEmpty.hidden = list.length > 0;

  for (const info of list) {
    const light = porNombre(lightsByName, info.name);
    const wrap = document.createElement("div");
    wrap.className = "bv-light";

    const row = document.createElement("div");
    row.className = "bv-row";
    row.title = info.name;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch";
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-label", info.name);

    const track = document.createElement("span");
    track.className = "switch-track";
    const thumb = document.createElement("span");
    thumb.className = "switch-thumb";
    track.append(thumb);
    toggle.append(track);

    const name = document.createElement("span");
    name.className = "bv-name";
    name.textContent = info.name;

    const type = document.createElement("span");
    type.className = "bv-type";
    type.textContent = info.type || "";

    let on = light ? light.visible !== false : true;
    if (apagadas.has(info.name)) on = false;
    if (light) light.visible = on;
    const paint = () => {
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-checked", String(on));
      row.classList.toggle("off", !on);
      toggle.title = on ? "Apagar esta luz en el visor" : "Encender esta luz en el visor";
    };
    paint();

    // Deslizador de intensidad: 100 % es la base normalizada de la escena.
    let percent = 100;
    if (light) {
      const guardado = Number(dims[info.name]);
      percent = Number.isFinite(guardado) ? clamp(Math.round(guardado), 0, 200) : 100;
      lightDim.set(light, percent);
    }

    const dim = document.createElement("label");
    dim.className = "bv-dim";
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "200";
    range.step = "1";
    range.setAttribute("aria-label", `Intensidad de ${info.name}`);
    const out = document.createElement("output");
    dim.append(range, out);

    const pintarIntensidad = () => {
      range.value = String(percent);
      out.textContent = `${percent} %`;
      const titulo = tituloIntensidad(light, percent);
      dim.title = titulo;
      range.title = titulo;
      out.title = titulo;
    };

    if (!light) {
      toggle.dataset.lock = "1";
      toggle.disabled = true;
      range.dataset.lock = "1";
      range.disabled = true;
      out.textContent = "—";
      dim.title = "Esta luz no está en la escena exportada.";
      row.setAttribute("aria-disabled", "true");
      row.title = "Esta luz no está en la escena exportada.";
    } else {
      aplicarIntensidad(light, percent);
      pintarIntensidad();
      toggle.addEventListener("click", () => {
        on = !on;
        light.visible = on;
        paint();
        saveState();
      });
      range.addEventListener("input", () => {
        percent = clamp(intOr(range.value, percent), 0, 200);
        lightDim.set(light, percent);
        aplicarIntensidad(light, percent);
        pintarIntensidad();
      });
      range.addEventListener("change", () => saveState());
    }

    row.append(toggle, name, type);
    wrap.append(row, dim);
    el.lights.append(wrap);
  }
}

function fillClips() {
  while (el.clips.options.length > 1) el.clips.remove(1);
  for (let i = 0; i < clips.length; i++) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = clips[i].name || `Animación ${i + 1}`;
    el.clips.append(option);
  }
  el.clips.value = "";
  el.clips.title = clips.length > 0 ? "Elige la animación que se previsualiza" : "La escena no trae animaciones.";
}

function fillCameras() {
  el.cameras.textContent = "";
  cameraRows.clear();

  addCameraRow(null, "Cámara libre", false);
  for (const info of Array.isArray(meta.cameras) ? meta.cameras : []) {
    addCameraRow(info.name, info.name, info.name === meta.camera);
  }
  setSelectedCamera(null);
}

function addCameraRow(name, label, isSceneCamera) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "bv-row";

  const text = document.createElement("span");
  text.className = "bv-name";
  text.textContent = label;
  text.title = label;
  row.append(text);

  if (isSceneCamera) {
    const flag = document.createElement("span");
    flag.className = "bv-flag";
    flag.textContent = "· escena";
    row.append(flag);
  }

  if (name !== null && !porNombre(camerasByName, name)) {
    row.title = "La escena exportada no trae esta cámara.";
  }

  row.addEventListener("click", () => selectView(name));
  el.cameras.append(row);
  cameraRows.set(name === null ? "" : name, row);
}

function setSelectedCamera(name) {
  const key = name === null ? "" : name;
  for (const [rowKey, row] of cameraRows) {
    const on = rowKey === key;
    row.classList.toggle("on", on);
    row.setAttribute("aria-pressed", String(on));
  }
}

function selectView(name) {
  if (!booted || rendering) return;
  if (name === null) {
    sceneCamera = null;
    activeCamera = freeCamera;
    controls.enabled = true;
    selectedCamera = null;
    setSelectedCamera(null);
    setStatus(
      "Cámara libre: botón central para orbitar, Mayús + botón central para desplazar, rueda para acercar."
    );
    draw();
    saveState();
    return;
  }

  const camera = porNombre(camerasByName, name);
  if (!camera) {
    setStatus(`La escena exportada no trae la cámara «${name}».`, "error");
    return;
  }
  sceneCamera = camera;
  activeCamera = camera;
  controls.enabled = false;
  selectedCamera = name;
  applyAspect(camera, el.stage.clientWidth / Math.max(1, el.stage.clientHeight));
  setSelectedCamera(name);
  setStatus(`Vista de la cámara «${name}». Vuelve a Cámara libre para orbitar.`);
  draw();
  saveState();
}

// ── Frames y reproducción ───────────────────────────────────

function paintRange() {
  el.start.value = String(rangeStart);
  el.end.value = String(rangeEnd);
  el.frame.min = String(rangeStart);
  el.frame.max = String(rangeEnd);
  paintFrame();
}

function paintFrame() {
  el.frame.value = String(frame);
  el.frameOut.textContent = String(frame);
}

/** Tiempo = (frame - inicio del rango) / fps; el mixel se posa a mano en ese instante. */
function poseAt(position) {
  if (!action || !mixer) return;
  const duration = clip && clip.duration > 0 ? clip.duration : 0;
  const time = (position - rangeStart) / fps;
  if (duration > 0) {
    action.time = loop ? ((time % duration) + duration) % duration : clamp(time, 0, duration);
  } else {
    action.time = 0;
  }
}

function setPlaying(next) {
  playing = Boolean(next && clip && mixer);
  if (playing) playPos = frame;
  refresh();
  saveState();
}

function advance(dt) {
  const span = rangeEnd - rangeStart + 1;
  if (span <= 1) {
    setPlaying(false);
    return;
  }
  playPos += dt * fps;
  if (playPos > rangeEnd) {
    if (loop) {
      playPos = rangeStart + ((playPos - rangeStart) % span);
    } else {
      playPos = rangeEnd;
      setPlaying(false);
    }
  }
  // Redondear puede pasarse medio frame del fin: se recorta al rango.
  const shown = clamp(Math.round(playPos), rangeStart, rangeEnd);
  if (shown !== frame) {
    frame = shown;
    paintFrame();
    savePlayback();
  }
  poseAt(playPos);
}

function selectClip(index) {
  playing = false;
  if (mixer) mixer.stopAllAction();
  action = null;

  const next = index >= 0 && index < clips.length ? clips[index] : null;
  clip = next;
  // Al restaurar el estado el cambio no viene del <select>: hay que dejarlo a la vista.
  el.clips.value = next ? String(index) : "";

  if (clip && mixer) {
    const range = ranges[index] || rangeOf(clip);
    rangeStart = range.start;
    rangeEnd = range.end;
    frame = rangeStart;
    action = mixer.clipAction(clip);
    action.play();
    poseAt(frame);
    mixer.update(0);
    setStatus(
      `Animación «${clip.name || "sin nombre"}»: frames ${rangeStart}…${rangeEnd}.`
    );
  } else {
    rangeStart = intOr(meta.frameStart, 1);
    rangeEnd = Math.max(rangeStart, intOr(meta.frameEnd, rangeStart));
    frame = clamp(intOr(meta.frameCurrent, rangeStart), rangeStart, rangeEnd);
  }

  playPos = frame;
  paintRange();
  refresh();
  draw();
  saveState();
}

function commitRange() {
  if (!booted) return false;
  const rawStart = String(el.start.value).trim();
  const rawEnd = String(el.end.value).trim();
  const start = Number(rawStart);
  const end = Number(rawEnd);
  const valid =
    rawStart !== "" &&
    rawEnd !== "" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start <= end;

  el.start.classList.toggle("invalid", !valid);
  el.end.classList.toggle("invalid", !valid);

  if (!valid) {
    el.start.value = String(rangeStart);
    el.end.value = String(rangeEnd);
    window.setTimeout(() => {
      el.start.classList.remove("invalid");
      el.end.classList.remove("invalid");
    }, 900);
    setStatus(
      "Rango no válido: los frames tienen que ser enteros y el inicio no puede superar el fin.",
      "error"
    );
    return false;
  }

  rangeStart = start;
  rangeEnd = end;
  frame = clamp(frame, rangeStart, rangeEnd);
  playPos = frame;
  paintRange();
  poseAt(playPos);
  draw();
  saveState();
  return true;
}

// ── Render y estado ────────────────────────────────────────

function refresh() {
  const busy = rendering !== null;
  const ready = booted;
  const hasClip = Boolean(clip && mixer);

  el.clips.disabled = busy || !ready || clips.length === 0;
  el.start.disabled = busy || !ready;
  el.end.disabled = busy || !ready;
  el.frame.disabled = busy || !ready;
  el.btnIni.disabled = busy || !ready;
  el.btnPlay.disabled = busy || !hasClip;
  el.btnStop.disabled = busy || !hasClip;
  el.btnLoop.disabled = busy || !hasClip;
  el.btnStill.disabled = busy || !ready;
  el.btnAnim.disabled = busy || !ready;
  el.engine.disabled = busy || !ready;
  el.base.disabled = busy || !ready;
  el.btnDir.disabled = busy || !ready;
  el.btnCancel.disabled = false;
  el.btnBlender.disabled = busy;

  el.btnPlay.textContent = playing ? "PAUSA" : "PLAY";
  el.btnPlay.title = playing ? "Pausar la animación" : "Reproducir la animación";
  el.btnLoop.classList.toggle("on", loop);
  el.btnLoop.setAttribute("aria-pressed", String(loop));
  el.render.hidden = rendering === null;

  for (const node of el.objects.querySelectorAll("input")) {
    node.disabled = busy || !ready || node.dataset.lock === "1";
  }
  for (const node of el.lights.querySelectorAll("button, input")) {
    node.disabled = busy || !ready || node.dataset.lock === "1";
  }
  for (const node of el.cameras.querySelectorAll("button")) {
    node.disabled = busy || !ready;
  }
}

function endRender() {
  rendering = null;
  renderingVisor = false;
  cancelVisor = false;
  lastProgress = -1;
  lastProgressKind = "";
  el.bar.style.width = "0%";
  el.progress.textContent = "0 / 0";
  if (booted) setHud("ESCENA LISTA", "ok");
  refresh();
}

// ── Render con el motor del visor ──────────────────────────

/**
 * PNG del frame pedido a la resolución del sidecar, en base64 y sin el prefijo `data:`.
 * El render, `toDataURL` y la restauración van en la misma tarea: sin `preserveDrawingBuffer`
 * el lienzo se vacía entre tareas y la captura saldría en blanco.
 */
function capturar(posicion) {
  if (!renderer || !scene || !activeCamera) return null;

  // El frame se posa con el mismo mapeo frame↔tiempo que el scrubber y PLAY.
  poseAt(posicion);
  if (mixer) mixer.update(0);

  const res = meta && meta.resolution;
  let width;
  let height;
  if (res && typeof res === "object") {
    const percent = intOr(res.percent, 100);
    width = Math.max(1, Math.floor((intOr(res.x, 0) * percent) / 100));
    height = Math.max(1, Math.floor((intOr(res.y, 0) * percent) / 100));
  } else {
    // Sidecar sin resolución: lo que mide el lienzo en píxeles de dispositivo.
    width = Math.max(1, Math.round(el.canvas.width));
    height = Math.max(1, Math.round(el.canvas.height));
  }

  const camera = activeCamera;
  const aspecto = camera.isPerspectiveCamera ? camera.aspect : null;
  // La cámara ortográfica trae el encuadre del .blend: se ajusta al tamaño del PNG y se
  // repone después. Sin esto, la FOTO hereda la relación de aspecto del panel y deforma.
  const ortografico = camera.isOrthographicCamera
    ? { left: camera.left, right: camera.right }
    : null;
  const rejilla = gridHelper ? gridHelper.visible : false;
  if (gridHelper) gridHelper.visible = false;

  let data = "";
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    if (aspecto !== null) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    } else if (ortografico) {
      applyAspect(camera, width / height);
    }
    renderer.render(scene, camera);
    data = el.canvas.toDataURL("image/png");
  } finally {
    if (gridHelper) gridHelper.visible = rejilla;
    if (aspecto !== null) {
      camera.aspect = aspecto;
      camera.updateProjectionMatrix();
    } else if (ortografico) {
      camera.left = ortografico.left;
      camera.right = ortografico.right;
      camera.updateProjectionMatrix();
    }
    poseAt(frame);
    if (mixer) mixer.update(0);
    // Vuelta al tamaño y al aspecto del panel: `resize` repone el pixel ratio y repinta.
    lastW = 0;
    lastH = 0;
    resize();
  }

  const coma = data.indexOf(",");
  return coma >= 0 ? data.slice(coma + 1) : "";
}

/** FOTO con el motor del visor: captura el frame actual y la manda al host. */
function fotoVisor() {
  const { base, dir } = datosRender();
  const current = frame;
  // Con PLAY en marcha, el bucle rAF movería el frame entre capturas.
  if (playing) setPlaying(false);
  rendering = "still";
  renderingVisor = true;
  cancelVisor = false;
  onRenderProgress({ kind: "still", total: 1, frame: current });

  const data = capturar(current);
  if (!data) {
    onRenderFailed({ message: "El visor no ha podido capturar el frame." });
    return;
  }
  vscode.postMessage({ type: "renderPng", dir, base, frame: current, data });
  vscode.postMessage({ type: "renderVisorEnd", kind: "still", dir, count: 1 });
}

/** RENDER ANIMACIÓN con el motor del visor: un PNG por frame, con la barra en local. */
async function animacionVisor(base, dir, start, end) {
  const total = end - start + 1;
  // Con PLAY en marcha, el bucle rAF movería el frame entre capturas.
  if (playing) setPlaying(false);
  rendering = "animation";
  renderingVisor = true;
  cancelVisor = false;
  let enviados = 0;

  for (let n = start; n <= end; n++) {
    // CANCELAR levanta la bandera entre frames; un `renderFailed` ya cerró el estado.
    if (cancelVisor || rendering === null) break;
    const data = capturar(n);
    if (!data) {
      onRenderFailed({ message: `El visor no ha podido capturar el frame ${n}.` });
      return;
    }
    vscode.postMessage({ type: "renderPng", dir, base, frame: n, data });
    enviados++;
    onRenderProgress({ kind: "animation", total, frame: n });
    // Cede el hilo: el navegador pinta la barra y el host puede responder.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  renderingVisor = false;
  if (cancelVisor) {
    onRenderCancelled();
    return;
  }
  if (rendering === null) return;
  vscode.postMessage({ type: "renderVisorEnd", kind: "animation", dir, count: enviados });
}

function onRenderProgress(message) {
  const kind = message.kind === "animation" ? "animation" : "still";
  const total = Math.max(1, intOr(message.total, 1));
  const current = intOr(message.frame, 0);

  // El host puede repetir el mismo frame mientras Blender escribe: la barra no se mueve.
  if (rendering !== null && kind === lastProgressKind && current === lastProgress) return;

  rendering = kind;
  lastProgressKind = kind;
  lastProgress = current;

  const done = kind === "still" ? 1 : Math.max(1, current - renderStart + 1);
  el.bar.style.width = `${clamp((done / total) * 100, 0, 100)}%`;
  el.progress.textContent = kind === "still" ? `frame ${current}` : `${current} / ${total}`;
  setHud("RENDERIZANDO…", "busy");
  refresh();
}

function onRenderDone(message) {
  const kind = message.kind === "animation" ? "animation" : "still";
  const path = typeof message.path === "string" && message.path ? message.path : "la ruta elegida";
  // El host cuenta los PNG escritos; sin ese dato vale lo pedido en el rango.
  const total = Number.isInteger(message.count)
    ? message.count
    : Math.max(1, renderEnd - renderStart + 1);
  endRender();
  setStatus(
    kind === "animation"
      ? `${cuenta(total, "PNG", "PNG")} en «${path}».`
      : `PNG guardado en «${path}».`,
    "ok"
  );
}

function onRenderFailed(message) {
  endRender();
  setStatus(String(message.message || "El render ha fallado."), "error");
}

function onRenderCancelled() {
  endRender();
  setStatus("Render cancelado.");
}

// ── Lienzo ─────────────────────────────────────────────────

function applyAspect(camera, aspect) {
  if (!camera || !Number.isFinite(aspect) || aspect <= 0) return;
  if (camera.isPerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    return;
  }
  if (camera.isOrthographicCamera) {
    // Se conserva el alto y el centro del frustum; solo manda la relación de aspecto.
    const halfHeight = Math.abs(camera.top - camera.bottom) / 2 || 1;
    const center = (camera.left + camera.right) / 2;
    camera.left = center - halfHeight * aspect;
    camera.right = center + halfHeight * aspect;
    camera.updateProjectionMatrix();
  }
}

function draw() {
  if (!renderer || !scene || !activeCamera || drawFailed) return;
  try {
    renderer.render(scene, activeCamera);
  } catch (error) {
    drawFailed = true;
    showError("La escena no se ha podido pintar." + detailOf(error));
  }
}

function resize() {
  if (!renderer) return;
  const width = Math.max(1, Math.round(el.stage.clientWidth));
  const height = Math.max(1, Math.round(el.stage.clientHeight));
  if (width === lastW && height === lastH) return;
  lastW = width;
  lastH = height;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  const aspect = width / height;
  applyAspect(freeCamera, aspect);
  if (sceneCamera) applyAspect(sceneCamera, aspect);
  draw();
}

function startLoop() {
  if (rafId) return;
  clock.getDelta();
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function tick() {
  rafId = requestAnimationFrame(tick);
  if (document.hidden) return;
  // Con la pestaña oculta el rAF se para; el tope evita un salto al volver.
  const dt = Math.min(clock.getDelta(), 0.1);
  if (playing && clip) advance(dt);
  if (mixer) mixer.update(0);
  draw();
}

// ── Mensajes con la extensión ──────────────────────────────

async function initViewer(message) {
  const render = message.render && typeof message.render === "object" ? message.render : {};
  // El motor llega en cada `init` y no vive en el estado de la pestaña: se acepta siempre.
  renderEngine = render.engine === "blender" ? "blender" : "visor";
  el.engine.value = renderEngine;

  // El host reenvía `init` tras cambiar de Blender: solo se salta si el GLB es el mismo.
  if (initSeen && message.glb === glbCargado) return;
  glbCargado = message.glb;
  initSeen = true;
  const seq = ++initSeq;
  // Mientras se reconstruye no se guarda el estado con datos de la escena vieja.
  estadoListo = false;

  meta = message.meta || {};
  fps = Number(meta.fps) > 0 ? Number(meta.fps) : 24;
  paintHeader();

  // base y dir los persiste el host: se aceptan tal cual vengan.
  el.base.value = typeof render.base === "string" ? render.base : meta.file || "";
  renderDir = typeof render.dir === "string" && render.dir ? render.dir : null;
  paintDir();

  setHud("CARGANDO ESCENA…", "busy");
  setStatus("Cargando el GLB exportado…");

  if (!ensureRenderer()) return;

  try {
    const gltf = await new GLTFLoader().loadAsync(message.glb);
    // Otro init más nuevo ganó mientras cargaba este.
    if (seq !== initSeq) return;
    buildScene(gltf);
  } catch (error) {
    if (seq !== initSeq) return;
    showError("No se ha podido cargar la escena exportada." + detailOf(error));
  }
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "init":
      void initViewer(message);
      return;
    case "error":
      showError(String(message.message || "La escena no se ha podido preparar."));
      return;
    case "blender":
      paintBlender(message);
      return;
    case "renderDir":
      renderDir = typeof message.dir === "string" && message.dir ? message.dir : null;
      paintDir();
      enviarAjustes();
      return;
    case "renderProgress":
      onRenderProgress(message);
      return;
    case "renderDone":
      onRenderDone(message);
      return;
    case "renderFailed":
      onRenderFailed(message);
      return;
    case "renderCancelled":
      onRenderCancelled();
      return;
  }
});

// ── Controles ──────────────────────────────────────────────

el.clips.addEventListener("change", () => {
  selectClip(el.clips.value === "" ? -1 : Number(el.clips.value));
});

el.frame.addEventListener("input", () => {
  const value = clamp(intOr(el.frame.value, frame), rangeStart, rangeEnd);
  frame = value;
  playPos = frame;
  el.frameOut.textContent = String(frame);
  poseAt(playPos);
  saveState();
});

el.start.addEventListener("change", commitRange);
el.end.addEventListener("change", commitRange);

el.btnIni.addEventListener("click", () => {
  frame = rangeStart;
  playPos = frame;
  paintFrame();
  poseAt(playPos);
  saveState();
});

el.btnPlay.addEventListener("click", () => {
  if (!clip) return;
  if (playing) {
    setPlaying(false);
    return;
  }
  if (frame >= rangeEnd) {
    frame = rangeStart;
    paintFrame();
  }
  setPlaying(true);
});

el.btnStop.addEventListener("click", () => {
  setPlaying(false);
  frame = rangeStart;
  playPos = frame;
  paintFrame();
  poseAt(playPos);
  saveState();
});

el.btnLoop.addEventListener("click", () => {
  loop = !loop;
  refresh();
});

el.btnStill.addEventListener("click", () => {
  if (rendering || !booted) return;
  enviarAjustes();
  if (renderEngine === "visor") {
    fotoVisor();
    return;
  }
  const { base, dir } = datosRender();
  setStatus(`Pidiendo el render del frame ${frame}.`);
  vscode.postMessage({ type: "renderStill", frame, base, dir });
});

el.btnAnim.addEventListener("click", () => {
  if (rendering || !booted) return;
  if (!commitRange()) return;
  renderStart = rangeStart;
  renderEnd = rangeEnd;
  const total = renderEnd - renderStart + 1;
  enviarAjustes();
  const { base, dir } = datosRender();
  if (renderEngine === "visor") {
    setStatus(`Capturando ${cuenta(total, "PNG", "PNG")} (frames ${renderStart}…${renderEnd}).`);
    void animacionVisor(base, dir, renderStart, renderEnd);
    return;
  }
  setStatus(`Pidiendo ${cuenta(total, "PNG", "PNG")} (frames ${renderStart}…${renderEnd}).`);
  vscode.postMessage({ type: "renderAnimation", start: renderStart, end: renderEnd, base, dir });
});

el.btnCancel.addEventListener("click", () => {
  setStatus("Cancelando el render…");
  // El visor captura dentro del webview: no hay proceso que matar, solo la bandera.
  if (renderingVisor) {
    cancelVisor = true;
    return;
  }
  vscode.postMessage({ type: "cancelRender" });
});

/** El motor viaja con el resto de ajustes de render; cambiarlo se manda al momento. */
el.engine.addEventListener("change", () => {
  renderEngine = el.engine.value === "blender" ? "blender" : "visor";
  enviarAjustes();
});

// El host abre el diálogo de carpeta y responde con `renderDir`.
el.btnDir.addEventListener("click", () => {
  if (rendering || !booted) return;
  vscode.postMessage({ type: "pickDir" });
});

// BASE se persiste en el host con retardo; los renders fuerzan el envío antes.
el.base.addEventListener("input", () => programarAjustes());

el.textures.addEventListener("change", () => setTextures(el.textures.checked));

// El diálogo del host no manda respuesta: un solo `pickBlender` por segundo basta.
el.btnBlender.addEventListener("click", () => {
  const now = Date.now();
  if (now - lastPick < PICK_GUARD_MS) return;
  lastPick = now;
  vscode.postMessage({ type: "pickBlender" });
});

// Mayús + botón central desplaza la vista, como en Blender. Se cambia solo el gesto del
// botón central; el resto de atajos del visor no existen.
window.addEventListener("keydown", (event) => {
  if (event.key === "Shift" && controls) controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
});

window.addEventListener("keyup", (event) => {
  if (event.key === "Shift" && controls) controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
});

// Sin keyup (la ventana pierde el foco con Mayús pulsado) el botón central se queda paneando.
window.addEventListener("blur", () => {
  if (controls) controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
});

if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => resize()).observe(el.stage);
}
window.addEventListener("resize", () => resize());

// Con la pestaña oculta se para el bucle; al volver, el reloj parte de cero.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // La pestaña se destruye al ocultarse: este es el último momento para guardar el frame.
    saveState();
    stopLoop();
  } else if (booted) {
    startLoop();
    draw();
  }
});

refresh();
vscode.postMessage({ type: "ready" });
