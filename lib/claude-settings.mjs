import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LEGACY_PROMPTRAIL_BASE_URL = "http://127.0.0.1:8788";
export const PROMPTRAIL_INFINITE_BASE_URL = "https://api.promptrail.ai";
export const PROMPTRAIL_INFINITE_MODEL = "promptrail/infinite";
export const PROMPTRAIL_INFINITE_MODEL_DISCOVERY = "1";
export const PROMPTRAIL_INFINITE_DIAGNOSTIC_HEADER =
  "X-PromptRail-Diagnostics: executed-model";
export const PROMPTRAIL_INFINITE_HELPER = [
  "#!/bin/sh",
  "set -eu",
  'if [ -z "${PROMPTRAIL_API_KEY:-}" ]; then',
  '  echo "PROMPTRAIL_API_KEY is required" >&2',
  "  exit 1",
  "fi",
  'printf \'%s\\n\' "$PROMPTRAIL_API_KEY"',
  "",
].join("\n");

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

export function claudeSettingsPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "settings.json");
}

export function installStatePath() {
  return process.env.PROMPTRAIL_CLAUDE_ROUTER_HOME
    ? join(process.env.PROMPTRAIL_CLAUDE_ROUTER_HOME, "install-state.json")
    : join(homedir(), ".claude", "promptrail-router", "install-state.json");
}

export function infiniteInstallStatePath() {
  const infiniteHome = process.env.PROMPTRAIL_INFINITE_CLAUDE_HOME
    || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "promptrail-infinite");
  return join(infiniteHome, "install-state.json");
}

