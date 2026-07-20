#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  installClaudeSettings,
  installStatePath,
  uninstallClaudeSettings,
} from "../lib/claude-settings.mjs";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  routerConfigPath,
  saveRouterConfig,
} from "../plugins/promptrail-claude-router/src/config.mjs";
import { startProxy } from "../plugins/promptrail-claude-router/src/proxy.mjs";
import { installUserService, uninstallUserService } from "../lib/claude-user-service.mjs";
import {
  assertClaudeSubscriptionStatus,
  claudeSubscriptionError,
} from "../lib/claude-auth.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function claudeBinary() {
  return process.env.CLAUDE_BIN || "claude";
}

function hasClaudeBinary() {
  const result = spawnSync(claudeBinary(), ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

function runJson(command, args, { allowNonzeroJson = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowNonzeroJson) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}: ${result.stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${command} ${args.join(" ")} did not return valid JSON: ${result.stderr.trim()}`,
      { cause: error },
    );
  }
}

function installedPluginRoot() {
  const plugins = runJson(claudeBinary(), ["plugin", "list", "--json"]);
  const plugin = plugins.find((entry) => entry.id === "promptrail-claude-router@promptrail");
  if (!plugin?.installPath) {
    throw new Error("Claude installed PromptRail but did not report its plugin path.");
  }
  return plugin.installPath;
}

async function install() {
  const graderUrl = option("--grader-url") || process.env.PROMPTRAIL_GRADER_URL;
  const routerToken = option("--token") || process.env.PROMPTRAIL_ROUTER_TOKEN;
  if (!graderUrl || !routerToken) {
    throw new Error(
      "install requires --grader-url and --token, or PROMPTRAIL_GRADER_URL and PROMPTRAIL_ROUTER_TOKEN.",
    );
  }

  if (process.env.PROMPTRAIL_OPTIONAL_CLIENT === "1" && !hasClaudeBinary()) {
    process.stdout.write("Claude Code CLI was not found; skipped Claude setup.\n");
    return;
  }

  const subscriptionStatus = runJson(
    claudeBinary(),
    ["auth", "status", "--json"],
    { allowNonzeroJson: true },
  );
  const subscriptionError = claudeSubscriptionError(subscriptionStatus);
  if (process.env.PROMPTRAIL_OPTIONAL_CLIENT === "1" && subscriptionError) {
    process.stdout.write(`${subscriptionError} Skipped Claude setup.\n`);
    return;
  }
  assertClaudeSubscriptionStatus(subscriptionStatus);
  let pluginRoot = resolve(repositoryRoot, "plugins", "promptrail-claude-router");
  if (!process.argv.includes("--skip-plugin-install")) {
    run(claudeBinary(), ["plugin", "marketplace", "add", repositoryRoot, "--scope", "user"]);
    run(claudeBinary(), [
      "plugin",
      "install",
      "promptrail-claude-router@promptrail",
      "--scope",
      "user",
    ]);
    pluginRoot = installedPluginRoot();
  }

  await saveRouterConfig({
    graderUrl,
    routerToken,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  });
  const settings = await installClaudeSettings({
    baseUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`,
  });
  const service = await installUserService(pluginRoot);
  process.stdout.write(
    `PromptRail Claude router installed. Claude settings: ${settings.path}\nUser service: ${service.manager} (${service.path})\nStart a new Claude Code session to activate routing.\n`,
  );
}

async function status() {
  const script = resolve(
    repositoryRoot,
    "plugins",
    "promptrail-claude-router",
    "scripts",
    "status.mjs",
  );
  run(process.execPath, [script]);
}

async function uninstall() {
  const settingsPath = await uninstallClaudeSettings();
  if (!settingsPath) {
    process.stdout.write("PromptRail Claude router is not installed.\n");
    return;
  }
  await uninstallUserService();
  if (!process.argv.includes("--skip-plugin-remove")) {
    run(claudeBinary(), ["plugin", "uninstall", "promptrail-claude-router@promptrail", "--scope", "user"]);
  }
  await unlink(routerConfigPath());
  await unlink(installStatePath());
  process.stdout.write(
    `Restored Claude settings at ${settingsPath} and removed the local router credential.\n`,
  );
}

async function serviceInstall() {
  const pluginRoot = option("--plugin-root");
  if (!pluginRoot) {
    throw new Error("service-install requires --plugin-root.");
  }
  const service = await installUserService(pluginRoot);
  process.stdout.write(`Installed ${service.manager} service at ${service.path}.\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === "install") {
    await install();
  } else if (command === "serve") {
    await startProxy();
  } else if (command === "status") {
    await status();
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "service-install") {
    await serviceInstall();
  } else {
    process.stderr.write(
      "Usage: promptrail-claude-router <install|serve|status|uninstall|service-install> [options]\n",
    );
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
