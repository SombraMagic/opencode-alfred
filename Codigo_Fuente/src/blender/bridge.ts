/**
 * Puente con Blender CLI para el Visor Alfred 3D: encuentra el ejecutable, exporta el
 * `.blend` a GLB con `resources/alfred3d-export.py` (caché por ruta) y lanza renders PNG.
 * Si junto al `.blend` hay un sidecar `<stem>.glb` más nuevo que él, se usa sin Blender.
 * El `.blend` solo se abre en modo `-b`: nunca se guarda ni se modifica.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

/** Cambia cuando cambia el formato del meta o los flags de exportación: invalida la caché. */
const EXPORT_VERSION = 1;
/** Un .blend grande con muchas acciones puede tardar; 5 min sobra y no deja el proceso colgado. */
const EXPORT_TIMEOUT_MS = 300_000;
/** Un frame de Cycles puede tardar, pero no cuelga el panel para siempre. */
const STILL_TIMEOUT_MS = 15 * 60 * 1000;
const BLENDER_ROOT = process.env.ProgramFiles
  ? join(process.env.ProgramFiles, "Blender Foundation")
  : "C:\\Program Files\\Blender Foundation";
/** Claves del registro de Windows donde se instalan las versiones de Blender. */
const REGISTRY_UNINSTALL = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

export type SceneMeta = {
  version: 1;
  file: string;
  fps: number;
  frameStart: number;
  frameEnd: number;
  frameCurrent: number;
  engine: string;
  /** `null` en las escenas leídas del sidecar: el GLB no guarda ajustes de render. */
  resolution: { x: number; y: number; percent: number } | null;
  camera: string | null;
  objects: { name: string; type: string; visible: boolean }[];
  /** `orthoScale` solo la trae el meta escrito por Blender; el sintetizado del GLB no. */
  cameras: { name: string; type: string; lens: number; orthoScale?: number }[];
  lights: { name: string; type: string }[];
  animations: { name: string; start: number; end: number }[];
};

/** Cancelación pedida desde el panel: no es un fallo del render. */
export class RenderCancelledError extends Error {
  constructor() {
    super("Render cancelado.");
    this.name = "RenderCancelledError";
  }
}

/** Solo se cachea el positivo: si el usuario instala Blender o ajusta la ruta, se ve sin recargar. */
let blenderCache: string | undefined;
/** Búsqueda en vuelo: el primer `ready` pide Blender desde dos sitios a la vez. */
let buscando: Promise<string | undefined> | undefined;
/** Sube al invalidar la caché: una exportación vieja no puede publicar encima. */
let generacion = 0;

/** Versión leída de `blender.exe -v`, cacheada por ruta y mtime del ejecutable. */
const versionCache = new Map<string, { mtimeMs: number; version: string }>();

/** Ruta de `blender.exe`: el ajuste manda; sin él, la versión más alta detectada. */
export async function findBlender(): Promise<string | undefined> {
  if (blenderCache) {
    return blenderCache;
  }
  if (!buscando) {
    buscando = locateBlender()
      .then((ruta) => {
        blenderCache = ruta;
        return ruta;
      })
      .finally(() => {
        buscando = undefined;
      });
  }
  return buscando;
}

async function locateBlender(): Promise<string | undefined> {
  const configurado = vscode.workspace
    .getConfiguration("opencodeAgents")
    .get<string>("blenderPath", "")
    .trim();
  // Elegir Blender a mano gana siempre: así se puede forzar un 3.6 aunque haya un 5.2.
  if (configurado && existsSync(configurado)) {
    return configurado;
  }

  const candidatos = new Set<string>();
  // Las fuentes son independientes: una que falle no debe tumbar las demás.
  const fuentes = await Promise.all([
    desdePath(),
    enProgramFiles(),
    process.platform === "win32" ? desdeRegistro() : Promise.resolve([]),
  ]);
  for (const lista of fuentes) {
    for (const exe of lista) {
      if (existsSync(exe)) {
        candidatos.add(exe);
      }
    }
  }
  if (!candidatos.size) {
    return undefined;
  }

  // La versión real manda sobre el nombre de la carpeta: 5.2.2 gana a 4.4 y a 3.6.
  const versiones = await Promise.all(
    [...candidatos].map(async (exe) => ({ exe, version: await blenderVersion(exe) }))
  );
  versiones.sort((a, b) => compareVersions(b.version, a.version));
  return versiones[0].exe;
}

