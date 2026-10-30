/** Alta y baja de `provider.ollama` en el config global de opencode. */

import * as fs from "fs/promises";
import * as path from "path";
import { applyEdits, FormattingOptions, modify, parse as parseJsonc, ParseError } from "jsonc-parser";
import { globalOpencodeDir } from "../agents/paths";
import { writeAtomic } from "../agents/store";
import { removeProviderEntries } from "../agents/connectors";

const FMT: FormattingOptions = { insertSpaces: true, tabSize: 2 };
const PROVIDER_ID = "ollama";

/** Candidatos globales: mismo criterio que `globalConfigFiles()` de `agents/catalog.ts`. */
function globalConfigFiles(): string[] {
  const dir = globalOpencodeDir();
  return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** El primero que exista; si no hay ninguno, `opencode.json`. Nunca el de proyecto. */
async function targetFile(): Promise<string> {
  const files = globalConfigFiles();
  for (const file of files) {
    if ((await readIfExists(file)) !== undefined) {
      return file;
    }
  }
  return files[0];
}

/** Un config con comentarios rotos o comas de más no se pisa: se avisa y se para. */
function ensureParsable(file: string, text: string): void {
  const errors: ParseError[] = [];
  parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(
      `El config de opencode no se puede leer (${path.basename(file)}): no se ha tocado.`
    );
  }
}

function baseURLForV1(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
}

export async function writeOllamaProvider(baseURL: string, models: string[]): Promise<string> {
  const file = await targetFile();
  const text =
    (await readIfExists(file)) ?? `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
  const base = text.trim() ? text : "{}\n";
  ensureParsable(file, base);

  const modelMap: Record<string, { name: string }> = {};
  for (const raw of models) {
    const name = raw.trim();
    if (name) {
      modelMap[name] = { name };
    }
  }
  const value = {
    name: "Ollama (local)",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: baseURLForV1(baseURL) },
    models: modelMap,
  };

  const next = applyEdits(base, modify(base, ["provider", PROVIDER_ID], value, { formattingOptions: FMT }));
  if (next !== base) {
    await writeAtomic(file, next);
  }
  return file;
}

/** Quita `provider.ollama` de los globales que la tengan. Sin entrada, no escribe. */
export async function removeOllamaProvider(): Promise<void> {
  for (const file of globalConfigFiles()) {
    const text = await readIfExists(file);
    if (text === undefined) {
      continue;
    }
    ensureParsable(file, text);
    const next = removeProviderEntries(text, PROVIDER_ID);
    if (next !== text) {
      await writeAtomic(file, next);
    }
  }
}
