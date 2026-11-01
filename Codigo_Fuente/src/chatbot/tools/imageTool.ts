/**
 * Herramienta `generar_imagen`. El modelo solo decide el prompt: modelo, tamaño, pasos,
 * guía, semilla, proveedor y negativo salen de la configuración ya establecida del
 * generador de Alfred, que se inyecta en `generate`.
 */
import type { ToolSpec } from "../types";

export const MAX_IMAGE_PROMPT = 2000;

export function createImageTool(
  generate: (prompt: string) => Promise<{ file: string; note?: string }>
): ToolSpec {
  return {
    name: "generar_imagen",
    description:
      "Genera una imagen a partir de una descripción y se la muestra al usuario. Escribe el prompt en inglés, con detalle visual.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Descripción de lo que debe verse en la imagen.",
          maxLength: MAX_IMAGE_PROMPT,
        },
      },
      required: ["prompt"],
    },
    async run(args) {
      const prompt = String(args.prompt ?? "").trim();
      const { file } = await generate(prompt);
      // El modelo no recibe ruta ni bytes: solo la UI ve el fichero.
      return {
        text: "Imagen generada y mostrada al usuario.",
        attachment: { kind: "image", file },
      };
    },
  };
}