/** Versión de un `blender.exe` concreto; `""` si no responde. */
export async function blenderVersion(exe: string): Promise<string> {
  try {
    const info = await stat(exe);
    const cacheado = versionCache.get(exe);
    if (cacheado && cacheado.mtimeMs === info.mtimeMs) {
      return cacheado.version;
    }
    const { stdout } = await execFileAsync(exe, ["-v"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const version = /Blender\s+(\d+(?:\.\d+)+)/i.exec(String(stdout))?.[1] ?? "";
    versionCache.set(exe, { mtimeMs: info.mtimeMs, version });
    return version;
  } catch {
    return "";
  }
}

async function desdePath(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["blender"], {
      windowsHide: true,
      timeout: 5000,
    });
    return String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /blender(\.exe)?$/i.test(line) && existsSync(line));
  } catch {
    // Sin PATH.
    return [];
  }
}

async function enProgramFiles(): Promise<string[]> {
  try {
    return (await readdir(BLENDER_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("Blender "))
      .map((entry) => join(BLENDER_ROOT, entry.name, "blender.exe"))
      .filter((exe) => existsSync(exe));
  } catch {
    // Sin carpeta de instalación.
    return [];
  }
}

/** Instalaciones que solo aparecen en «Aplicaciones instaladas» (p. ej. `E:\Blender`). */
async function desdeRegistro(): Promise<string[]> {
  const consultas = await Promise.all(
    REGISTRY_UNINSTALL.map(async (clave) => {
      try {
        const { stdout } = await execFileAsync("reg.exe", ["query", clave, "/s"], {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 32 * 1024 * 1024,
          // reg.exe escribe en la página OEM de la consola: en utf8 las secuencias
          // inválidas se convierten en U+FFFD y una ruta con acentos se pierde.
          encoding: "latin1",
        });
        return String(stdout);
      } catch {
        // Clave ausente o `reg.exe` sin permiso: se sigue con las demás.
        return "";
      }
    })
  );

  const encontrados: string[] = [];
  for (const salida of consultas) {
    // Cada entrada es un bloque: cabecera HKEY y valores `Nombre REG_SZ valor`.
    for (const bloque of salida.split(/\r?\n\r?\n/)) {
      const nombre = /^\s+DisplayName\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(bloque);
      if (!nombre || !/^blender\b/i.test(nombre[1].trim())) {
        continue;
      }
      const ubicacion = /^\s+InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(bloque);
      if (!ubicacion) {
        continue;
      }
      const exe = join(ubicacion[1].trim(), "blender.exe");
      if (existsSync(exe)) {
        encontrados.push(exe);
      }
    }
  }
  return encontrados;
}

/** Compara versiones por tramos numéricos: "4.10" va después de "4.4". */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Última parte útil de la salida de Blender, sin arrastrar el comando entero. */
function salidaUtil(raw: string): string {
  const limpio = raw.replace(/\r/g, "").trim();
  if (!limpio) {
    return "";
  }
  const lineas = limpio.split("\n");
  const idx = lineas.findIndex((linea) =>
    /error|incomplete|not a blend|cannot|exception/i.test(linea)
  );
  const bloque = (idx >= 0 ? lineas.slice(idx) : lineas).join("\n").trim();
  return bloque.length > 600 ? `…${bloque.slice(-600)}` : bloque;
}

/** `execFile` falla con «Command failed: …»: la causa está en stderr y no se ve. */
function errorDeProceso(err: unknown): Error {
  const salida = err as { stderr?: string | Buffer; stdout?: string | Buffer };
  const detalle =
    (salida?.stderr ? salidaUtil(String(salida.stderr)) : "") ||
    (salida?.stdout ? salidaUtil(String(salida.stdout)) : "");
  if (detalle) {
    return new Error(`Blender: ${detalle}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Carpeta de caché de todos los .blend exportados. */
export function alfred3dRoot(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, "alfred3d");
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Caché fuera: al cambiar de Blender los GLB exportados por el anterior dejan de valer. */
export async function invalidateSceneCache(context: vscode.ExtensionContext): Promise<void> {
  generacion++;
  blenderCache = undefined;
  await rm(alfred3dRoot(context), { recursive: true, force: true }).catch(() => undefined);
}

/** Escena lista para el visor: el mtime sirve de versión en la URI del GLB. */
export type Scene = { glb: string; meta: SceneMeta; mtime: number };

/** Meta válido solo si existe, su versión es la actual y no es más viejo que el `.blend`. */
async function freshScene(
  blendPath: string,
  glb: string,
  metaPath: string
): Promise<{ meta: SceneMeta; mtime: number } | undefined> {
  try {
    const [blendStat, glbStat, metaStat, raw] = await Promise.all([
      stat(blendPath),
      stat(glb),
      stat(metaPath),
      readFile(metaPath, "utf8"),
    ]);
    if (glbStat.mtimeMs < blendStat.mtimeMs || metaStat.mtimeMs < blendStat.mtimeMs) {
      return undefined;
    }
    const meta = JSON.parse(raw) as SceneMeta;
    return meta.version === EXPORT_VERSION ? { meta, mtime: glbStat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/** Partes del JSON de un GLB que interesan para sintetizar el meta. */
type GlbJson = {
  nodes?: {
    name?: string;
    children?: number[];
    mesh?: number;
    camera?: number;
    extensions?: { KHR_lights_punctual?: { light?: number } };
  }[];
  skins?: { skeleton?: number; joints?: number[] }[];
  cameras?: { type?: string; perspective?: { yfov?: number }; orthographic?: { xmag?: number } }[];
  extensions?: { KHR_lights_punctual?: { lights?: { type?: string }[] } };
  animations?: { name?: string; samplers?: { input?: number }[] }[];
  accessors?: { max?: number[] }[];
};

const GLB_MAGIC = 0x46546c67; // "glTF" en little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"

/** Lee un rango entero: `FileHandle.read` puede cortar y un JSON a medias no se parsea. */
async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) {
      break; // EOF antes de cerrar el rango: el fichero es más corto de lo que dice su cabecera
    }
    done += bytesRead;
  }
  if (done !== length) {
    throw new Error("El GLB está truncado.");
  }
  return buffer;
}

/** Lee solo el chunk JSON del GLB: el binario (mallas y texturas) no se llega a tocar. */
async function readGlbJson(glbPath: string): Promise<GlbJson> {
  const handle = await open(glbPath, "r");
  try {
    // Un GLB corrupto puede declarar chunks enormes: sin este tope, readRange reservaría ese buffer.
    const size = (await handle.stat()).size;
    const head = await readRange(handle, 0, 12);
    if (head.readUInt32LE(0) !== GLB_MAGIC) {
      throw new Error("El GLB no tiene cabecera glTF.");
    }
    const total = head.readUInt32LE(8);
    for (let off = 12; off + 8 <= total; ) {
      const chunk = await readRange(handle, off, 8);
      const len = chunk.readUInt32LE(0);
      if (chunk.readUInt32LE(4) === GLB_CHUNK_JSON) {
        if (off + 8 + len > size) {
          throw new Error("El GLB está truncado.");
        }
        const body = await readRange(handle, off + 8, len);
        return JSON.parse(body.toString("utf8")) as GlbJson;
      }
      off += 8 + len;
    }
    throw new Error("El GLB no trae chunk JSON.");
  } finally {
    await handle.close();
  }
}

/** Meta de un GLB sin `meta.json` al lado: lo justo para pintar los controles del visor. */
export async function synthesizeMetaFromGlb(glbPath: string): Promise<SceneMeta> {
  const glb = await readGlbJson(glbPath);
  const nodes = Array.isArray(glb.nodes) ? glb.nodes : [];
  const skins = Array.isArray(glb.skins) ? glb.skins : [];
  const lightDefs = glb.extensions?.KHR_lights_punctual?.lights ?? [];

  // Índice hijo → padre: hace falta porque el exportador de Blender omite `skin.skeleton`.
  const parentOf = new Map<number, number>();
  nodes.forEach((node, i) =>
    (Array.isArray(node.children) ? node.children : []).forEach((child) => parentOf.set(child, i))
  );

  const skeletonIdx = new Set<number>();
  for (const skin of skins) {
    if (typeof skin.skeleton === "number") {
      skeletonIdx.add(skin.skeleton);
      continue;
    }
    const joints = new Set(skin.joints ?? []);
    let up = joints.size ? parentOf.get([...joints][0]) : undefined;
    // Subir por la cadena de huesos hasta el primer ancestro que no sea joint: la raíz del armazón.
    while (up !== undefined && joints.has(up)) {
      up = parentOf.get(up);
    }
    if (up !== undefined) {
      skeletonIdx.add(up);
    }
  }

  const objects: SceneMeta["objects"] = [];
  const cameras: SceneMeta["cameras"] = [];
  const lights: SceneMeta["lights"] = [];
  nodes.forEach((node, i) => {
    const name = node.name || `Nodo ${i}`;
    if (typeof node.mesh === "number") {
      objects.push({ name, type: "MESH", visible: true });
      return;
    }
    if (skeletonIdx.has(i)) {
      objects.push({ name, type: "ARMATURE", visible: true });
      return;
    }
    if (typeof node.camera === "number") {
      objects.push({ name, type: "CAMERA", visible: true });
      const def = glb.cameras?.[node.camera];
      const type = def?.type === "orthographic" ? "ORTHO" : "PERSPECTIVE";
      // Lens en mm sobre el sensor de 36 mm, como sacaba Blender del .blend; la webview solo usa el nombre.
      const lens =
        type === "ORTHO"
          ? def?.orthographic?.xmag ?? 50
          : 36 / (2 * Math.tan((def?.perspective?.yfov ?? Math.PI / 3) / 2));
      cameras.push({ name, type, lens });
      return;
    }
    const lightIdx = node.extensions?.KHR_lights_punctual?.light;
    if (typeof lightIdx === "number") {
      objects.push({ name, type: "LIGHT", visible: true });
      const gltfType = String(lightDefs[lightIdx]?.type ?? "point");
      lights.push({ name, type: gltfType === "directional" ? "SUN" : gltfType.toUpperCase() });
    }
  });

  const animations = (Array.isArray(glb.animations) ? glb.animations : []).map((anim, i) => {
    let seconds = 0;
    for (const sampler of anim.samplers ?? []) {
      const max = typeof sampler.input === "number" ? glb.accessors?.[sampler.input]?.max : undefined;
      if (max && max[0] > seconds) {
        seconds = max[0];
      }
    }
    return { name: anim.name || `Anim ${i}`, start: 0, end: Math.max(1, Math.round(seconds * 24)) };
  });

  return {
    version: EXPORT_VERSION,
    file: basename(glbPath, extname(glbPath)),
    fps: 24,
    frameStart: 1,
    frameEnd: animations.reduce((fin, anim) => Math.max(fin, anim.end), 1),
    frameCurrent: 1,
    engine: "GLB",
    resolution: null,
    camera: null,
    objects,
    cameras,
    lights,
    animations,
  };
}

/** GLB y meta publicados junto al `.blend`: los controla el usuario, no nuestra caché. */
export async function sidecarScene(blendPath: string): Promise<Scene | undefined> {
  const stem = basename(blendPath, extname(blendPath));
  const glb = join(dirname(blendPath), `${stem}.glb`);
  const metaPath = join(dirname(blendPath), `${stem}.meta.json`);
  let blendStat;
  let glbStat;
  try {
    [blendStat, glbStat] = await Promise.all([stat(blendPath), stat(glb)]);
  } catch {
    return undefined; // sin sidecar: se sigue por la caché y Blender
  }
  if (glbStat.mtimeMs < blendStat.mtimeMs) {
    return undefined; // el `.blend` cambió después de publicar el GLB
  }
  let meta: SceneMeta | undefined;
  try {
    const junto = JSON.parse(await readFile(metaPath, "utf8")) as SceneMeta;
    if (junto.version === EXPORT_VERSION) {
      meta = junto;
    }
  } catch {
    // Sin meta válido al lado: se sintetiza del propio GLB.
  }
  if (!meta) {
    try {
      meta = await synthesizeMetaFromGlb(glb);
    } catch {
      // Un sidecar ilegible no puede tumbar la pestaña: se cede a la caché y a Blender.
      return undefined;
    }
  }
  return { glb, meta, mtime: glbStat.mtimeMs };
}

/** GLB + meta del `.blend`, exportando con Blender solo si la caché no vale. */
export async function ensureScene(
  context: vscode.ExtensionContext,
  blendPath: string
): Promise<Scene> {
  // Un GLB publicado junto al `.blend` manda sobre todo: ni caché ni Blender.
  const sidecar = await sidecarScene(blendPath);
  if (sidecar) {
    return sidecar;
  }

  const dir = join(alfred3dRoot(context), sha1Hex(blendPath));
  const glb = join(dir, "scene.glb");
  const metaPath = join(dir, "meta.json");
  // Cualquier invalidación durante la exportación invalida esta: su carpeta ya no existe.
  const gen = generacion;

  // La caché se mira antes de buscar Blender: una escena ya exportada abre sin él.
  const cached = await freshScene(blendPath, glb, metaPath);
  if (cached) {
    return { glb, meta: cached.meta, mtime: cached.mtime };
  }

  const blender = await findBlender();
  if (!blender) {
    throw new Error(
      "No encuentro Blender. Instálalo o indica la ruta en el ajuste opencodeAgents.blenderPath."
    );
  }

  await mkdir(dir, { recursive: true });
  // Se exporta a temporales y solo se publican si el meta temporal es válido: un fallo de
  // Blender no puede dejar la caché con un GLB nuevo y un meta viejo (o al revés).
  const tmpGlb = join(dir, "scene.tmp.glb");
  const tmpMeta = join(dir, "meta.tmp.json");
  const script = join(context.extensionUri.fsPath, "resources", "alfred3d-export.py");
  try {
    await execFileAsync(
      blender,
      [
        "-b",
        blendPath,
        "-noaudio",
        "--python-exit-code",
        "1",
        "--python",
        script,
        "--",
        tmpGlb,
        tmpMeta,
        String(EXPORT_VERSION),
      ],
      { windowsHide: true, timeout: EXPORT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    );

    if (!existsSync(tmpGlb) || !existsSync(tmpMeta)) {
      throw new Error("Blender no generó el GLB o el meta de la escena.");
    }
    const meta = JSON.parse(await readFile(tmpMeta, "utf8")) as SceneMeta;
    if (meta.version !== EXPORT_VERSION) {
      throw new Error("La exportación devolvió un meta de otra versión.");
    }
    if (generacion !== gen) {
      throw new Error("La caché se invalidó durante la exportación.");
    }
    await mkdir(dir, { recursive: true });
    await rename(tmpGlb, glb);
    await rename(tmpMeta, metaPath);
    return { glb, meta, mtime: (await stat(glb)).mtimeMs };
  } catch (err) {
    await Promise.all([rm(tmpGlb, { force: true }), rm(tmpMeta, { force: true })]).catch(
      () => undefined
    );
    // Un fallo de Blender (p. ej. «incomplete header») tiene que llegar a la webview.
    throw errorDeProceso(err);
  }
}

/** Escribe de forma atómica (tmp + rename), como el resto del paquete. */
export async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** Render de un frame a un temporal propio y copia del PNG al destino. Cancelable. */
export function renderStill(opts: {
  blender: string;
  blend: string;
  frame: number;
  outPath: string;
}): RenderJob<string> {
  let child: ChildProcess | undefined;
  let cancelled = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stderr = "";

  const cancel = (): void => {
    cancelled = true;
    killTree(child);
  };

  const done = (async () => {
    const tmp = await mkdtemp(join(tmpdir(), "alfred3d-"));
    try {
      child = spawn(
        opts.blender,
        [
          "-b",
          opts.blend,
          "-noaudio",
          "-F",
          "PNG",
          "-o",
          join(tmp, "frame_####"),
          "-f",
          String(opts.frame),
        ],
        { windowsHide: true }
      );
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      timer = setTimeout(() => {
        expired = true;
        killTree(child);
      }, STILL_TIMEOUT_MS);
      // La cancelación puede llegar antes de que el proceso exista.
      if (cancelled) {
        killTree(child);
      }
      const code = await new Promise<number | null>((resolve, reject) => {
        child?.once("error", reject);
        child?.once("close", resolve);
      });
      if (cancelled) {
        throw new RenderCancelledError();
      }
      if (expired) {
        throw new Error("Blender no terminó el render en 15 minutos.");
      }
      if (code !== 0) {
        throw new Error(
          `Blender: ${salidaUtil(stderr) || `terminó con código ${code}.`}`
        );
      }
      const png = (await readdir(tmp)).find((file) => file.toLowerCase().endsWith(".png"));
      if (!png) {
        throw new Error("Blender no generó ningún PNG.");
      }
      await writeAtomic(opts.outPath, await readFile(join(tmp, png)));
      return opts.outPath;
    } finally {
      clearTimeout(timer);
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  return { done, cancel };
}

/** Mata el proceso y sus hijos: Blender lanza su propio árbol. */
function killTree(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    void execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
  } else {
    child.kill();
  }
}

export type RenderJob<T = number> = { done: Promise<T>; cancel(): void };

/** Nombre de fichero seguro en Windows: sin caracteres prohibidos ni punto/espacio final. */
export function safeBase(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return clean || "frame";
}

/** Render de una animación completa; devuelve un job cancelable y los PNG escritos. */
export function renderAnimation(opts: {
  blender: string;
  blend: string;
  start: number;
  end: number;
  dir: string;
  base: string;
  onFrame?: (frame: number) => void;
}): RenderJob {
  const base = safeBase(opts.base);
  let child: ChildProcess | undefined;
  let cancelled = false;
  let stderr = "";
  // Solo cuentan los PNG de esta tirada: una anterior con la misma base no infla el número.
  const t0 = Date.now();

  const cancel = (): void => {
    cancelled = true;
    killTree(child);
  };

  const done = new Promise<number>((resolve, reject) => {
    void (async () => {
      await mkdir(opts.dir, { recursive: true });
      if (cancelled) {
        reject(new RenderCancelledError());
        return;
      }
      child = spawn(
        opts.blender,
        [
          "-b",
          opts.blend,
          "-noaudio",
          "-F",
          "PNG",
          "-o",
          join(opts.dir, `${base}_frame####`),
          "-s",
          String(opts.start),
          "-e",
          String(opts.end),
          "-a",
        ],
        { windowsHide: true }
      );

      let buffered = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const match = /Fra:(\d+)/.exec(line);
          if (match) {
            opts.onFrame?.(Number(match[1]));
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        void (async () => {
          if (cancelled) {
            reject(new RenderCancelledError());
            return;
          }
          if (code !== 0) {
            reject(
              new Error(`Blender: ${salidaUtil(stderr) || `terminó con código ${code}.`}`)
            );
            return;
          }
          const files = await readdir(opts.dir);
          // Prefijo y rango ya acotan; el mtime descarta ficheros viejos que quedasen dentro.
          const first = `${base}_frame`;
          const candidatos = files.filter((file) => {
            if (!file.startsWith(first) || !file.toLowerCase().endsWith(".png")) {
              return false;
            }
            const digits = file.slice(first.length, -4);
            if (!/^\d+$/.test(digits)) {
              return false;
            }
            const frame = Number(digits);
            return frame >= opts.start && frame <= opts.end;
          });
          const recientes = await Promise.all(
            candidatos.map(async (file) => {
              try {
                return (await stat(join(opts.dir, file))).mtimeMs >= t0;
              } catch {
                return false;
              }
            })
          );
          resolve(candidatos.filter((_, i) => recientes[i]).length);
        })().catch(reject);
      });
    })().catch(reject);
  });

  return { done, cancel };
}
