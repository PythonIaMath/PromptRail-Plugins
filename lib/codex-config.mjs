import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  infiniteCredentialPaths,
  infiniteCredentialStatus,
  installInfiniteCredentials,
  removeInfiniteCredentials,
} from "./infinite-credentials.mjs";
import { PROMPTRAIL_INFINITE_RESPONSES_BASE_URL } from "./infinite-endpoint.mjs";
import {
  installInfiniteCodexShellAlias,
  removeInfiniteCodexShellAlias,
} from "./infinite-codex-shell.mjs";

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
export const DEFAULT_INFINITE_BASE_URL = PROMPTRAIL_INFINITE_RESPONSES_BASE_URL;
const INFINITE_BASE_INSTRUCTIONS =
  "You are Codex, a coding agent. Work with the user in the provided workspace. "
  + "Follow the user's instructions, use the provided tools when needed, and continue until the task is complete. "
  + "Do not claim to have performed actions you did not perform.";
const INFINITE_MODEL_TEMPLATE = Object.freeze({
      slug: "promptrail/infinite",
      display_name: "PromptRail Infinite",
      description: "PromptRail automatic coding model with protected subscription reserve.",
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
});

function safeCatalogString(value, name, maximum = 500) {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`Infinite model ${name} is invalid.`);
  }
  return value.trim();
}

