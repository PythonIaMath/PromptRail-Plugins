import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_BLOCK = `

# >>> promptrail-codex-router provider >>>
[model_providers.promptrail]
name = "PromptRail ChatGPT subscription router"
base_url = "http://127.0.0.1:8787"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
# <<< promptrail-codex-router provider <<<
`;
const MANAGED_COMMENT = "managed by promptrail-codex-router";
const INFINITE_PROVIDER_NAME = "promptrail-infinite";
const INFINITE_MANAGED_COMMENT = "managed by promptrail-infinite";
export const DEFAULT_INFINITE_BASE_URL = "https://api.promptrail.ai/v1";
const INFINITE_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent. Work with the user in the provided workspace. "
  + "Follow the user's instructions, use the provided tools when needed, and continue until the task is complete. "
  + "Do not claim to have performed actions you did not perform.";
export const INFINITE_MODEL_CATALOG = Object.freeze({
  models: [
    {
      slug: "promptrail/infinite",
      display_name: "PromptRail Infinite",
      description: "PromptRail's free-first coding model with protected subscription reserve.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with light reasoning" },
        { effort: "medium", description: "Balanced reasoning for everyday engineering" },
        { effort: "high", description: "Greater reasoning depth for difficult work" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      availability_nux: null,
      upgrade: null,
      base_instructions: INFINITE_BASE_INSTRUCTIONS,
      model_messages: null,
      include_skills_usage_instructions: false,
      supports_reasoning_summary_parameter: false,
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: 128_000,
      max_context_window: 128_000,
      auto_compact_token_limit: null,
      comp_hash: null,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text"],
      supports_search_tool: false,
      use_responses_lite: false,
      auto_review_model_override: null,
      tool_mode: null,
      multi_agent_version: null,
    },
  ],
});

function infiniteModelCatalogJson() {
  return `${JSON.stringify(INFINITE_MODEL_CATALOG, null, 2)}\n`;
}

function infiniteProviderBlock(baseUrl) {
  return `

# >>> promptrail-infinite provider >>>
[model_providers.promptrail-infinite]
name = "PromptRail Infinite"
base_url = ${JSON.stringify(baseUrl)}
env_key = "PROMPTRAIL_API_KEY"
requires_openai_auth = false
wire_api = "responses"
supports_websockets = false
http_headers = { "X-PromptRail-Diagnostics" = "executed-model" }
# <<< promptrail-infinite provider <<<
`;
}

