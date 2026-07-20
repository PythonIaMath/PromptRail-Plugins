import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { join } from "node:path";

import { patchCodexConfig, uninstallCodexConfig } from "../../lib/codex-config.mjs";

test("configures PromptRail as the default provider", () => {
  const patched = patchCodexConfig(
    'model = "gpt-5.6-sol"\n',
    "/home/user/.codex/promptrail-router/models.json",
  );
  assert.match(patched, /^model_catalog_json = "/);
  assert.match(patched, /model_provider = "promptrail"/);
  assert.match(patched, /model_catalog_json = "\/home\/user\/\.codex\/promptrail-router\/models\.json"/);
  assert.match(patched, /\[model_providers\.promptrail\]/);
  assert.match(patched, /requires_openai_auth = true/);
  assert.match(patched, /supports_websockets = false/);
});

test("replaces an existing top-level provider and preserves profile providers", () => {
  const patched = patchCodexConfig(
    'model_provider = "openai"\n\n[profiles.local]\nmodel_provider = "ollama"\n',
  );
  assert.match(patched, /^model_provider = "promptrail"/);
  assert.match(patched, /\[profiles\.local\]\nmodel_provider = "ollama"/);
});

test("refuses to overwrite an existing PromptRail provider", () => {
  assert.throws(
    () => patchCodexConfig("[model_providers.promptrail]\nbase_url = \"http://other\"\n"),
    /refusing to overwrite/,
  );
});

test("treats uninstalling a missing Codex router as already uninstalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-missing-codex-"));
  try {
    assert.equal(await uninstallCodexConfig(join(directory, "install-state.json")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
