import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";

import { join } from "node:path";

import {
  installCodexConfig,
  patchCodexConfig,
  uninstallCodexConfig,
  unpatchCodexConfig,
} from "../../lib/codex-config.mjs";

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

test("removes only managed Codex config while preserving post-install changes", () => {
  const original = 'model_provider = "openai"\n\n[profiles.local]\nmodel = "gpt-5.6-luna"\n';
  const catalogPath = "/home/user/.codex/promptrail-router/models.json";
  const installed = patchCodexConfig(original, catalogPath);
  const current = installed.replace(
    "# <<< promptrail-codex-router provider <<<",
    `[projects."/home/user/project"]\ntrust_level = "trusted"\n\n[hooks.state]\n\n[hooks.state."promptrail-codex-router@promptrail:hooks/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:test"\n\n[tui.model_availability_nux]\n"gpt-5.6-sol" = 1\n\n# <<< promptrail-codex-router provider <<<`,
  );
  const restored = unpatchCodexConfig(current, original, catalogPath);
  assert.match(restored, /^model_provider = "openai"/);
  assert.match(restored, /\[profiles\.local\]\nmodel = "gpt-5\.6-luna"/);
  assert.match(restored, /\[projects\."\/home\/user\/project"\]\ntrust_level = "trusted"/);
  assert.match(restored, /\[hooks\.state\]/);
  assert.match(restored, /\[tui\.model_availability_nux\]\n"gpt-5\.6-sol" = 1/);
  assert.doesNotMatch(restored, /promptrail-codex-router|model_providers\.promptrail/);
  assert.doesNotMatch(restored, /model_catalog_json/);
});

test("preserves a provider selected by the user after installation", () => {
  const catalogPath = "/home/user/.codex/promptrail-router/models.json";
  const installed = patchCodexConfig("", catalogPath)
    .replace(
      'model_provider = "promptrail" # managed by promptrail-codex-router',
      'model_provider = "openai" # changed by user',
    )
    .replace(
      `model_catalog_json = "${catalogPath}" # managed by promptrail-codex-router`,
      'model_catalog_json = "/home/user/custom-models.json" # changed by user',
    );
  const restored = unpatchCodexConfig(installed, "", catalogPath);
  assert.match(restored, /model_provider = "openai" # changed by user/);
  assert.match(restored, /model_catalog_json = "\/home\/user\/custom-models\.json"/);
  assert.doesNotMatch(restored, /model_providers\.promptrail/);
});

test("legacy install state preserves Codex changes made after installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-codex-config-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  await writeFile(configPath, 'model = "gpt-5.6-sol"\n');
  try {
    await installCodexConfig(configPath, statePath, catalogPath);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.modelCatalogPath;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const installed = await readFile(configPath, "utf8");
    await writeFile(configPath, installed.replace(
      "# <<< promptrail-codex-router provider <<<",
      `[projects."${directory}"]\ntrust_level = "trusted"\n\n# <<< promptrail-codex-router provider <<<`,
    ));
    await uninstallCodexConfig(statePath);
    const restored = await readFile(configPath, "utf8");
    assert.match(restored, /^model = "gpt-5\.6-sol"/);
    assert.match(restored, /trust_level = "trusted"/);
    assert.doesNotMatch(restored, /model_provider|model_catalog_json|model_providers\.promptrail/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores the exact original Codex config when it did not change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-codex-config-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const original = 'model_provider = "openai"\n';
  await writeFile(configPath, original);
  try {
    await installCodexConfig(configPath, statePath, join(directory, "models.json"));
    await uninstallCodexConfig(statePath);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats a missing Codex config file as already restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-codex-config-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  await writeFile(configPath, "");
  try {
    await installCodexConfig(configPath, statePath, join(directory, "models.json"));
    await unlink(configPath);
    assert.equal(await uninstallCodexConfig(statePath), configPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats uninstalling a missing Codex router as already uninstalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-missing-codex-"));
  try {
    assert.equal(await uninstallCodexConfig(join(directory, "install-state.json")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
