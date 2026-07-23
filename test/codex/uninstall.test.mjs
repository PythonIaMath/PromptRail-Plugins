import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { installCodexConfig } from "../../lib/codex-config.mjs";
import { fakeUserServiceManagers } from "../../test-support/fake-user-service-managers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routerBin = join(repositoryRoot, "bin", "promptrail-codex-router.mjs");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function fakeCodex(directory) {
  const path = join(directory, "codex-fake.mjs");
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "plugin --help") {
  process.stdout.write("Manage Codex plugins\\n");
} else if (args.join(" ") === "plugin list --json") {
  process.stdout.write(JSON.stringify({ installed: existsSync(process.env.FAKE_CODEX_PLUGIN)
    ? [{ pluginId: "promptrail-codex-router@promptrail" }]
    : [] }));
} else if (args[0] === "plugin" && args[1] === "remove") {
  if (existsSync(process.env.FAKE_CODEX_PLUGIN)) unlinkSync(process.env.FAKE_CODEX_PLUGIN);
  process.stdout.write(JSON.stringify({ removed: "promptrail-codex-router@promptrail" }));
} else if (args.join(" ") === "plugin marketplace list --json") {
  process.stdout.write(JSON.stringify({
    marketplaces: existsSync(process.env.FAKE_CODEX_MARKETPLACE)
      ? [{ name: "promptrail" }]
      : [],
  }));
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  if (existsSync(process.env.FAKE_CODEX_MARKETPLACE)) {
    unlinkSync(process.env.FAKE_CODEX_MARKETPLACE);
  }
  process.stdout.write(JSON.stringify({ removed: "promptrail" }));
} else {
  process.stderr.write("unexpected fake Codex command: " + args.join(" ") + "\\n");
  process.exitCode = 2;
}
`);
  await chmod(path, 0o755);
  return path;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-codex-uninstall-"));
  const codexHome = join(directory, "codex");
  const routerHome = join(directory, "router");
  const configPath = join(codexHome, "config.toml");
  const statePath = join(routerHome, "install-state.json");
  const routerConfigPath = join(routerHome, "config.json");
  const modelCatalogPath = join(routerHome, "models.json");
  const pluginMarker = join(directory, "plugin-installed");
  const marketplaceMarker = join(directory, "marketplace-installed");
  const logPath = join(directory, "codex.log");
  const serviceManagers = await fakeUserServiceManagers(directory, process.env.PATH);
  const codexBin = await fakeCodex(directory);
  const env = {
    ...process.env,
    HOME: directory,
    PATH: serviceManagers.path,
    CODEX_BIN: codexBin,
    CODEX_HOME: codexHome,
    PROMPTRAIL_ROUTER_HOME: routerHome,
    PROMPTRAIL_ROUTER_CONFIG: routerConfigPath,
    FAKE_CODEX_LOG: logPath,
    FAKE_CODEX_PLUGIN: pluginMarker,
    FAKE_CODEX_MARKETPLACE: marketplaceMarker,
    FAKE_USER_SERVICE_MANAGER_LOG: serviceManagers.logPath,
  };
  await mkdir(codexHome, { recursive: true });
  await mkdir(routerHome, { recursive: true });
  await writeFile(pluginMarker, "installed\n");
  await writeFile(marketplaceMarker, "installed\n");
  return {
    directory,
    configPath,
    statePath,
    routerConfigPath,
    modelCatalogPath,
    pluginMarker,
    marketplaceMarker,
    logPath,
    serviceManagerLogPath: serviceManagers.logPath,
    env,
  };
}

test("Codex uninstall preserves config changes and removes all PromptRail artifacts", async () => {
  const values = await fixture();
  try {
    const original = 'model_provider = "openai"\n\n[profiles.local]\nmodel = "gpt-5.6-luna"\n';
    await writeFile(values.configPath, original);
    await installCodexConfig(values.configPath, values.statePath, values.modelCatalogPath);
    const installed = await readFile(values.configPath, "utf8");
    await writeFile(values.configPath, installed.replace(
      "# <<< promptrail-codex-router provider <<<",
      `[projects."${values.directory}"]\ntrust_level = "trusted"\n\n[hooks.state]\n\n[hooks.state."promptrail-codex-router@promptrail:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:test"\n\n[tui.model_availability_nux]\n"gpt-5.6-sol" = 1\n\n# <<< promptrail-codex-router provider <<<`,
    ));
    await writeFile(values.routerConfigPath, "{\"routerToken\":\"test-only\"}\n");
    await writeFile(values.modelCatalogPath, "{}\n");

    const result = spawnSync(process.execPath, [routerBin, "uninstall"], {
      env: values.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const restored = await readFile(values.configPath, "utf8");
    assert.match(restored, /^model_provider = "openai"/);
    assert.match(restored, /\[profiles\.local\]\nmodel = "gpt-5\.6-luna"/);
    assert.match(restored, /trust_level = "trusted"/);
    assert.match(restored, /\[hooks\.state\]/);
    assert.match(restored, /\[tui\.model_availability_nux\]/);
    assert.doesNotMatch(restored, /promptrail-codex-router|model_providers\.promptrail/);
    assert.equal(await exists(values.pluginMarker), false);
    assert.equal(await exists(values.marketplaceMarker), false);
    assert.equal(await exists(values.routerConfigPath), false);
    assert.equal(await exists(values.modelCatalogPath), false);
    assert.equal(await exists(values.statePath), false);
    assert.match(await readFile(values.serviceManagerLogPath, "utf8"), /bootout|disable/);
    const calls = (await readFile(values.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      ["plugin", "--help"],
      ["plugin", "list", "--json"],
      ["plugin", "remove", "promptrail-codex-router@promptrail", "--json"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "remove", "promptrail", "--json"],
    ]);

    const repeated = spawnSync(process.execPath, [routerBin, "uninstall"], {
      env: values.env,
      encoding: "utf8",
    });
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /is not installed/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("Codex uninstall cleans remaining artifacts when install state is missing", async () => {
  const values = await fixture();
  try {
    await writeFile(values.routerConfigPath, "{\"routerToken\":\"test-only\"}\n");
    await writeFile(values.modelCatalogPath, "{}\n");
    const result = spawnSync(process.execPath, [routerBin, "uninstall"], {
      env: values.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(values.pluginMarker), false);
    assert.equal(await exists(values.marketplaceMarker), false);
    assert.equal(await exists(values.routerConfigPath), false);
    assert.equal(await exists(values.modelCatalogPath), false);
    assert.match(result.stdout, /Removed PromptRail Codex artifacts/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});
