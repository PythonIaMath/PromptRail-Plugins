#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  installCodexConfig,
  installStatePath,
  upgradeInstalledCodexConfig,
  uninstallCodexConfig,
} from "../lib/codex-config.mjs";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  installModelCatalog,
  routerConfigPath,
  routerModelCatalogPath,
  saveRouterConfig,
} from "../plugins/promptrail-codex-router/src/config.mjs";
import { startProxy } from "../plugins/promptrail-codex-router/src/proxy.mjs";
import { installUserService, uninstallUserService } from "../lib/codex-user-service.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let resolvedCodexBinary;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function codexBinary() {
  if (resolvedCodexBinary) {
    return resolvedCodexBinary;
  }
  const explicit = process.env.CODEX_BIN || process.env.CODEX_CLI_PATH;
  const candidates = explicit
    ? [explicit]
    : [
        "codex",
        ...(process.platform === "darwin"
          ? ["/Applications/Codex.app/Contents/Resources/codex"]
          : []),
      ];
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) {
      continue;
    }
    const result = spawnSync(candidate, ["plugin", "--help"], { encoding: "utf8" });
    if (!result.error && result.status === 0) {
      resolvedCodexBinary = candidate;
      if (candidate !== "codex") {
        process.stdout.write(`Using Codex CLI: ${candidate}\n`);
      }
      return candidate;
    }
  }
  throw new Error(
    "A Codex CLI with plugin support is required. Update Codex or set CODEX_BIN to the compatible executable.",
  );
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

function runJson(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

async function install() {
  const graderUrl = option("--grader-url") || process.env.PROMPTRAIL_GRADER_URL;
  const routerToken = option("--token") || process.env.PROMPTRAIL_ROUTER_TOKEN;
  if (!graderUrl || !routerToken) {
    throw new Error(
      "install requires --grader-url and --token, or PROMPTRAIL_GRADER_URL and PROMPTRAIL_ROUTER_TOKEN.",
    );
  }
  let installedPluginRoot = resolve(repositoryRoot, "plugins", "promptrail-codex-router");
  if (!process.argv.includes("--skip-plugin-install")) {
    const marketplaceSource = process.env.PROMPTRAIL_MARKETPLACE_SOURCE || repositoryRoot;
    runJson(codexBinary(), ["plugin", "marketplace", "add", marketplaceSource, "--json"]);
    const installedPlugin = runJson(codexBinary(), [
      "plugin",
      "add",
      "promptrail-codex-router@promptrail",
      "--json",
    ]);
    installedPluginRoot = installedPlugin.installedPath;
  }
  await saveRouterConfig({
    graderUrl,
    routerToken,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
  });
  const catalogPath = await installModelCatalog(installedPluginRoot);
  const installed = await installCodexConfig(undefined, undefined, catalogPath);
  const service = await installUserService(installedPluginRoot);
  process.stdout.write(
    `PromptRail router installed. Codex config: ${installed.path}\nUser service: ${service.manager} (${service.path})\nStart a new Codex thread to activate routing.\n`,
  );
}

async function status() {
  const script = resolve(
    repositoryRoot,
    "plugins",
    "promptrail-codex-router",
    "scripts",
    "status.mjs",
  );
  run(process.execPath, [script]);
}

async function uninstall() {
  const path = await uninstallCodexConfig();
  await uninstallUserService();
  if (!process.argv.includes("--skip-plugin-remove")) {
    run(codexBinary(), ["plugin", "remove", "promptrail-codex-router@promptrail"]);
  }
  await unlink(routerConfigPath());
  await unlink(routerModelCatalogPath());
  await unlink(installStatePath());
  process.stdout.write(
    `Restored the pre-install Codex config at ${path} and removed the local router credential.\n`,
  );
}

async function serviceInstall() {
  const pluginRoot = option("--plugin-root");
  if (!pluginRoot) {
    throw new Error("service-install requires --plugin-root.");
  }
  const catalogPath = await installModelCatalog(pluginRoot);
  await upgradeInstalledCodexConfig(catalogPath);
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
      "Usage: promptrail-codex-router <install|serve|status|uninstall|service-install> [options]\n",
    );
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