function legacyInfiniteInstallStatePath() {
  return join(homedir(), ".claude", "promptrail-infinite", "install-state.json");
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
    && !process.env.PROMPTRAIL_INFINITE_CLAUDE_HOME
    && process.env.CLAUDE_CONFIG_DIR
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

export function infiniteApiKeyHelperPath(statePath = infiniteInstallStatePath()) {
  return join(dirname(statePath), "api-key-helper.sh");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function infiniteClaudeBaseUrl(value = process.env.PROMPTRAIL_INFINITE_BASE_URL) {
  const configured = String(value || PROMPTRAIL_INFINITE_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("PROMPTRAIL_INFINITE_BASE_URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(
      "PROMPTRAIL_INFINITE_BASE_URL must be an absolute HTTPS URL without credentials.",
    );
  }
  return configured.endsWith("/v1") ? configured.slice(0, -3) : configured;
}

function parseSettings(raw) {
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Claude settings must contain a JSON object.");
  }
  return parsed;
}

export function assertNoApiCredentialConfiguration(settings, environment = process.env) {
  const envSettings = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const configured = [
    ["ANTHROPIC_API_KEY", environment.ANTHROPIC_API_KEY || envSettings.ANTHROPIC_API_KEY],
    ["ANTHROPIC_AUTH_TOKEN", environment.ANTHROPIC_AUTH_TOKEN || envSettings.ANTHROPIC_AUTH_TOKEN],
    ["apiKeyHelper", settings?.apiKeyHelper],
  ].filter(([, value]) => String(value || "").trim());
  if (configured.length) {
    throw new Error(
      `Claude API credential configuration is active (${configured.map(([name]) => name).join(", ")}). Remove it before installing the subscription-only router.`,
    );
  }
}

export function patchClaudeSettings(original, baseUrl, environment = process.env) {
  const settings = parseSettings(original);
  assertNoApiCredentialConfiguration(settings, environment);
  const existingBaseUrl = String(settings.env?.ANTHROPIC_BASE_URL || "").trim();
  if (existingBaseUrl && existingBaseUrl !== baseUrl) {
    throw new Error(
      `ANTHROPIC_BASE_URL is already configured as ${existingBaseUrl}; refusing to replace it.`,
    );
  }
  return `${JSON.stringify({
    ...settings,
    env: {
      ...(settings.env || {}),
      ANTHROPIC_BASE_URL: baseUrl,
    },
  }, null, 2)}\n`;
}

export async function installClaudeSettings({
  baseUrl,
  path = claudeSettingsPath(),
  statePath = installStatePath(),
  environment = process.env,
}) {
  let original = "";
  let existed = true;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    existed = false;
  }
  const installed = patchClaudeSettings(original, baseUrl, environment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(path, installed, { mode: 0o600 });
  await chmod(path, 0o600);
  await writeFile(
    statePath,
    `${JSON.stringify({
      settingsPath: path,
      original,
      existed,
      baseUrl,
      installedSha256: sha256(installed),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(statePath, 0o600);
  return { path, statePath };
}

export async function uninstallClaudeSettings(statePath = installStatePath()) {
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
    current = await readFile(state.settingsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return state.settingsPath;
    }
    throw error;
  }

  if (sha256(current) === state.installedSha256) {
    if (state.existed) {
      await writeFile(state.settingsPath, state.original, { mode: 0o600 });
      await chmod(state.settingsPath, 0o600);
    } else {
      await unlink(state.settingsPath);
    }
    return state.settingsPath;
  }

  const settings = parseSettings(current);
  const original = parseSettings(state.original || "");
  const currentEnv = settings.env;
  const originalEnv = original.env;
  const managedBaseUrl = state.baseUrl || LEGACY_PROMPTRAIL_BASE_URL;
  if (
    currentEnv
    && typeof currentEnv === "object"
    && !Array.isArray(currentEnv)
    && currentEnv.ANTHROPIC_BASE_URL === managedBaseUrl
  ) {
    if (
      originalEnv
      && typeof originalEnv === "object"
      && !Array.isArray(originalEnv)
      && Object.hasOwn(originalEnv, "ANTHROPIC_BASE_URL")
    ) {
      currentEnv.ANTHROPIC_BASE_URL = originalEnv.ANTHROPIC_BASE_URL;
    } else {
      delete currentEnv.ANTHROPIC_BASE_URL;
    }
    if (Object.keys(currentEnv).length === 0 && !Object.hasOwn(original, "env")) {
      delete settings.env;
    }
  }

  if (!state.existed && Object.keys(settings).length === 0) {
    await unlink(state.settingsPath);
  } else {
    await writeFile(state.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await chmod(state.settingsPath, 0o600);
  }
  return state.settingsPath;
}

function assertNoInfiniteCredentialConflict(settings, helperCommand, environment) {
  const envSettings = settings?.env && typeof settings.env === "object" ? settings.env : {};
  const configured = [
    ["ANTHROPIC_API_KEY", environment.ANTHROPIC_API_KEY || envSettings.ANTHROPIC_API_KEY],
    ["ANTHROPIC_AUTH_TOKEN", environment.ANTHROPIC_AUTH_TOKEN || envSettings.ANTHROPIC_AUTH_TOKEN],
  ].filter(([, value]) => String(value || "").trim());
  if (configured.length) {
    throw new Error(
      `Claude credential configuration would override PromptRail (${configured.map(([name]) => name).join(", ")}); refusing to install Infinite.`,
    );
  }
  const existingHelper = String(settings.apiKeyHelper || "").trim();
  if (existingHelper && existingHelper !== helperCommand) {
    throw new Error("Claude apiKeyHelper is already configured; refusing to replace it.");
  }
}

function infiniteCustomHeaders(value = "") {
  const lines = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = lines.find((line) =>
    /^x-promptrail-diagnostics\s*:/i.test(line));
  if (diagnostic && diagnostic.toLowerCase() !== PROMPTRAIL_INFINITE_DIAGNOSTIC_HEADER.toLowerCase()) {
    throw new Error(
      "ANTHROPIC_CUSTOM_HEADERS already configures X-PromptRail-Diagnostics; refusing to replace it.",
    );
  }
  if (!diagnostic) lines.push(PROMPTRAIL_INFINITE_DIAGNOSTIC_HEADER);
  return lines.join("\n");
}

export function patchInfiniteClaudeSettings(
  original,
  baseUrl = infiniteClaudeBaseUrl(),
  helperCommand = shellQuote(infiniteApiKeyHelperPath()),
  environment = process.env,
) {
  const settings = parseSettings(original);
  const normalizedBaseUrl = infiniteClaudeBaseUrl(baseUrl);
  assertNoInfiniteCredentialConflict(settings, helperCommand, environment);
  const existingBaseUrl = String(settings.env?.ANTHROPIC_BASE_URL || "").trim();
  if (existingBaseUrl && infiniteClaudeBaseUrl(existingBaseUrl) !== normalizedBaseUrl) {
    throw new Error(
      `ANTHROPIC_BASE_URL is already configured as ${existingBaseUrl}; refusing to replace it.`,
    );
  }
  const existingModel = String(settings.env?.ANTHROPIC_MODEL || "").trim();
  if (existingModel && existingModel !== PROMPTRAIL_INFINITE_MODEL) {
    throw new Error(
      `ANTHROPIC_MODEL is already configured as ${existingModel}; refusing to replace it.`,
    );
  }
  const existingDiscovery = String(
    settings.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY || "",
  ).trim();
  if (existingDiscovery && existingDiscovery !== PROMPTRAIL_INFINITE_MODEL_DISCOVERY) {
    throw new Error(
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY is explicitly disabled; refusing to replace it.",
    );
  }
  const customHeaders = infiniteCustomHeaders(settings.env?.ANTHROPIC_CUSTOM_HEADERS);
  return `${JSON.stringify({
    ...settings,
    apiKeyHelper: helperCommand,
    env: {
      ...(settings.env || {}),
      ANTHROPIC_BASE_URL: normalizedBaseUrl,
      ANTHROPIC_MODEL: PROMPTRAIL_INFINITE_MODEL,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: PROMPTRAIL_INFINITE_MODEL_DISCOVERY,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    },
  }, null, 2)}\n`;
}

async function inspectInfiniteHelper(helperPath) {
  try {
    const fileStat = await lstat(helperPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Refusing to overwrite a non-regular Infinite key helper at ${helperPath}.`);
    }
    const contents = await readFile(helperPath, "utf8");
    if (contents !== PROMPTRAIL_INFINITE_HELPER) {
      throw new Error(`Refusing to overwrite a modified Infinite key helper at ${helperPath}.`);
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function upgradeInstalledInfiniteClaudeSettings({
  path,
  statePath,
  baseUrl,
  helperPath,
  environment,
  state,
}) {
  if (state.settingsPath !== path) {
    throw new Error("Infinite install state belongs to different Claude settings; refusing to overwrite it.");
  }
  if (state.helperPath && state.helperPath !== helperPath) {
    throw new Error("Infinite install state belongs to a different key helper; refusing to overwrite it.");
  }
  const current = await readFile(path, "utf8");
  if (sha256(current) !== state.installedSha256) {
    throw new Error(
      "Claude settings changed after PromptRail Infinite installation; refusing to overwrite those changes.",
    );
  }
  const helperCommand = shellQuote(helperPath);
  const installed = patchInfiniteClaudeSettings(
    state.original || "",
    baseUrl,
    helperCommand,
    environment,
  );
  const helperAlreadyExisted = await inspectInfiniteHelper(helperPath);
  const upgradedState = {
    ...state,
    settingsPath: path,
    baseUrl,
    helperPath,
    helperCommand,
    helperExisted: state.helperExisted ?? helperAlreadyExisted,
    helperSha256: sha256(PROMPTRAIL_INFINITE_HELPER),
    customHeaders: parseSettings(installed).env?.ANTHROPIC_CUSTOM_HEADERS,
    installedSha256: sha256(installed),
  };
  try {
    if (!helperAlreadyExisted) {
      await mkdir(dirname(helperPath), { recursive: true, mode: 0o700 });
      await atomicWriteFile(helperPath, PROMPTRAIL_INFINITE_HELPER, 0o700);
    }
    await atomicWriteFile(path, installed, 0o600);
    await atomicWriteFile(statePath, `${JSON.stringify(upgradedState, null, 2)}\n`, 0o600);
  } catch (error) {
    await atomicWriteFile(path, current, 0o600).catch(() => {});
    if (!helperAlreadyExisted) await unlink(helperPath).catch(() => {});
    throw error;
  }
  return { path, statePath, helperPath };
}

export async function installInfiniteClaudeSettings({
  baseUrl = infiniteClaudeBaseUrl(),
  path = claudeSettingsPath(),
  statePath = infiniteInstallStatePath(),
  helperPath,
  environment = process.env,
} = {}) {
  statePath = await resolveInfiniteInstallStatePath(statePath);
  helperPath ||= infiniteApiKeyHelperPath(statePath);
  const normalizedBaseUrl = infiniteClaudeBaseUrl(baseUrl);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    return upgradeInstalledInfiniteClaudeSettings({
      path,
      statePath,
      baseUrl: normalizedBaseUrl,
      helperPath,
      environment,
      state,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let original = "";
  let existed = true;
  try {
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existed = false;
  }
  const helperCommand = shellQuote(helperPath);
  const installed = patchInfiniteClaudeSettings(
    original,
    normalizedBaseUrl,
    helperCommand,
    environment,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(helperPath), { recursive: true, mode: 0o700 });
  const helperExisted = await inspectInfiniteHelper(helperPath);
  const state = {
    settingsPath: path,
    original,
    existed,
    baseUrl: normalizedBaseUrl,
    helperPath,
    helperCommand,
    helperExisted,
    helperSha256: sha256(PROMPTRAIL_INFINITE_HELPER),
    customHeaders: parseSettings(installed).env?.ANTHROPIC_CUSTOM_HEADERS,
    installedSha256: sha256(installed),
  };
  await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  try {
    if (!helperExisted) {
      await atomicWriteFile(helperPath, PROMPTRAIL_INFINITE_HELPER, 0o700);
    }
    await atomicWriteFile(path, installed, 0o600);
  } catch (error) {
    if (!helperExisted) await unlink(helperPath).catch(() => {});
    await unlink(statePath).catch(() => {});
    throw error;
  }
  return { path, statePath, helperPath };
}

async function removeInfiniteHelper(state) {
  if (!state.helperPath || !state.helperSha256 || state.helperExisted) return false;
  try {
    const fileStat = await lstat(state.helperPath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return false;
    const current = await readFile(state.helperPath, "utf8");
    if (sha256(current) !== state.helperSha256) return false;
    await unlink(state.helperPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function uninstallInfiniteClaudeSettings(statePath = infiniteInstallStatePath()) {
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
    current = await readFile(state.settingsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      await removeInfiniteHelper(state);
      return state.settingsPath;
    }
    throw error;
  }
  if (sha256(current) === state.installedSha256) {
    if (state.existed) {
      await atomicWriteFile(state.settingsPath, state.original, 0o600);
    } else {
      await unlink(state.settingsPath);
    }
    await removeInfiniteHelper(state);
    return state.settingsPath;
  }
  const settings = parseSettings(current);
  const original = parseSettings(state.original || "");
  const currentEnv = settings.env;
  const originalEnv = original.env;
  if (currentEnv && typeof currentEnv === "object" && !Array.isArray(currentEnv)) {
    for (const [key, installedValue] of Object.entries({
      ANTHROPIC_BASE_URL: state.baseUrl || PROMPTRAIL_INFINITE_BASE_URL,
      ANTHROPIC_MODEL: PROMPTRAIL_INFINITE_MODEL,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: PROMPTRAIL_INFINITE_MODEL_DISCOVERY,
      ANTHROPIC_CUSTOM_HEADERS: state.customHeaders
        || infiniteCustomHeaders(originalEnv?.ANTHROPIC_CUSTOM_HEADERS),
    })) {
      if (currentEnv[key] !== installedValue) continue;
      if (originalEnv && typeof originalEnv === "object" && Object.hasOwn(originalEnv, key)) {
        currentEnv[key] = originalEnv[key];
      } else {
        delete currentEnv[key];
      }
    }
    if (Object.keys(currentEnv).length === 0 && !Object.hasOwn(original, "env")) delete settings.env;
  }
  if (state.helperCommand && settings.apiKeyHelper === state.helperCommand) {
    if (Object.hasOwn(original, "apiKeyHelper")) {
      settings.apiKeyHelper = original.apiKeyHelper;
    } else {
      delete settings.apiKeyHelper;
    }
  }
  if (!state.existed && Object.keys(settings).length === 0) {
    await unlink(state.settingsPath);
  } else {
    await atomicWriteFile(state.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  }
  await removeInfiniteHelper(state);
  return state.settingsPath;
}

export async function infiniteClaudeStatus(statePath = infiniteInstallStatePath()) {
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
    || typeof state.settingsPath !== "string"
    || typeof state.installedSha256 !== "string"
    || typeof state.helperPath !== "string"
    || typeof state.helperCommand !== "string"
    || typeof state.helperSha256 !== "string"
  ) {
    return { configured: false, reason: "corrupt_state", statePath };
  }
  try {
    const raw = await readFile(state.settingsPath, "utf8");
    const settings = parseSettings(raw);
    if (
      sha256(raw) !== state.installedSha256
      || settings.apiKeyHelper !== state.helperCommand
      || settings.env?.ANTHROPIC_BASE_URL !== state.baseUrl
      || settings.env?.ANTHROPIC_MODEL !== PROMPTRAIL_INFINITE_MODEL
      || settings.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY !== PROMPTRAIL_INFINITE_MODEL_DISCOVERY
      || settings.env?.ANTHROPIC_CUSTOM_HEADERS !== (
        state.customHeaders
        || infiniteCustomHeaders(parseSettings(state.original || "").env?.ANTHROPIC_CUSTOM_HEADERS)
      )
    ) {
      return { configured: false, reason: "settings_modified", statePath };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "settings_missing", statePath };
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return { configured: false, reason: "settings_modified", statePath };
    }
    throw error;
  }
  try {
    const fileStat = await lstat(state.helperPath);
    const helper = await readFile(state.helperPath, "utf8");
    if (
      fileStat.isSymbolicLink()
      || !fileStat.isFile()
      || sha256(helper) !== state.helperSha256
    ) {
      return { configured: false, reason: "helper_modified", statePath };
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, reason: "helper_missing", statePath };
    throw error;
  }
  return { configured: true, statePath };
}
