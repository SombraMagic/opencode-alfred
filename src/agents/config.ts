import { parse as parseJsonc, ParseError, printParseErrorCode } from "jsonc-parser";

export interface ModelInfo {
  /** provider/model-id. El model-id puede contener "/" (p. ej. nvidia/meta/llama-3.1). */
  id: string;
  provider: string;
  model: string;
  /** Nombre legible del modelo. */
  name: string;
  /** Proveedor configurado en opencode.json o autenticado en auth.json. */
  preferred: boolean;
}

export interface ConfigFile {
  path: string;
  scope: "global" | "project";
  valid: boolean;
  error?: string;
}

export interface OpencodeConfigInfo {
  files: ConfigFile[];
  models: ModelInfo[];
  defaultModel?: string;
  smallModel?: string;
  defaultAgent?: string;
  providers: string[];
}

type JsonObject = Record<string, unknown>;

export interface RegistryModel {
  name?: string;
}

export interface RegistryProvider {
  id?: string;
  name?: string;
  models?: Record<string, RegistryModel>;
}

/** models.dev registry cache, keyed by provider id. */
export type Registry = Record<string, RegistryProvider>;

export interface ModelSources {
  /** Provider ids authenticated in opencode's auth.json. */
  authProviders?: string[];
  /** models.dev registry (opencode's cache). */
  registry?: Registry;
  /** Include every provider in the registry, not only configured/authenticated ones. */
  includeAllProviders?: boolean;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function parseJsoncSafe(text: string): { value?: JsonObject; error?: string; hasError: boolean } {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    return {
      error: `${printParseErrorCode(first.error)} en offset ${first.offset}`,
      hasError: true,
      value: asObject(value),
    };
  }
  return { value: asObject(value), hasError: false };
}

function collectFromObject(
  obj: JsonObject | undefined,
  models: Map<string, ModelInfo>,
  providersWithModels: Set<string>
): void {
  const providers = asObject(obj?.provider);
  if (!providers) {
    return;
  }
  for (const [providerName, providerValue] of Object.entries(providers)) {
    const provider = asObject(providerValue);
    if (!provider) {
      continue;
    }
    const providerModels = asObject(provider.models);
    if (!providerModels) {
      continue;
    }
    let explicit = false;
    for (const modelId of Object.keys(providerModels)) {
      const modelObj = asObject(providerModels[modelId]);
      const name = (modelObj?.name as string) || modelId;
      const id = `${providerName}/${modelId}`;
      models.set(id, { id, provider: providerName, model: modelId, name, preferred: true });
      explicit = true;
    }
    if (explicit) {
      providersWithModels.add(providerName);
    }
  }
}

function collectFromRegistry(
  registry: Registry,
  providers: Map<string, boolean>,
  models: Map<string, ModelInfo>
): void {
  for (const [providerId, preferred] of providers) {
    const provider = registry[providerId];
    if (!provider || !provider.models) {
      continue;
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      const id = `${providerId}/${modelId}`;
      if (models.has(id)) {
        continue;
      }
      const name = model && typeof model.name === "string" && model.name ? model.name : modelId;
      models.set(id, { id, provider: providerId, model: modelId, name, preferred });
    }
  }
}

export function buildConfigInfo(
  files: Array<{ path: string; scope: "global" | "project"; text?: string; error?: string }>,
  sources: ModelSources = {}
): OpencodeConfigInfo {
  const models = new Map<string, ModelInfo>();
  const configFiles: ConfigFile[] = [];
  const providers = new Set<string>();
  const providersWithModels = new Set<string>();
  let defaultModel: string | undefined;
  let smallModel: string | undefined;
  let defaultAgent: string | undefined;

  for (const f of files) {
    if (f.text === undefined) {
      continue;
    }
    const parsed = parseJsoncSafe(f.text);
    configFiles.push({ path: f.path, scope: f.scope, valid: !parsed.hasError, error: parsed.error });
    if (!parsed.value) {
      continue;
    }
    collectFromObject(parsed.value, models, providersWithModels);
    const provs = asObject(parsed.value.provider);
    if (provs) {
      for (const name of Object.keys(provs)) {
        providers.add(name);
      }
    }
    if (typeof parsed.value.model === "string") {
      defaultModel = parsed.value.model;
    }
    if (typeof parsed.value.small_model === "string") {
      smallModel = parsed.value.small_model;
    }
    if (typeof parsed.value.default_agent === "string") {
      defaultAgent = parsed.value.default_agent;
    }
  }

  const registry = sources.registry ?? {};
  const toAdd = new Map<string, boolean>();
  for (const id of sources.authProviders ?? []) {
    if (registry[id]) {
      toAdd.set(id, true);
    }
  }
  for (const id of providers) {
    if (registry[id] && !providersWithModels.has(id)) {
      toAdd.set(id, true);
    }
  }
  if (sources.includeAllProviders) {
    for (const id of Object.keys(registry)) {
      if (!toAdd.has(id)) {
        toAdd.set(id, false);
      }
    }
  }
  collectFromRegistry(registry, toAdd, models);

  return {
    files: configFiles,
    models: [...models.values()].sort(
      (a, b) => Number(b.preferred) - Number(a.preferred) || a.id.localeCompare(b.id)
    ),
    defaultModel,
    smallModel,
    defaultAgent,
    providers: [...providers].sort(),
  };
}
