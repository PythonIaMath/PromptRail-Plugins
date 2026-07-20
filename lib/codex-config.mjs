import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

export function patchCodexConfig(original, modelCatalogPath) {
  if (original.includes("[model_providers.promptrail]")) {
    throw new Error("model_providers.promptrail already exists; refusing to overwrite it.");
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
    `${JSON.stringify({ configPath: path, original, installedSha256: sha256(installed) }, null, 2)}\n`,
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
  const current = await readFile(state.configPath, "utf8");
  if (sha256(current) !== state.installedSha256) {
    throw new Error(
      "Codex config changed after PromptRail installation; refusing to overwrite those changes.",
    );
  }
  await writeFile(state.configPath, state.original, { mode: 0o600 });
  await chmod(state.configPath, 0o600);
  return state.configPath;
}
