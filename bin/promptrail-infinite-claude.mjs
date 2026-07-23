#!/usr/bin/env node

import { unlink } from "node:fs/promises";

import {
  infiniteInstallStatePath,
  installInfiniteClaudeSettings,
  uninstallInfiniteClaudeSettings,
} from "../lib/claude-settings.mjs";

async function unlinkIfExists(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "install") {
    const installed = await installInfiniteClaudeSettings();
    process.stdout.write(
      `PromptRail Infinite Claude configuration installed: ${installed.path}\nSet PROMPTRAIL_API_KEY in your user environment before using it.\n`,
    );
    return;
  }
  if (command === "status") {
    const statePath = infiniteInstallStatePath();
    try {
      await import("node:fs/promises").then(({ readFile }) => readFile(statePath, "utf8"));
      process.stdout.write('{"mode":"infinite","configured":true}\n');
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      process.stdout.write('{"mode":"infinite","configured":false,"reason":"not_installed"}\n');
    }
    return;
  }
  if (command === "uninstall") {
    const path = await uninstallInfiniteClaudeSettings();
    if (!path) {
      process.stdout.write("PromptRail Infinite Claude configuration is not installed.\n");
      return;
    }
    await unlinkIfExists(infiniteInstallStatePath());
    process.stdout.write(`Restored Claude settings at ${path}.\n`);
    return;
  }
  process.stderr.write("Usage: promptrail-infinite-claude <install|status|uninstall>\n");
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
