import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import test from "node:test";

import { join } from "node:path";

import {
  codexConfigPath,
  installCodexConfig,
  installInfiniteCodexConfig,
  infiniteCodexStatus,
  infiniteBaseUrl,
  infiniteInstallStatePath,
  INFINITE_MODEL_CATALOG,
  infiniteModelCatalogPath,
  installStatePath,
  patchCodexConfig,
  patchInfiniteCodexConfig,
  uninstallCodexConfig,
  uninstallInfiniteCodexConfig,
  unpatchCodexConfig,
  unpatchInfiniteCodexConfig,
  upgradeInstalledInfiniteCodexConfig,
} from "../../lib/codex-config.mjs";
import {
  routerConfigPath,
  routerHome,
  routerModelCatalogPath,
} from "../../plugins/promptrail-codex-router/src/config.mjs";

test("keeps Infinite state inside CODEX_HOME without moving existing Plugins state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-codex-home-"));
  const codexHome = join(directory, "codex");
  const keys = [
    "CODEX_HOME",
    "PROMPTRAIL_ROUTER_HOME",
    "PROMPTRAIL_ROUTER_CONFIG",
    "PROMPTRAIL_INFINITE_HOME",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CODEX_HOME = codexHome;
    delete process.env.PROMPTRAIL_ROUTER_HOME;
    delete process.env.PROMPTRAIL_ROUTER_CONFIG;
    delete process.env.PROMPTRAIL_INFINITE_HOME;

    assert.equal(codexConfigPath(), join(codexHome, "config.toml"));
    const legacyRouterHome = join(homedir(), ".codex", "promptrail-router");
    assert.equal(routerHome(), legacyRouterHome);
    assert.equal(routerConfigPath(), join(legacyRouterHome, "config.json"));
    assert.equal(routerModelCatalogPath(), join(legacyRouterHome, "models.json"));
    assert.equal(installStatePath(), join(legacyRouterHome, "install-state.json"));
    assert.equal(
      infiniteInstallStatePath(),
      join(codexHome, "promptrail-infinite", "install-state.json"),
    );
    assert.equal(
      infiniteModelCatalogPath(),
      join(codexHome, "promptrail-infinite", "models.json"),
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

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

test("requires an explicit switch before changing PromptRail modes", () => {
  assert.throws(
    () => patchInfiniteCodexConfig("[model_providers.promptrail]\nbase_url = \"http://127.0.0.1\"\n"),
    /switch infinite/,
  );
  assert.throws(
    () => patchCodexConfig("[model_providers.promptrail-infinite]\nbase_url = \"https://api.promptrail.ai\"\n"),
    /switch plugins/,
  );
});

test("generates a standalone PromptRail Infinite Responses provider", () => {
  const patched = patchInfiniteCodexConfig(
    'model = "gpt-5.6-sol"\n',
    undefined,
    "/home/user/.codex/promptrail-infinite/models.json",
  );
  assert.match(patched, /^model_provider = "promptrail-infinite"/m);
  assert.match(patched, /^model = "promptrail\/infinite"/m);
  assert.match(patched, /\[model_providers\.promptrail-infinite\]/);
  assert.match(patched, /base_url = "https:\/\/api\.promptrail\.ai\/v1"/);
  assert.match(patched, /env_key = "PROMPTRAIL_API_KEY"/);
  assert.match(patched, /requires_openai_auth = false/);
  assert.match(patched, /wire_api = "responses"/);
  assert.match(patched, /model_catalog_json = "\/home\/user\/\.codex\/promptrail-infinite\/models\.json"/);
  assert.doesNotMatch(patched, /127\.0\.0\.1/);
});

test("requires HTTPS for every Infinite endpoint", () => {
  assert.equal(infiniteBaseUrl("https://api.promptrail.ai/v1/"), "https://api.promptrail.ai/v1");
  assert.throws(() => infiniteBaseUrl("http://127.0.0.1:8787/v1"), /HTTPS/);
  assert.throws(() => infiniteBaseUrl("file:///tmp/service"), /HTTPS/);
  assert.throws(() => infiniteBaseUrl("https://user:secret@example.test"), /without credentials/);
});

test("removes only managed Infinite Codex settings after a user edit", () => {
  const original = 'model_provider = "openai"\nmodel = "gpt-5.6-sol"\n';
  const patched = patchInfiniteCodexConfig(original).replace(
    "# <<< promptrail-infinite provider <<<",
    '[profiles.local]\nmodel = "user-model"\n\n# <<< promptrail-infinite provider <<<',
  );
  const restored = unpatchInfiniteCodexConfig(patched, original);
  assert.match(restored, /^model_provider = "openai"/);
  assert.match(restored, /^model = "gpt-5\.6-sol"/m);
  assert.match(restored, /\[profiles\.local\]\nmodel = "user-model"/);
  assert.doesNotMatch(restored, /promptrail-infinite/);
});

test("restores the original config when Infinite is uninstalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-codex-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  const original = 'model_provider = "openai"\n';
  await writeFile(configPath, original);
  try {
    await installInfiniteCodexConfig(configPath, statePath);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(catalog.models[0].slug, "promptrail/infinite");
    assert.equal(catalog.models[0].context_window, 128_000);
    assert.deepEqual(catalog.models[0].input_modalities, ["text"]);
    assert.equal((await stat(catalogPath)).mode & 0o777, 0o600);
    await uninstallInfiniteCodexConfig(statePath);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(() => readFile(catalogPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("updates an unchanged managed Infinite endpoint without losing uninstall state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-upgrade-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  const original = 'model_provider = "openai"\n';
  await writeFile(configPath, original);
  try {
    await installInfiniteCodexConfig(
      configPath,
      statePath,
      "https://old.example/v1",
      catalogPath,
    );
    await installInfiniteCodexConfig(
      configPath,
      statePath,
      "https://new.example/v1",
      catalogPath,
    );
    const upgraded = await readFile(configPath, "utf8");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.match(upgraded, /base_url = "https:\/\/new\.example\/v1"/);
    assert.doesNotMatch(upgraded, /old\.example/);
    assert.equal(state.original, original);
    assert.equal(state.baseUrl, "https://new.example/v1");
    await uninstallInfiniteCodexConfig(statePath);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back the Codex config when an Infinite upgrade cannot commit state", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-upgrade-rollback-"));
  const configDirectory = join(directory, "config");
  const stateDirectory = join(directory, "state");
  const configPath = join(configDirectory, "config.toml");
  const statePath = join(stateDirectory, "install-state.json");
  const catalogPath = join(configDirectory, "models.json");
  await mkdir(configDirectory);
  await mkdir(stateDirectory);
  await writeFile(configPath, "");
  try {
    await installInfiniteCodexConfig(
      configPath,
      statePath,
      "https://old.example/v1",
      catalogPath,
    );
    const installed = await readFile(configPath, "utf8");
    await chmod(stateDirectory, 0o500);
    await assert.rejects(
      () => installInfiniteCodexConfig(
        configPath,
        statePath,
        "https://new.example/v1",
        catalogPath,
      ),
      /EACCES|permission denied/i,
    );
    assert.equal(await readFile(configPath, "utf8"), installed);
  } finally {
    await chmod(stateDirectory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to update Infinite after the managed Codex config changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-upgrade-conflict-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  await writeFile(configPath, "");
  try {
    await installInfiniteCodexConfig(
      configPath,
      statePath,
      "https://old.example/v1",
      catalogPath,
    );
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# user change\n`);
    await assert.rejects(
      () => upgradeInstalledInfiniteCodexConfig({
        path: configPath,
        statePath,
        baseUrl: "https://new.example/v1",
        modelCatalogPath: catalogPath,
      }),
      /changed after PromptRail Infinite installation/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves an Infinite model catalog changed by the user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-catalog-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  await writeFile(configPath, "");
  try {
    await installInfiniteCodexConfig(configPath, statePath);
    await writeFile(catalogPath, '{"user":"changed"}\n');
    await uninstallInfiniteCodexConfig(statePath);
    assert.equal(await readFile(catalogPath, "utf8"), '{"user":"changed"}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a pre-existing matching Infinite model catalog on uninstall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-owned-catalog-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  const catalog = `${JSON.stringify(INFINITE_MODEL_CATALOG, null, 2)}\n`;
  await writeFile(configPath, "");
  await writeFile(catalogPath, catalog);
  try {
    await installInfiniteCodexConfig(configPath, statePath, undefined, catalogPath);
    await uninstallInfiniteCodexConfig(statePath);
    assert.equal(await readFile(catalogPath, "utf8"), catalog);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Infinite Codex status verifies the managed config and catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-status-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  await writeFile(configPath, "");
  try {
    await installInfiniteCodexConfig(configPath, statePath, undefined, catalogPath);
    assert.equal((await infiniteCodexStatus(statePath)).configured, true);
    await writeFile(catalogPath, '{"modified":true}\n');
    assert.deepEqual(
      await infiniteCodexStatus(statePath),
      { configured: false, reason: "catalog_modified", statePath },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
