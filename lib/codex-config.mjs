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
const MANAGED_COMMENT = "managed by promptrail-codex-router";

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
