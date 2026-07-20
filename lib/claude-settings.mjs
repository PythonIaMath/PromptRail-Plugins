import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  const current = await readFile(state.settingsPath, "utf8");
  if (sha256(current) !== state.installedSha256) {
    throw new Error(
      "Claude settings changed after PromptRail installation; refusing to overwrite those changes.",
    );
  }
  if (state.existed) {
    await writeFile(state.settingsPath, state.original, { mode: 0o600 });
    await chmod(state.settingsPath, 0o600);
  } else {
    await unlink(state.settingsPath);
  }
  return state.settingsPath;
}
