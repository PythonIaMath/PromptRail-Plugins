import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const CHATGPT_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function routerHome() {
  return process.env.PROMPTRAIL_ROUTER_HOME || join(homedir(), ".codex", "promptrail-router");
}

export function routerConfigPath() {
  return process.env.PROMPTRAIL_ROUTER_CONFIG || join(routerHome(), "config.json");
}

export function routerModelCatalogPath() {
  return join(routerHome(), "models.json");
}

export function buildModelCatalog(bundledCatalog, overrideCatalog) {
  if (!Array.isArray(bundledCatalog?.models) || bundledCatalog.models.length === 0) {
    throw new Error("Bundled Codex catalog does not contain any models.");
  }
  const overrides = new Map(
    (overrideCatalog?.models || []).map((model) => [model?.slug, model]),
  );
  if (!overrides.has("gpt-5.6-sol")) {
    throw new Error("PromptRail model catalog override must define gpt-5.6-sol.");
  }

  const matchedOverrides = new Set();
  const models = bundledCatalog.models.map((model) => {
    const override = overrides.get(model?.slug);
    if (!override) {
      return model;
    }
    matchedOverrides.add(model.slug);
    return {
      ...model,
      ...override,
      base_instructions: model.base_instructions,
    };
  });

  for (const slug of overrides.keys()) {
    if (!matchedOverrides.has(slug)) {
      throw new Error(`Bundled Codex catalog does not contain PromptRail model ${slug}.`);
    }
  }

  return { ...bundledCatalog, models };
}

export async function installModelCatalog(
  pluginRoot,
  path = routerModelCatalogPath(),
  codexBinary = process.env.CODEX_BIN || "codex",
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const result = spawnSync(codexBinary, ["debug", "models", "--bundled"], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Unable to read bundled Codex model metadata: ${result.stderr.trim()}`);
  }
  const overridePath = join(pluginRoot, "models", "catalog.json");
  const overrideCatalog = JSON.parse(await readFile(overridePath, "utf8"));
  const catalog = buildModelCatalog(JSON.parse(result.stdout), overrideCatalog);
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export function validateRouterConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("PromptRail router configuration must be a JSON object.");
  }
  const graderUrl = String(config.graderUrl || "").trim();
  const routerToken = String(config.routerToken || "").trim();
  if (!graderUrl) {
    throw new TypeError("graderUrl is required.");
  }
  const parsedUrl = new URL(graderUrl);
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
    throw new TypeError("graderUrl must use HTTPS unless it points to localhost.");
  }
  if (!routerToken) {
    throw new TypeError("routerToken is required.");
  }
  const host = String(config.host || DEFAULT_HOST);
  if (host !== DEFAULT_HOST) {
    throw new TypeError(`The MVP proxy must bind to ${DEFAULT_HOST}.`);
  }
  const port = Number(config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("port must be an integer from 1 through 65535.");
  }
  return { graderUrl: parsedUrl.toString(), routerToken, host, port };
}

export async function loadRouterConfig(path = routerConfigPath()) {
  const raw = await readFile(path, "utf8");
  return validateRouterConfig(JSON.parse(raw));
}

export async function saveRouterConfig(config, path = routerConfigPath()) {
  const validated = validateRouterConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return validated;
}
