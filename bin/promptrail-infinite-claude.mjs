#!/usr/bin/env node

import { unlink } from "node:fs/promises";

import {
  infiniteClaudeBaseUrl,
  infiniteClaudeStatus,
  infiniteInstallStatePath,
  installInfiniteClaudeSettings,
  resolveInfiniteInstallStatePath,
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
    const apiKey = String(process.env.PROMPTRAIL_API_KEY || "").trim();
    const baseUrl = infiniteClaudeBaseUrl();
    const installed = await installInfiniteClaudeSettings({ baseUrl, apiKey });
    process.stdout.write(
      `PromptRail Infinite Claude configuration installed: ${installed.path}\n`
      + `The PromptRail token is stored in a user-only file and read through ${installed.helperPath}.\n`,
    );
    return;
  }
  if (command === "status") {
    const status = await infiniteClaudeStatus();
    process.stdout.write(`${JSON.stringify({ mode: "infinite", ...status })}\n`);
    return;
  }
  if (command === "uninstall") {
    const statePath = await resolveInfiniteInstallStatePath(infiniteInstallStatePath());
    const path = await uninstallInfiniteClaudeSettings();
    if (!path) {
      process.stdout.write("PromptRail Infinite Claude configuration is not installed.\n");
      return;
    }
    await unlinkIfExists(statePath);
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
