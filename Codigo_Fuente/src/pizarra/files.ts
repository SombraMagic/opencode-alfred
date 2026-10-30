/**
 * Ficheros de la pizarra, dentro de la carpeta de adjuntos: la copia de trabajo (PNG
 * aplanado) y la escena editable. Sin la API de VS Code: lo usan el panel y el servidor MCP.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_SCENE_BYTES, sanitizeScene, Scene } from "./scene";

/** Escena editable (JSON), junto a la copia de trabajo. */
export const SCENE_FILE = "pizarra.json";
/** Nombre del fichero con la copia de trabajo, dentro de la carpeta de adjuntos. */
export const WORK_FILE = "pizarra-ultima.png";

/** Escribe de forma atómica (tmp + rename), como hace agents/store.ts con el texto. */
export async function writeAtomic(file: string, bytes: Buffer): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(tmp, bytes);
  await rename(tmp, file);
}

/** Texto de la escena tal como está en disco, o undefined si no hay fichero. */
export async function readSceneText(dir: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(join(dir, SCENE_FILE));
    // Tope de fichero holgado: un carácter UTF-8 ocupa hasta 4 bytes y el presupuesto real se aplica al sanear, por caracteres.
    if (!bytes.length || bytes.length > MAX_SCENE_BYTES * 4) {
      return undefined;
    }
    return bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

/** Escena guardada y saneada, o undefined si no hay fichero, el JSON está roto o no pasa el saneado. */
export async function readSceneFile(dir: string): Promise<Scene | undefined> {
  const text = await readSceneText(dir);
  if (text === undefined) {
    return undefined;
  }
  try {
    return sanitizeScene(JSON.parse(text));
  } catch {
    // JSON roto: sin escena válida se cae al PNG, como en las pizarras antiguas.
    return undefined;
  }
}

/** Escribe la escena y devuelve el texto exacto que quedó en disco (para comparar). */
export async function writeSceneFile(dir: string, scene: Scene): Promise<string> {
  const text = JSON.stringify(scene);
  await writeAtomic(join(dir, SCENE_FILE), Buffer.from(text, "utf8"));
  return text;
}
