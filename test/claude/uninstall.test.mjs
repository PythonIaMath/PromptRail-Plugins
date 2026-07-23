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

import { installClaudeSettings } from "../../lib/claude-settings.mjs";
import { fakeUserServiceManagers } from "../../test-support/fake-user-service-managers.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const routerBin = join(repositoryRoot, "bin", "promptrail-claude-router.mjs");

const CLEAN_ENVIRONMENT = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
};

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

async function fakeClaude(directory) {
  const path = join(directory, "claude-fake.mjs");
  await writeFile(path, `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
if (args.join(" ") === "plugin list --json") {
  process.stdout.write(JSON.stringify(existsSync(process.env.FAKE_CLAUDE_PLUGIN)
    ? [{ id: "promptrail-claude-router@promptrail", installPath: "/tmp/plugin" }]
    : []));
} else if (args[0] === "plugin" && args[1] === "uninstall") {
  if (existsSync(process.env.FAKE_CLAUDE_PLUGIN)) unlinkSync(process.env.FAKE_CLAUDE_PLUGIN);
} else if (args.join(" ") === "plugin marketplace list --json") {
  process.stdout.write(JSON.stringify(existsSync(process.env.FAKE_CLAUDE_MARKETPLACE)
    ? [{ name: "promptrail" }]
    : []));
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  if (existsSync(process.env.FAKE_CLAUDE_MARKETPLACE)) {
    unlinkSync(process.env.FAKE_CLAUDE_MARKETPLACE);
  }
} else {
  process.stderr.write("unexpected fake Claude command: " + args.join(" ") + "\\n");
  process.exitCode = 2;
}
`);
  await chmod(path, 0o755);
  return path;
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-uninstall-"));
  const routerHome = join(directory, "router");
  const settingsPath = join(directory, "claude", "settings.json");
  const statePath = join(routerHome, "install-state.json");
  const configPath = join(routerHome, "config.json");
  const pluginMarker = join(directory, "plugin-installed");
  const marketplaceMarker = join(directory, "marketplace-installed");
  const logPath = join(directory, "claude.log");
  const serviceManagers = await fakeUserServiceManagers(directory, process.env.PATH);
  const claudeBin = await fakeClaude(directory);
  const env = {
    ...process.env,
    HOME: directory,
    PATH: serviceManagers.path,
    CLAUDE_BIN: claudeBin,
    CLAUDE_CONFIG_DIR: dirname(settingsPath),
    PROMPTRAIL_CLAUDE_ROUTER_HOME: routerHome,
    PROMPTRAIL_CLAUDE_ROUTER_CONFIG: configPath,
    FAKE_CLAUDE_LOG: logPath,
    FAKE_CLAUDE_PLUGIN: pluginMarker,
    FAKE_CLAUDE_MARKETPLACE: marketplaceMarker,
    FAKE_USER_SERVICE_MANAGER_LOG: serviceManagers.logPath,
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  await mkdir(routerHome, { recursive: true });
  await writeFile(pluginMarker, "installed\n");
  await writeFile(marketplaceMarker, "installed\n");
  return {
    directory,
    routerHome,
    settingsPath,
    statePath,
    configPath,
    pluginMarker,
    marketplaceMarker,
    logPath,
    serviceManagerLogPath: serviceManagers.logPath,
    env,
  };
}

test("Claude uninstall preserves user settings and removes all PromptRail artifacts", async () => {
  const values = await fixture();
  try {
    await writeFile(values.settingsPath, "{\"theme\":\"dark\"}\n");
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: values.settingsPath,
      statePath: values.statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    const installed = JSON.parse(await readFile(values.settingsPath, "utf8"));
    installed.statusLine = { type: "command", command: "printf ready" };
    await writeFile(values.settingsPath, `${JSON.stringify(installed, null, 2)}\n`);
    await writeFile(values.configPath, "{\"routerToken\":\"test-only\"}\n");

    const result = spawnSync(process.execPath, [routerBin, "uninstall"], {
      env: values.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(values.settingsPath, "utf8")), {
      theme: "dark",
      statusLine: { type: "command", command: "printf ready" },
    });
    assert.equal(await exists(values.pluginMarker), false);
    assert.equal(await exists(values.marketplaceMarker), false);
    assert.equal(await exists(values.configPath), false);
    assert.equal(await exists(values.statePath), false);
    assert.match(await readFile(values.serviceManagerLogPath, "utf8"), /bootout|disable/);
    const calls = (await readFile(values.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      ["plugin", "list", "--json"],
      ["plugin", "uninstall", "promptrail-claude-router@promptrail", "--scope", "user"],
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "remove", "promptrail"],
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

test("Claude uninstall cleans remaining artifacts when install state is missing", async () => {
  const values = await fixture();
  try {
    await writeFile(values.configPath, "{\"routerToken\":\"test-only\"}\n");
    const result = spawnSync(process.execPath, [routerBin, "uninstall"], {
      env: values.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await exists(values.pluginMarker), false);
    assert.equal(await exists(values.marketplaceMarker), false);
    assert.equal(await exists(values.configPath), false);
    assert.match(result.stdout, /Removed PromptRail Claude artifacts/);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});

test("Claude uninstall retains install state when settings cleanup needs a retry", async () => {
  const values = await fixture();
  try {
    await writeFile(values.settingsPath, "{}\n");
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: values.settingsPath,
      statePath: values.statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    await writeFile(values.settingsPath, "{invalid json\n");
    await writeFile(values.configPath, "{\"routerToken\":\"test-only\"}\n");

    const result = spawnSync(process.execPath, [routerBin, "uninstall"], {
      env: values.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restore Claude settings/);
    assert.equal(await exists(values.statePath), true);
    assert.equal(await exists(values.pluginMarker), false);
    assert.equal(await exists(values.marketplaceMarker), false);
    assert.equal(await exists(values.configPath), false);
  } finally {
    await rm(values.directory, { recursive: true, force: true });
  }
});
