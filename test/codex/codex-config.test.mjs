import assert from "node:assert/strict";
import test from "node:test";

import { patchCodexConfig } from "../../lib/codex-config.mjs";

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