export function infiniteBaseUrl(value = process.env.PROMPTRAIL_INFINITE_BASE_URL) {
  const baseUrl = String(value || DEFAULT_INFINITE_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("PROMPTRAIL_INFINITE_BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("PROMPTRAIL_INFINITE_BASE_URL must be an absolute HTTPS URL without credentials.");
  }
  return baseUrl;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWriteFile(path, contents, mode) {
  const temporary = `${path}.promptrail-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

export function codexConfigPath() {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "config.toml")
    : join(homedir(), ".codex", "config.toml");
}

export function installStatePath() {
  return process.env.PROMPTRAIL_ROUTER_HOME
    ? join(process.env.PROMPTRAIL_ROUTER_HOME, "install-state.json")
    : join(homedir(), ".codex", "promptrail-router", "install-state.json");
}

export function infiniteInstallStatePath() {
  const infiniteHome = process.env.PROMPTRAIL_INFINITE_HOME
    || (process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, "promptrail-infinite")
      : join(homedir(), ".codex", "promptrail-infinite"));
  return join(infiniteHome, "install-state.json");
}

function legacyInfiniteInstallStatePath() {
  return join(homedir(), ".codex", "promptrail-infinite", "install-state.json");
}

export async function resolveInfiniteInstallStatePath(
  preferred = infiniteInstallStatePath(),
) {
  try {
    await readFile(preferred, "utf8");
    return preferred;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const legacy = legacyInfiniteInstallStatePath();
  if (
    preferred === infiniteInstallStatePath()
    && !process.env.PROMPTRAIL_INFINITE_HOME
    && process.env.CODEX_HOME
    && legacy !== preferred
  ) {
    try {
      await readFile(legacy, "utf8");
      return legacy;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return preferred;
}

export function infiniteModelCatalogPath() {
  return join(dirname(infiniteInstallStatePath()), "models.json");
}

function setTopLevelString(lines, key, value, comment) {
  let firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  if (firstTable === -1) {
    firstTable = lines.length;
  }
  for (let index = 0; index < firstTable; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index]) && !/^\s*#/.test(lines[index])) {
      lines[index] = `${key} = ${JSON.stringify(value)}${comment ? ` # ${comment}` : ""}`;
      return;
    }
  }
  lines.unshift(`${key} = ${JSON.stringify(value)}${comment ? ` # ${comment}` : ""}`);
}

function topLevelLineIndex(lines, key) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let index = 0; index < end; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index]) && !/^\s*#/.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

function topLevelStringValue(line, key) {
  const match = line?.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function restoreManagedTopLevelString(lines, originalLines, key, installedValue) {
  const index = topLevelLineIndex(lines, key);
  if (
    index === -1
    || !lines[index].includes(MANAGED_COMMENT)
    || topLevelStringValue(lines[index], key) !== installedValue
  ) {
    return;
  }
  const originalIndex = topLevelLineIndex(originalLines, key);
  if (originalIndex === -1) {
    lines.splice(index, 1);
  } else {
    lines[index] = originalLines[originalIndex];
  }
}

function restoreTopLevelStringForComment(lines, originalLines, key, installedValue, comment) {
  const index = topLevelLineIndex(lines, key);
  if (
    index === -1
    || !lines[index].includes(comment)
    || topLevelStringValue(lines[index], key) !== installedValue
  ) {
    return;
  }
  const originalIndex = topLevelLineIndex(originalLines, key);
  if (originalIndex === -1) {
    lines.splice(index, 1);
  } else {
    lines[index] = originalLines[originalIndex];
  }
}

function removePromptRailTables(lines) {
  const result = [];
  let insideOwnedTable = false;
  for (const line of lines) {
    if (
      line.trim() === "# >>> promptrail-codex-router provider >>>"
      || line.trim() === "# <<< promptrail-codex-router provider <<<"
    ) {
      continue;
    }
    if (
      /^\s*\[model_providers\.promptrail\]\s*$/.test(line)
      || /^\s*\[hooks\.state\."promptrail-codex-router@promptrail:[^"]+"\]\s*$/.test(line)
    ) {
      insideOwnedTable = true;
      continue;
    }
    if (insideOwnedTable && /^\s*\[/.test(line)) {
      insideOwnedTable = false;
    }
    if (!insideOwnedTable) {
      result.push(line);
    }
  }
  return result;
}

export function unpatchCodexConfig(current, original, modelCatalogPath) {
  const originalLines = original.split("\n");
  let lines = current.split("\n");
  restoreManagedTopLevelString(lines, originalLines, "model_provider", "promptrail");
  restoreManagedTopLevelString(lines, originalLines, "model_catalog_json", modelCatalogPath);
  lines = removePromptRailTables(lines);
  const cleaned = lines.join("\n").replace(/\s+$/, "");
  return cleaned ? `${cleaned}\n` : "";
}

export function patchCodexConfig(original, modelCatalogPath) {
  if (original.includes("[model_providers.promptrail]")) {
    throw new Error("model_providers.promptrail already exists; refusing to overwrite it.");
  }
  if (original.includes(`[model_providers.${INFINITE_PROVIDER_NAME}]`)) {
    throw new Error(
      "PromptRail Infinite is already configured; use `promptrail switch plugins` before installing Plugins mode.",
    );
  }
  const lines = original.split("\n");
  setTopLevelString(lines, "model_provider", "promptrail", "managed by promptrail-codex-router");
  if (modelCatalogPath) {
    setTopLevelString(
      lines,
      "model_catalog_json",
      modelCatalogPath,
      "managed by promptrail-codex-router",
    );
  }
  return `${lines.join("\n").replace(/\s+$/, "")}${PROVIDER_BLOCK}`;
}

export async function installCodexConfig(
  path = codexConfigPath(),
  statePath = installStatePath(),
  modelCatalogPath,
) {
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  const installed = patchCodexConfig(original, modelCatalogPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(path, installed, { mode: 0o600 });
  await chmod(path, 0o600);
  await writeFile(
    statePath,
    `${JSON.stringify({
      configPath: path,
      original,
      modelCatalogPath,
      installedSha256: sha256(installed),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(statePath, 0o600);
  return { path, statePath };
}

export async function upgradeInstalledCodexConfig(
  modelCatalogPath,
  statePath = installStatePath(),
) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const current = await readFile(state.configPath, "utf8");
  if (sha256(current) !== state.installedSha256) {
    throw new Error(
      "Codex config changed after PromptRail installation; refusing to overwrite those changes.",
    );
  }
  const lines = current.split("\n");
  setTopLevelString(
    lines,
    "model_catalog_json",
    modelCatalogPath,
    "managed by promptrail-codex-router",
  );
  const installed = `${lines.join("\n").replace(/\s+$/, "")}\n`;
  await writeFile(state.configPath, installed, { mode: 0o600 });
  await chmod(state.configPath, 0o600);
  state.installedSha256 = sha256(installed);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  return state.configPath;
}

export async function uninstallCodexConfig(statePath = installStatePath()) {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let current;
  try {
    current = await readFile(state.configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return state.configPath;
    }
    throw error;
  }
  const restored = sha256(current) === state.installedSha256
    ? state.original
    : unpatchCodexConfig(
        current,
        state.original,
        state.modelCatalogPath || join(dirname(statePath), "models.json"),
      );
  await writeFile(state.configPath, restored, { mode: 0o600 });
  await chmod(state.configPath, 0o600);
  return state.configPath;
}

function removeInfiniteProvider(lines) {
  const result = [];
  let insideOwnedTable = false;
  for (const line of lines) {
    if (
      line.trim() === "# >>> promptrail-infinite provider >>>"
      || line.trim() === "# <<< promptrail-infinite provider <<<"
    ) {
      continue;
    }
    if (new RegExp(`^\\s*\\[model_providers\\.${INFINITE_PROVIDER_NAME}\\]\\s*$`).test(line)) {
      insideOwnedTable = true;
      continue;
    }
    if (insideOwnedTable && /^\s*\[/.test(line)) {
      insideOwnedTable = false;
    }
    if (!insideOwnedTable) {
      result.push(line);
    }
  }
  return result;
}

export function patchInfiniteCodexConfig(
  original,
  baseUrl = infiniteBaseUrl(),
  modelCatalogPath = infiniteModelCatalogPath(),
) {
  if (original.includes(`[model_providers.${INFINITE_PROVIDER_NAME}]`)) {
    throw new Error(`model_providers.${INFINITE_PROVIDER_NAME} already exists; refusing to overwrite it.`);
  }
  if (original.includes("[model_providers.promptrail]")) {
    throw new Error(
      "PromptRail Plugins is already configured; use `promptrail switch infinite` before installing Infinite mode.",
    );
  }
  const lines = original.split("\n");
  setTopLevelString(lines, "model", "promptrail/infinite", INFINITE_MANAGED_COMMENT);
  setTopLevelString(lines, "model_provider", INFINITE_PROVIDER_NAME, INFINITE_MANAGED_COMMENT);
  setTopLevelString(lines, "model_catalog_json", modelCatalogPath, INFINITE_MANAGED_COMMENT);
  return `${lines.join("\n").replace(/\s+$/, "")}${infiniteProviderBlock(baseUrl)}`;
}

export function unpatchInfiniteCodexConfig(
  current,
  original,
  modelCatalogPath = infiniteModelCatalogPath(),
) {
  const originalLines = original.split("\n");
  let lines = current.split("\n");
  restoreTopLevelStringForComment(
    lines,
    originalLines,
    "model",
    "promptrail/infinite",
    INFINITE_MANAGED_COMMENT,
  );
  restoreTopLevelStringForComment(
    lines,
    originalLines,
    "model_provider",
    INFINITE_PROVIDER_NAME,
    INFINITE_MANAGED_COMMENT,
  );
  restoreTopLevelStringForComment(
    lines,
    originalLines,
    "model_catalog_json",
    modelCatalogPath,
    INFINITE_MANAGED_COMMENT,
  );
  lines = removeInfiniteProvider(lines);
  const cleaned = lines.join("\n").replace(/\s+$/, "");
  return cleaned ? `${cleaned}\n` : "";
}

export async function upgradeInstalledInfiniteCodexConfig({
  path = codexConfigPath(),
  statePath = infiniteInstallStatePath(),
  baseUrl = infiniteBaseUrl(),
  modelCatalogPath = join(dirname(statePath), "models.json"),
} = {}) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (state.configPath !== path) {
    throw new Error("Infinite install state belongs to a different Codex configuration; refusing to overwrite it.");
  }
  if (state.modelCatalogPath && state.modelCatalogPath !== modelCatalogPath) {
    throw new Error("Infinite install state belongs to a different model catalog; refusing to overwrite it.");
  }

  const current = await readFile(path, "utf8");
  if (sha256(current) !== state.installedSha256) {
    throw new Error(
      "Codex config changed after PromptRail Infinite installation; refusing to overwrite those changes.",
    );
  }

  const catalog = infiniteModelCatalogJson();
  try {
    const existingCatalog = await readFile(modelCatalogPath, "utf8");
    if (
      !state.modelCatalogSha256
      || sha256(existingCatalog) !== state.modelCatalogSha256
    ) {
      throw new Error(`Refusing to overwrite a modified Infinite model catalog at ${modelCatalogPath}.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const installed = patchInfiniteCodexConfig(state.original || "", baseUrl, modelCatalogPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(modelCatalogPath), { recursive: true, mode: 0o700 });
  if (state.modelCatalogExisted && state.modelCatalogSha256 !== sha256(catalog)) {
    throw new Error("A pre-existing Infinite model catalog cannot be replaced during upgrade.");
  }
  const upgradedState = {
    ...state,
    configPath: path,
    baseUrl,
    modelCatalogPath,
    modelCatalogSha256: sha256(catalog),
    installedSha256: sha256(installed),
  };
  try {
    if (!state.modelCatalogExisted) {
      await atomicWriteFile(modelCatalogPath, catalog, 0o600);
    }
    await atomicWriteFile(path, installed, 0o600);
    await atomicWriteFile(statePath, `${JSON.stringify(upgradedState, null, 2)}\n`, 0o600);
  } catch (error) {
    await atomicWriteFile(path, current, 0o600).catch(() => {});
    throw error;
  }
  return { path, statePath };
}

export async function installInfiniteCodexConfig(
  path = codexConfigPath(),
  statePath = infiniteInstallStatePath(),
  baseUrl = infiniteBaseUrl(),
  modelCatalogPath,
) {
  statePath = await resolveInfiniteInstallStatePath(statePath);
  modelCatalogPath ||= join(dirname(statePath), "models.json");
  try {
    await readFile(statePath, "utf8");
    return upgradeInstalledInfiniteCodexConfig({ path, statePath, baseUrl, modelCatalogPath });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const catalog = infiniteModelCatalogJson();
  let modelCatalogExisted = true;
  try {
    const existingCatalog = await readFile(modelCatalogPath, "utf8");
    if (existingCatalog !== catalog) {
      throw new Error(`Refusing to overwrite an existing Infinite model catalog at ${modelCatalogPath}.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    modelCatalogExisted = false;
  }
  const installed = patchInfiniteCodexConfig(original, baseUrl, modelCatalogPath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(modelCatalogPath), { recursive: true, mode: 0o700 });
  const state = {
      configPath: path,
      original,
      baseUrl,
      modelCatalogPath,
      modelCatalogExisted,
      modelCatalogSha256: sha256(catalog),
      installedSha256: sha256(installed),
    };
  await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  try {
    if (!modelCatalogExisted) {
      await atomicWriteFile(modelCatalogPath, catalog, 0o600);
    }
    await atomicWriteFile(path, installed, 0o600);
  } catch (error) {
    if (!modelCatalogExisted) await unlink(modelCatalogPath).catch(() => {});
    await unlink(statePath).catch(() => {});
    throw error;
  }
  return { path, statePath };
}

export async function uninstallInfiniteCodexConfig(statePath = infiniteInstallStatePath()) {
  statePath = await resolveInfiniteInstallStatePath(statePath);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let current;
  try {
    current = await readFile(state.configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      await removeInfiniteModelCatalog(state);
      return state.configPath;
    }
    throw error;
  }
  const restored = sha256(current) === state.installedSha256
    ? state.original
    : unpatchInfiniteCodexConfig(current, state.original, state.modelCatalogPath);
  await atomicWriteFile(state.configPath, restored, 0o600);
  await removeInfiniteModelCatalog(state);
  return state.configPath;
}

export async function infiniteCodexStatus(statePath = infiniteInstallStatePath()) {
  statePath = await resolveInfiniteInstallStatePath(statePath);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "not_installed", statePath };
    return { configured: false, reason: "corrupt_state", statePath };
  }
  if (
    !state
    || typeof state !== "object"
    || typeof state.configPath !== "string"
    || typeof state.installedSha256 !== "string"
    || typeof state.modelCatalogPath !== "string"
    || typeof state.modelCatalogSha256 !== "string"
  ) {
    return { configured: false, reason: "corrupt_state", statePath };
  }
  try {
    const config = await readFile(state.configPath, "utf8");
    if (
      sha256(config) !== state.installedSha256
      || !config.includes(`[model_providers.${INFINITE_PROVIDER_NAME}]`)
      || !config.includes('model = "promptrail/infinite"')
    ) {
      return { configured: false, reason: "config_modified", statePath };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "config_missing", statePath };
    throw error;
  }
  try {
    const catalog = await readFile(state.modelCatalogPath, "utf8");
    if (sha256(catalog) !== state.modelCatalogSha256) {
      return { configured: false, reason: "catalog_modified", statePath };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "catalog_missing", statePath };
    throw error;
  }
  return { configured: true, statePath };
}

async function removeInfiniteModelCatalog(state) {
  if (!state.modelCatalogPath || !state.modelCatalogSha256 || state.modelCatalogExisted) return false;
  try {
    const current = await readFile(state.modelCatalogPath, "utf8");
    if (sha256(current) !== state.modelCatalogSha256) return false;
    await unlink(state.modelCatalogPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