function positiveCatalogInteger(value, name, maximum = 10_000_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Infinite model ${name} is invalid.`);
  }
  return value;
}

export function buildInfiniteModelCatalog(records = []) {
  if (!Array.isArray(records)) {
    throw new Error("Infinite model records must be an array.");
  }
  // Provider actors remain an internal implementation detail. The only extra
  // entries shown beside Infinite are exact models backed by the user's
  // connected OpenAI subscription.
  const subscriptionRecords = records.filter(
    (record) => record?.routing_mode === "subscription-direct-v1",
  );
  const seen = new Set();
  const subscriptionModels = subscriptionRecords.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Infinite model record is invalid.");
    }
    const slug = safeCatalogString(record.id, "id", 300);
    if (
      !/^gpt-[a-z0-9][a-z0-9._-]*$/.test(slug)
      || record.object !== "model"
      || record.owned_by !== "openai"
      || seen.has(slug)
    ) {
      throw new Error(`Infinite subscription model id is invalid: ${slug}.`);
    }
    seen.add(slug);
    const displayName = safeCatalogString(record.display_name, "display name", 300);
    const description = safeCatalogString(record.description, "description", 1_000);
    const contextWindow = positiveCatalogInteger(record.context_window, "context window");
    positiveCatalogInteger(
      record.max_output_tokens,
      "maximum output tokens",
      2_147_483_647,
    );
    const capabilities = record.capabilities;
    if (
      !capabilities
      || typeof capabilities !== "object"
      || capabilities.tool_calling !== true
      || capabilities.streaming !== true
    ) {
      throw new Error(`Infinite subscription model ${slug} is not coding-harness compatible.`);
    }
    const reasoningLevels = capabilities.reasoning === true
      ? INFINITE_MODEL_TEMPLATE.supported_reasoning_levels
      : [{ effort: "low", description: "Provider-default reasoning" }];
    return {
      ...structuredClone(INFINITE_MODEL_TEMPLATE),
      slug,
      display_name: displayName,
      description,
      default_reasoning_level: "low",
      supported_reasoning_levels: structuredClone(reasoningLevels),
      priority: index + 1,
      context_window: contextWindow,
      max_context_window: contextWindow,
      truncation_policy: {
        mode: "tokens",
        limit: Math.min(10_000, Math.max(1_000, Math.floor(contextWindow / 12))),
      },
      input_modalities: capabilities.vision === true ? ["text", "image"] : ["text"],
    };
  });
  return {
    models: [structuredClone(INFINITE_MODEL_TEMPLATE), ...subscriptionModels],
  };
}

export const INFINITE_MODEL_CATALOG = Object.freeze(buildInfiniteModelCatalog());

function infiniteModelCatalogJson(modelCatalog = INFINITE_MODEL_CATALOG) {
  return `${JSON.stringify(modelCatalog, null, 2)}\n`;
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
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      "PROMPTRAIL_INFINITE_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment.",
    );
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
  {
    legacyPath = legacyInfiniteInstallStatePath(),
    expectedConfigPath = codexConfigPath(),
    enableLegacyFallback,
  } = {},
) {
  try {
    await readFile(preferred, "utf8");
    return preferred;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const shouldCheckLegacy = enableLegacyFallback ?? (
    preferred === infiniteInstallStatePath()
      && !process.env.PROMPTRAIL_INFINITE_HOME
      && Boolean(process.env.CODEX_HOME)
  );
  if (shouldCheckLegacy && legacyPath !== preferred) {
    try {
      const legacyState = JSON.parse(await readFile(legacyPath, "utf8"));
      if (
        legacyState
        && typeof legacyState === "object"
        && legacyState.configPath === expectedConfigPath
      ) {
        return legacyPath;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return preferred;
}

export function infiniteModelCatalogPath() {
  return join(dirname(infiniteInstallStatePath()), "models.json");
}

function infiniteProfilePath(configPath) {
  return join(dirname(configPath), "infinite.config.toml");
}

function infiniteProfileConfig() {
  return [
    "# >>> promptrail-infinite profile >>>",
    'model = "promptrail/infinite"',
    `model_provider = "${INFINITE_PROVIDER_NAME}"`,
    "# <<< promptrail-infinite profile <<<",
    "",
  ].join("\n");
}

export function infiniteApiKeyHelperPath(statePath = infiniteInstallStatePath()) {
  return infiniteCredentialPaths(statePath).helperPath;
}

export function infiniteApiTokenPath(statePath = infiniteInstallStatePath()) {
  return infiniteCredentialPaths(statePath).tokenPath;
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
  const profilePath = infiniteProfilePath(path);
  const profile = infiniteProfileConfig();
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
  const ownedTable = new RegExp(
    `^\\s*\\[model_providers\\.${INFINITE_PROVIDER_NAME}(?:\\.auth)?\\]\\s*$`,
  );
  for (const line of lines) {
    if (
      line.trim() === "# >>> promptrail-infinite provider >>>"
      || line.trim() === "# <<< promptrail-infinite provider <<<"
    ) {
      continue;
    }
    if (ownedTable.test(line)) {
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
) {
  if (original.includes(`[model_providers.${INFINITE_PROVIDER_NAME}]`)) {
    throw new Error(`model_providers.${INFINITE_PROVIDER_NAME} already exists; refusing to overwrite it.`);
  }
  if (original.includes("[model_providers.promptrail]")) {
    throw new Error(
      "PromptRail Plugins is already configured; use `promptrail switch infinite` before installing Infinite mode.",
    );
  }
  return `${original.replace(/\s+$/, "")}${infiniteProviderBlock(baseUrl)}`;
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

function hasExpectedManagedTopLevelString(lines, key, expectedValue) {
  const index = topLevelLineIndex(lines, key);
  return index !== -1
    && lines[index].includes(INFINITE_MANAGED_COMMENT)
    && topLevelStringValue(lines[index], key) === expectedValue;
}

function hasExpectedInfiniteProviderFields(
  lines,
  expectedBaseUrl,
  requireDiagnosticsHeader,
  expectedHelperPath,
) {
  const providerPattern = new RegExp(
    `^\\s*\\[model_providers\\.${INFINITE_PROVIDER_NAME}\\]\\s*$`,
  );
  const providerIndexes = lines
    .map((line, index) => (providerPattern.test(line) ? index : -1))
    .filter((index) => index !== -1);
  if (providerIndexes.length !== 1 || !expectedBaseUrl) return false;

  const fields = new Map();
  for (let index = providerIndexes[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) break;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
    if (!assignment || fields.has(assignment[1])) return false;
    fields.set(assignment[1], line);
  }

  const expectedStrings = new Map([
    ["name", "PromptRail Infinite"],
    ["base_url", expectedBaseUrl],
    ["wire_api", "responses"],
  ]);
  if (!expectedHelperPath) expectedStrings.set("env_key", "PROMPTRAIL_API_KEY");
  for (const [key, value] of expectedStrings) {
    if (topLevelStringValue(fields.get(key), key) !== value) return false;
  }
  for (const [key, value] of [
    ["requires_openai_auth", false],
    ["supports_websockets", false],
  ]) {
    const match = fields.get(key)?.match(
      new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*(?:#.*)?$`),
    );
    if (!match || (match[1] === "true") !== value) return false;
  }

  const allowedFields = new Set([
    ...expectedStrings.keys(),
    "requires_openai_auth",
    "supports_websockets",
    "http_headers",
  ]);
  if ([...fields.keys()].some((key) => !allowedFields.has(key))) return false;
  const diagnostics = fields.get("http_headers");
  if (!diagnostics && requireDiagnosticsHeader) return false;
  if (
    diagnostics
    && !/^\s*http_headers\s*=\s*\{\s*"X-PromptRail-Diagnostics"\s*=\s*"executed-model"\s*\}\s*(?:#.*)?$/.test(diagnostics)
  ) {
    return false;
  }
  if (!expectedHelperPath) return true;

  const authPattern = new RegExp(
    `^\\s*\\[model_providers\\.${INFINITE_PROVIDER_NAME}\\.auth\\]\\s*$`,
  );
  const authIndexes = lines
    .map((line, index) => (authPattern.test(line) ? index : -1))
    .filter((index) => index !== -1);
  if (authIndexes.length !== 1) return false;
  const authFields = new Map();
  for (let index = authIndexes[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) break;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
    if (!assignment || authFields.has(assignment[1])) return false;
    authFields.set(assignment[1], line);
  }
  if (authFields.size !== 3) return false;
  if (topLevelStringValue(authFields.get("command"), "command") !== expectedHelperPath) {
    return false;
  }
  return /^\s*timeout_ms\s*=\s*5000\s*$/.test(authFields.get("timeout_ms") || "")
    && /^\s*refresh_interval_ms\s*=\s*300000\s*$/.test(
      authFields.get("refresh_interval_ms") || "",
    );
}

