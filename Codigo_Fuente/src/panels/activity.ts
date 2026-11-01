/**
 * Actividades que no son agentes y que el panel de voz pinta como una tarjeta más:
 * generar una imagen, transcribir voz y cargar/instalar modelos de Ollama. Sin
 * `vscode`: los orígenes las encienden y el panel las lee.
 */
import { readWork } from "../images/share";

export type ActivityIcon = "imagen" | "dictado" | "ollama";

export interface ActivityAgent {
  key: string;
  name: string;
  icon: ActivityIcon;
}

const activities = new Map<string, ActivityAgent>();
const listeners = new Set<() => void>();

/** Enciende o apaga una actividad. Solo avisa si el mapa cambió de verdad. */
export function setActivity(key: string, on: boolean, name: string, icon: ActivityIcon): void {
  const current = activities.get(key);
  if (on) {
    if (current && current.name === name && current.icon === icon) {
      return;
    }
    activities.set(key, { key, name, icon });
  } else {
    if (!current) {
      return;
    }
    activities.delete(key);
  }
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Enciende o apaga la tarjeta «GENERANDO IMAGEN» de `key` según `imagen-trabajando.json`,
 * que deja el MCP. Si el proceso muere a mitad, el sello de tiempo la caduca a los 15 min.
 * Reutilizable: cada origen (MCP, chatbot...) pasa su propia clave.
 */
export function checkImageWork(key: string): void {
  const work = readWork();
  const on = !!work?.on && Date.now() - work.at < 15 * 60_000;
  setActivity(key, on, "GENERANDO IMAGEN", "imagen");
}

/** Actividades encendidas, en el orden en que se encendieron. */
export function listActivities(): ActivityAgent[] {
  return Array.from(activities.values());
}

/** Alta de un oyente; devuelve la baja. */
export function onActivityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
