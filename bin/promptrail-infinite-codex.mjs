#!/usr/bin/env node

import { unlink } from "node:fs/promises";

import {
  buildInfiniteModelCatalog,
  INFINITE_MODEL_CATALOG,
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
    let modelCatalog = INFINITE_MODEL_CATALOG;
    if (apiKey) {
      const records = await fetchInfiniteModelRecords({
        baseUrl: infiniteBaseUrl(),
        apiKey,
      });
      modelCatalog = buildInfiniteModelCatalog(records);
    }
    const installed = await installInfiniteCodexConfig(
      undefined,
      undefined,
      undefined,
      undefined,
      modelCatalog,
    );
    const directModels = Math.max(modelCatalog.models.length - 1, 0);
    process.stdout.write(
      `PromptRail Infinite Codex configuration installed: ${installed.path}\n`
      + (apiKey
        ? `${directModels} direct model${directModels === 1 ? "" : "s"} added to /model. Restart Codex to reload the catalog.\n`
        : "Set PROMPTRAIL_API_KEY, then run the Infinite install again to add direct models to /model.\n"),
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
