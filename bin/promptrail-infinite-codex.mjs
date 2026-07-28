#!/usr/bin/env node

import { unlink } from "node:fs/promises";

import {
  buildInfiniteModelCatalog,
  infiniteBaseUrl,
  infiniteInstallStatePath,
  infiniteCodexStatus,
  installInfiniteCodexConfig,
  resolveInfiniteInstallStatePath,
  uninstallInfiniteCodexConfig,
} from "../lib/codex-config.mjs";
import { fetchInfiniteModelRecords } from "../lib/infinite-model-discovery.mjs";

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
    const records = await fetchInfiniteModelRecords({
      baseUrl: infiniteBaseUrl(),
      apiKey,
    });
    const modelCatalog = buildInfiniteModelCatalog(records);
    const installed = await installInfiniteCodexConfig(
      undefined,
      undefined,
      undefined,
      undefined,
      modelCatalog,
      apiKey,
    );
    const directModels = Math.max(modelCatalog.models.length - 1, 0);
    process.stdout.write(
      `PromptRail Infinite Codex configuration installed: ${installed.path}\n`
      + `${directModels} direct model${directModels === 1 ? "" : "s"} added to /model. `
      + `The PromptRail token is stored in a user-only file. Restart Codex to reload the catalog.\n`,
    );
    return;
  }
  if (command === "status") {
    const status = await infiniteCodexStatus();
    process.stdout.write(`${JSON.stringify({ mode: "infinite", ...status })}\n`);
    return;
  }
  if (command === "uninstall") {
    const statePath = await resolveInfiniteInstallStatePath(infiniteInstallStatePath());
    const path = await uninstallInfiniteCodexConfig();
    if (!path) {
      process.stdout.write("PromptRail Infinite Codex configuration is not installed.\n");
      return;
    }
    await unlinkIfExists(statePath);
    process.stdout.write(`Restored the pre-install Codex config at ${path}.\n`);
    return;
  }
  process.stderr.write("Usage: promptrail-infinite-codex <install|status|uninstall>\n");
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