function assertInfiniteManagedConfigUnchanged(current, state, modelCatalogPath) {
  const lines = current.split("\n");
  const providerIsCurrent = hasExpectedInfiniteProviderFields(
    lines,
    state.baseUrl,
    state.diagnosticsHeaderManaged === true,
    undefined,
  );
  const providerIsLegacy = typeof state.helperPath === "string"
    && hasExpectedInfiniteProviderFields(
      lines,
      state.baseUrl,
      state.diagnosticsHeaderManaged === true,
      state.helperPath,
    );
  if (!providerIsCurrent && !providerIsLegacy) {
    throw new Error(
      "PromptRail-managed Infinite settings changed after installation; refusing to overwrite them.",
    );
  }
}

export async function upgradeInstalledInfiniteCodexConfig({
  path = codexConfigPath(),
  statePath = infiniteInstallStatePath(),
  baseUrl = infiniteBaseUrl(),
  modelCatalogPath = join(dirname(statePath), "models.json"),
  modelCatalog = INFINITE_MODEL_CATALOG,
  apiKey = process.env.PROMPTRAIL_API_KEY,
  tokenPath,
  helperPath,
} = {}) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const profilePath = infiniteProfilePath(path);
  const profile = infiniteProfileConfig();
  const enableShellAlias = statePath === infiniteInstallStatePath();
  const credentialPaths = infiniteCredentialPaths(statePath);
  tokenPath ||= state.tokenPath || credentialPaths.tokenPath;
  helperPath ||= state.helperPath || credentialPaths.helperPath;
  if (state.configPath !== path) {
    throw new Error("Infinite install state belongs to a different Codex configuration; refusing to overwrite it.");
  }
  if (state.modelCatalogPath && state.modelCatalogPath !== modelCatalogPath) {
    throw new Error("Infinite install state belongs to a different model catalog; refusing to overwrite it.");
  }

  const current = await readFile(path, "utf8");
  let preservedOriginal = state.original || "";
  if (sha256(current) !== state.installedSha256) {
    assertInfiniteManagedConfigUnchanged(current, state, modelCatalogPath);
    preservedOriginal = unpatchInfiniteCodexConfig(
      current,
      preservedOriginal,
      modelCatalogPath,
    );
  }

  const catalog = infiniteModelCatalogJson(modelCatalog);
  let previousCatalog = null;
  try {
    const existingCatalog = await readFile(modelCatalogPath, "utf8");
    previousCatalog = existingCatalog;
    if (
      !state.modelCatalogSha256
      || sha256(existingCatalog) !== state.modelCatalogSha256
    ) {
      throw new Error(`Refusing to overwrite a modified Infinite model catalog at ${modelCatalogPath}.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const installed = patchInfiniteCodexConfig(
    preservedOriginal,
    baseUrl,
    modelCatalogPath,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(modelCatalogPath), { recursive: true, mode: 0o700 });
  if (state.modelCatalogExisted && state.modelCatalogSha256 !== sha256(catalog)) {
    throw new Error("A pre-existing Infinite model catalog cannot be replaced during upgrade.");
  }
  const credentials = await installInfiniteCredentials({
    apiKey,
    statePath,
    previousState: state,
    tokenPath,
    helperPath,
  });
  const shellAlias = enableShellAlias
    ? await installInfiniteCodexShellAlias({ helperPath: credentials.helperPath, previousState: state })
    : { state: {}, rollback: async () => {} };
  const upgradedState = {
    ...state,
    ...credentials.state,
    ...shellAlias.state,
    original: preservedOriginal,
    configPath: path,
    baseUrl,
    modelCatalogPath,
    profilePath,
    profileSha256: sha256(profile),
    modelCatalogSha256: sha256(catalog),
    installedSha256: sha256(installed),
    diagnosticsHeaderManaged: true,
  };
  try {
    await atomicWriteFile(profilePath, profile, 0o600);
    if (!state.modelCatalogExisted) {
      await atomicWriteFile(modelCatalogPath, catalog, 0o600);
    }
    await atomicWriteFile(path, installed, 0o600);
    await atomicWriteFile(statePath, `${JSON.stringify(upgradedState, null, 2)}\n`, 0o600);
  } catch (error) {
    await atomicWriteFile(path, current, 0o600).catch(() => {});
    if (previousCatalog !== null) {
      await atomicWriteFile(modelCatalogPath, previousCatalog, 0o600).catch(() => {});
    } else if (!state.modelCatalogExisted) {
      await unlink(modelCatalogPath).catch(() => {});
    }
    await credentials.rollback().catch(() => {});
    await shellAlias.rollback().catch(() => {});
    throw error;
  }
  return { path, statePath, helperPath: credentials.helperPath };
}

export async function installInfiniteCodexConfig(
  path = codexConfigPath(),
  statePath = infiniteInstallStatePath(),
  baseUrl = infiniteBaseUrl(),
  modelCatalogPath,
  modelCatalog = INFINITE_MODEL_CATALOG,
  apiKey = process.env.PROMPTRAIL_API_KEY,
) {
  statePath = await resolveInfiniteInstallStatePath(statePath);
  const enableShellAlias = statePath === infiniteInstallStatePath();
  modelCatalogPath ||= join(dirname(statePath), "models.json");
  const profilePath = infiniteProfilePath(path);
  const profile = infiniteProfileConfig();
  try {
    await readFile(statePath, "utf8");
    return upgradeInstalledInfiniteCodexConfig({
      path,
      statePath,
      baseUrl,
      modelCatalogPath,
      modelCatalog,
      apiKey,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const catalog = infiniteModelCatalogJson(modelCatalog);
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
  const credentialPaths = infiniteCredentialPaths(statePath);
  const installed = patchInfiniteCodexConfig(
    original,
    baseUrl,
    modelCatalogPath,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(modelCatalogPath), { recursive: true, mode: 0o700 });
  const credentials = await installInfiniteCredentials({ apiKey, statePath });
  const shellAlias = enableShellAlias
    ? await installInfiniteCodexShellAlias({ helperPath: credentials.helperPath })
    : { state: {}, rollback: async () => {} };
  const state = {
      ...credentials.state,
      ...shellAlias.state,
      configPath: path,
      original,
      baseUrl,
      modelCatalogPath,
      modelCatalogExisted,
      modelCatalogSha256: sha256(catalog),
      profilePath,
      profileSha256: sha256(profile),
      installedSha256: sha256(installed),
      diagnosticsHeaderManaged: true,
    };
  try {
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    await atomicWriteFile(profilePath, profile, 0o600);
    if (!modelCatalogExisted) {
      await atomicWriteFile(modelCatalogPath, catalog, 0o600);
    }
    await atomicWriteFile(path, installed, 0o600);
  } catch (error) {
    if (!modelCatalogExisted) await unlink(modelCatalogPath).catch(() => {});
    await unlink(statePath).catch(() => {});
    await credentials.rollback().catch(() => {});
    await shellAlias.rollback().catch(() => {});
    throw error;
  }
  return { path, statePath, helperPath: credentials.helperPath };
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
      await removeInfiniteCredentials(state);
      await removeInfiniteCodexShellAlias(state);
      return state.configPath;
    }
    throw error;
  }
  const restored = sha256(current) === state.installedSha256
    ? state.original
    : unpatchInfiniteCodexConfig(current, state.original, state.modelCatalogPath);
  await atomicWriteFile(state.configPath, restored, 0o600);
  await removeInfiniteModelCatalog(state);
  await removeInfiniteProfile(state);
  await removeInfiniteCredentials(state);
  await removeInfiniteCodexShellAlias(state);
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
    ) {
      return { configured: false, reason: "config_modified", statePath };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "config_missing", statePath };
    throw error;
  }
  try {
    if (state.profilePath && state.profileSha256) {
      const profile = await readFile(state.profilePath, "utf8");
      if (sha256(profile) !== state.profileSha256) {
        return { configured: false, reason: "profile_modified", statePath };
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "profile_missing", statePath };
    throw error;
  }
  const credentialStatus = await infiniteCredentialStatus(state);
  if (!credentialStatus.configured) {
    return { ...credentialStatus, statePath };
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

async function removeInfiniteProfile(state) {
  if (!state.profilePath || !state.profileSha256) return false;
  try {
    const current = await readFile(state.profilePath, "utf8");
    if (sha256(current) !== state.profileSha256) return false;
    await unlink(state.profilePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
