/** Mente local: el cerebro Ollama del equipo, encendido y apagado desde su panel. */

import * as vscode from "vscode";
import { mkdir, statfs } from "node:fs/promises";
import {
  ollamaLoaded,
  ollamaPull,
  ollamaRemove,
  ollamaTags,
  ollamaVersion,
  OllamaTag,
} from "./client";
import {
  detectInstall,
  installOllama,
  modelsDir,
  modelsOnDisk,
  startServer,
  stopServer,
  uninstallOllama,
} from "./process";
import { removeOllamaProvider, writeOllamaProvider } from "./provider";
import { PUERTO_DEFECTO, puertoValido, ServidorTraduccion } from "./translate";

const MENTE_LOCAL_KEY = "opencodeAgents.menteLocal";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
/** Puerto elegido para el servicio de traducción. */
const TRADUCCION_PUERTO_KEY = "opencodeAgents.traduccion.puerto";
/** Intención de la persona: encendido al cerrar VS Code → se reenciende solo al volver (con Ollama arriba). */
const TRADUCCION_ACTIVO_KEY = "opencodeAgents.traduccion.activo";
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;

export interface MenteLocalSettings {
  enabled: boolean;
  baseURL: string;
  /** Preferencia interna de Alfred (el chip USAR): no se escribe en el config de opencode. */
  model: string;
}

export interface OllamaModel {
  name: string;
  sizeBytes: number;
  modified: string;
  family: string | null;
  parameters: string | null;
  loaded: boolean;
}

export interface MenteLocalState {
  installed: boolean;
  version: string | null;
  running: boolean;
  enabled: boolean;
  baseURL: string;
  model: string;
  models: OllamaModel[];
  modelsBytes: number;
  freeBytes: number | null;
  modelsDir: string;
  busy: string | null;
  pull: { model: string; status: string; completed: number; total: number } | null;
  message: string | null;
  traduccion: TraduccionState;
}

/** Servicio de traducción local: vive solo mientras el check está encendido. */
export interface TraduccionState {
  activo: boolean;
  puerto: number;
  /** Último fallo al arrancar (puerto ocupado, Ollama parado…). */
  error: string | null;
}

export type MenteLocalAction =
  | { type: "refresh" }
  | { type: "setEnabled"; on: boolean }
  | { type: "install" }
  | { type: "uninstall" }
  | { type: "pull"; model: string }
  | { type: "cancelPull" }
  | { type: "delete"; model: string }
  | { type: "setModel"; model: string }
  | { type: "setBaseURL"; url: string }
  | { type: "startServer" }
  | { type: "stopServer" }
  | { type: "openModelsDir" }
  | { type: "setTraduccion"; on: boolean }
  | { type: "setTraduccionPuerto"; port: number }
  | { type: "openChatbot" }
  | { type: "openTraduccion" };

// Estado vivo, en memoria: `collectState` no escribe nada y el panel se repinta con él.
let busy: string | null = null;
let message: string | null = null;
let pullState: MenteLocalState["pull"] = null;
let pullController: AbortController | undefined;
let inFlight = false;
let traduccionError: string | null = null;
let servidorTraduccion: ServidorTraduccion | undefined;
let traduccionEnCurso = false;

function normalizeURL(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export function readSettings(context: vscode.ExtensionContext): MenteLocalSettings {
  const stored = context.globalState.get<Partial<MenteLocalSettings>>(MENTE_LOCAL_KEY);
  const baseURL = normalizeURL(stored?.baseURL);
  return {
    enabled: stored?.enabled === true,
    baseURL: /^https?:\/\//.test(baseURL) ? baseURL : DEFAULT_BASE_URL,
    model: typeof stored?.model === "string" ? stored.model : "",
  };
}

async function saveSettings(
  context: vscode.ExtensionContext,
  settings: MenteLocalSettings
): Promise<void> {
  await context.globalState.update(MENTE_LOCAL_KEY, settings);
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

export async function collectState(context: vscode.ExtensionContext): Promise<MenteLocalState> {
  const settings = readSettings(context);
  const install = await detectInstall();
  let version = install.version;
  let running = false;
  let tags: OllamaTag[] = [];
  let loaded: string[] = [];
  try {
    version = await ollamaVersion(settings.baseURL);
    running = true;
    [tags, loaded] = await Promise.all([
      ollamaTags(settings.baseURL),
      ollamaLoaded(settings.baseURL).catch(() => [] as string[]),
    ]);
  } catch {
    running = false;
  }
  const models: OllamaModel[] = running
    ? tags.map((tag) => ({
        name: tag.name,
        sizeBytes: tag.size,
        modified: tag.modified_at,
        family: tag.details?.family ?? null,
        parameters: tag.details?.parameter_size ?? null,
        loaded: loaded.includes(tag.name),
      }))
    : (await modelsOnDisk()).map((model) => ({
        name: model.name,
        sizeBytes: model.sizeBytes,
        modified: model.modified,
        family: null,
        parameters: null,
        loaded: false,
      }));
  const dir = modelsDir();
  return {
    installed: install.present,
    version,
    running,
    enabled: settings.enabled,
    baseURL: settings.baseURL,
    model: settings.model,
    models,
    modelsBytes: models.reduce((sum, model) => sum + model.sizeBytes, 0),
    freeBytes: await freeBytes(dir),
    modelsDir: dir,
    busy,
    pull: pullState,
    message,
    traduccion: traduccionState(context),
  };
}

// ── Servicio de traducción ──────────────────────────────────────────────────

export function traduccionPuerto(context: vscode.ExtensionContext): number {
  const value = context.globalState.get<unknown>(TRADUCCION_PUERTO_KEY);
  return puertoValido(value) ? value : PUERTO_DEFECTO;
}

export function traduccionState(context: vscode.ExtensionContext): TraduccionState {
  const activo = !!servidorTraduccion?.activo;
  return {
    activo,
    puerto: activo ? servidorTraduccion!.puerto : traduccionPuerto(context),
    error: traduccionError,
  };
}

/**
 * Enciende o apaga la API de traducción. Solo arranca con el servidor de Ollama
 * respondiendo; si Ollama se para después, el servicio sigue y contesta 503.
 */
async function setTraduccion(context: vscode.ExtensionContext, on: boolean): Promise<void> {
  traduccionError = null;
  if (!on) {
    await context.globalState.update(TRADUCCION_ACTIVO_KEY, false);
    await stopTranslation();
    message = "Servicio de traducción apagado.";
    return;
  }
  if (servidorTraduccion?.activo) {
    return;
  }
  const { baseURL } = readSettings(context);
  try {
    await ollamaVersion(baseURL);
  } catch {
    traduccionError = "Ollama no responde: arranca el servidor antes de encender la traducción.";
    return;
  }
  const servidor = new ServidorTraduccion(() => {
    const settings = readSettings(context);
    return { baseURL: settings.baseURL, model: settings.model };
  });
  const puerto = traduccionPuerto(context);
  // Se asigna antes del `await`: un `stopTranslation()` (dispose) a medio arrancar lo para.
  servidorTraduccion = servidor;
  try {
    await servidor.iniciar(puerto);
  } catch (err) {
    if (servidorTraduccion === servidor) {
      servidorTraduccion = undefined;
    }
    traduccionError = err instanceof Error ? err.message : String(err);
    return;
  }
  if (servidorTraduccion !== servidor) {
    return; // Lo paró `stopTranslation()` mientras arrancaba.
  }
  await context.globalState.update(TRADUCCION_ACTIVO_KEY, true);
  message = `Servicio de traducción escuchando en http://127.0.0.1:${puerto}.`;
}

/**
 * Reenciende el servicio al activar la extensión si así se dejó. Lo llama el sondeo de Mente
 * local cuando Ollama pasa a responder: un intento por transición, sin notificaciones.
 * Devuelve true si cambió el estado del servicio (para repintar).
 */
export async function autoEncenderTraduccion(context: vscode.ExtensionContext): Promise<boolean> {
  if (!context.globalState.get<boolean>(TRADUCCION_ACTIVO_KEY, false)) {
    return false;
  }
  if (servidorTraduccion?.activo || traduccionEnCurso) {
    return false;
  }
  traduccionEnCurso = true;
  try {
    await setTraduccion(context, true);
  } catch (err) {
    traduccionError = err instanceof Error ? err.message : String(err);
  } finally {
    traduccionEnCurso = false;
  }
  return true;
}

async function setTraduccionPuerto(context: vscode.ExtensionContext, port: number): Promise<void> {
  if (servidorTraduccion?.activo) {
    traduccionError = "Apaga el servicio antes de cambiar el puerto.";
    return;
  }
  if (!puertoValido(port)) {
    traduccionError = "Puerto no válido: usa un número entre 1024 y 65535.";
    return;
  }
  await context.globalState.update(TRADUCCION_PUERTO_KEY, port);
  traduccionError = null;
  message = `Puerto del servicio de traducción: ${port}.`;
}

/** Para la API de traducción (al apagar el check y al desactivar la extensión). */
export async function stopTranslation(): Promise<void> {
  const servidor = servidorTraduccion;
  servidorTraduccion = undefined;
  await servidor?.parar();
}

async function enable(context: vscode.ExtensionContext): Promise<void> {
  const settings = readSettings(context);
  busy = "arrancando";
  await startServer(settings.baseURL);
  busy = "guardando";
  let names: string[] = [];
  try {
    names = (await ollamaTags(settings.baseURL)).map((tag) => tag.name);
  } catch {
    names = [];
  }
  const model = names.includes(settings.model) ? settings.model : names[0] ?? "";
  let file: string;
  try {
    file = await writeOllamaProvider(settings.baseURL, names);
  } catch (err) {
    // Sin proveedor no hay cerebro que encender: se apaga el servidor recién arrancado.
    await stopServer();
    throw err;
  }
  await saveSettings(context, { enabled: true, baseURL: settings.baseURL, model });
  message = names.length
    ? `Mente local encendida: proveedor «ollama» escrito en ${file}.`
    : `Mente local encendida sin modelos: «ollama» se escribió vacío en ${file}. Descarga uno y vuelve a encender.`;
}

async function disable(context: vscode.ExtensionContext): Promise<void> {
  busy = "parando";
  const settings = readSettings(context);
  await removeOllamaProvider();
  await saveSettings(context, { ...settings, enabled: false });
  await stopServer();
  message = "Mente local apagada. Los modelos siguen en disco.";
}

/** Arranca el servidor sin escribir el proveedor ni cambiar `enabled`. */
async function startServerProcess(context: vscode.ExtensionContext): Promise<void> {
  busy = "arrancando";
  try {
    await startServer(readSettings(context).baseURL);
  } catch (err) {
    throw new Error(
      `No se pudo arrancar el servidor: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  message = "Servidor de Ollama en marcha.";
}

/** Para el servidor sin retirar el proveedor: el cerebro puede seguir encendido. */
async function stopServerProcess(context: vscode.ExtensionContext): Promise<void> {
  busy = "parando";
  await stopServer();
  message = readSettings(context).enabled
    ? "Servidor parado. El cerebro sigue encendido: el proveedor «ollama» está en la config."
    : "Servidor de Ollama parado.";
}

async function install(): Promise<void> {
  busy = "instalando";
  message = "Instalando Ollama con winget…";
  await installOllama((line) => {
    message = line;
  });
  const install = await detectInstall();
  message = install.present
    ? `Ollama instalado${install.version ? ` (${install.version})` : ""}.`
    : "winget terminó, pero Ollama no aparece: instálalo desde ollama.com/download.";
}

async function uninstall(context: vscode.ExtensionContext): Promise<void> {
  if (readSettings(context).enabled) {
    await disable(context);
  }
  busy = "desinstalando";
  message = "Desinstalando Ollama con winget…";
  await uninstallOllama((line) => {
    message = line;
  });
  const install = await detectInstall();
  message = install.present
    ? "winget terminó, pero Ollama sigue instalado."
    : `Ollama desinstalado. Los modelos siguen en ${modelsDir()}.`;
}

async function pull(context: vscode.ExtensionContext, model: string): Promise<void> {
  const name = model.trim();
  if (!MODEL_RE.test(name)) {
    throw new Error("Nombre de modelo no válido.");
  }
  const settings = readSettings(context);
  busy = "descargando";
  pullController = new AbortController();
  pullState = { model: name, status: "descargando", completed: 0, total: 0 };
  try {
    await ollamaPull(
      settings.baseURL,
      name,
      (line) => {
        pullState = {
          model: name,
          status: line.status ?? "descargando",
          completed: line.completed ?? 0,
          total: line.total ?? 0,
        };
      },
      pullController.signal
    );
    message = `Modelo «${name}» descargado.${await syncProvider(context)}`;
  } finally {
    pullController = undefined;
    pullState = null;
  }
}

/** Con el cerebro encendido, el proveedor lleva la lista viva: un alta o una baja la cambia. */
async function syncProvider(context: vscode.ExtensionContext): Promise<string> {
  const settings = readSettings(context);
  if (!settings.enabled) {
    return "";
  }
  try {
    const names = (await ollamaTags(settings.baseURL)).map((tag) => tag.name);
    await writeOllamaProvider(settings.baseURL, names);
    return "";
  } catch (err) {
    // La escritura falló pero la operación ya está hecha: se avisa sin tumbarla.
    return ` No se pudo actualizar el proveedor: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function deleteModel(context: vscode.ExtensionContext, model: string): Promise<void> {
  const name = model.trim();
  if (!MODEL_RE.test(name)) {
    throw new Error("Nombre de modelo no válido.");
  }
  const settings = readSettings(context);
  busy = "guardando";
  await ollamaRemove(settings.baseURL, name);
  if (settings.model === name) {
    let names: string[] = [];
    try {
      names = (await ollamaTags(settings.baseURL)).map((tag) => tag.name);
    } catch {
      names = [];
    }
    await saveSettings(context, { ...settings, model: names[0] ?? "" });
  }
  message = `Modelo «${name}» borrado. Los ficheros liberados no se recuperan.${await syncProvider(context)}`;
}

async function setModel(context: vscode.ExtensionContext, model: string): Promise<void> {
  const name = model.trim();
  if (name && !MODEL_RE.test(name)) {
    throw new Error("Nombre de modelo no válido.");
  }
  await saveSettings(context, { ...readSettings(context), model: name });
  message = name ? `Modelo por defecto: «${name}».` : "Sin modelo por defecto.";
}

async function setBaseURL(context: vscode.ExtensionContext, url: string): Promise<void> {
  const value = normalizeURL(url);
  if (!/^https?:\/\//.test(value) || value.length > 200) {
    throw new Error("Dirección no válida: usa http(s)://… (máximo 200 caracteres).");
  }
  await saveSettings(context, { ...readSettings(context), baseURL: value });
  message = `Servidor de Ollama: ${value}.`;
}

async function dispatch(context: vscode.ExtensionContext, action: MenteLocalAction): Promise<void> {
  switch (action.type) {
    case "refresh":
      return;
    case "setEnabled":
      await (action.on ? enable(context) : disable(context));
      return;
    case "install":
      await install();
      return;
    case "uninstall":
      await uninstall(context);
      return;
    case "pull":
      await pull(context, action.model);
      return;
    case "delete":
      await deleteModel(context, action.model);
      return;
    case "setModel":
      await setModel(context, action.model);
      return;
    case "setBaseURL":
      await setBaseURL(context, action.url);
      return;
    case "startServer":
      await startServerProcess(context);
      return;
    case "stopServer":
      await stopServerProcess(context);
      return;
    case "setTraduccion":
    case "setTraduccionPuerto":
    case "openChatbot":
    case "openTraduccion":
      // Fuera de la cola: los atiende `runAction` (traducción) o el host (abrir pestañas).
      return;
    case "openModelsDir": {
      const dir = modelsDir();
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        // Sin permisos: se abre igual y VS Code dirá lo que haya.
      }
      await vscode.env.openExternal(vscode.Uri.file(dir));
      return;
    }
  }
}

/**
 * Una operación a la vez. Nunca lanza: el fallo queda en `message`.
 * `cancelPull` se cuela porque precisamente tiene que interrumpir la descarga en curso.
 */
export async function runAction(
  context: vscode.ExtensionContext,
  action: MenteLocalAction
): Promise<void> {
  if (action.type === "cancelPull") {
    if (!pullController) {
      message = "No hay ninguna descarga en curso.";
      return;
    }
    pullController.abort();
    pullController = undefined;
    pullState = null;
    message = "Descarga cancelada.";
    return;
  }
  // La traducción no espera a una descarga larga: va fuera del cerrojo.
  if (action.type === "setTraduccion" || action.type === "setTraduccionPuerto") {
    if (traduccionEnCurso) {
      message = "Espera: hay otra operación del servicio de traducción en curso.";
      return;
    }
    traduccionEnCurso = true;
    try {
      await (action.type === "setTraduccion"
        ? setTraduccion(context, action.on)
        : setTraduccionPuerto(context, action.port));
    } catch (err) {
      traduccionError = err instanceof Error ? err.message : String(err);
    } finally {
      traduccionEnCurso = false;
    }
    return;
  }
  if (inFlight) {
    message = "Hay una operación en curso.";
    return;
  }
  inFlight = true;
  try {
    await dispatch(context, action);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    inFlight = false;
    busy = null;
  }
}

/** Estado vivo sin E/S, para repintar mientras una acción larga está en vuelo. */
export function liveState(): Pick<MenteLocalState, "busy" | "pull" | "message"> {
  return { busy, pull: pullState, message };
}
