import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import test from "node:test";

import { join } from "node:path";

import {
  buildInfiniteModelCatalog,
  codexConfigPath,
  DEFAULT_INFINITE_BASE_URL,
  installCodexConfig,
  installInfiniteCodexConfig as installInfiniteCodexConfigWithToken,
  infiniteCodexStatus,
  infiniteBaseUrl,
  infiniteInstallStatePath,
  INFINITE_MODEL_CATALOG,
  infiniteModelCatalogPath,
  installStatePath,
  patchCodexConfig,
  patchInfiniteCodexConfig,
  resolveInfiniteInstallStatePath,
  sha256,
  uninstallCodexConfig,
  uninstallInfiniteCodexConfig,
  unpatchCodexConfig,
  unpatchInfiniteCodexConfig,
  upgradeInstalledInfiniteCodexConfig as upgradeInstalledInfiniteCodexConfigWithToken,
} from "../../lib/codex-config.mjs";

const TEST_INFINITE_TOKEN = "pr_test_infinite_token";

async function installInfiniteCodexConfig(...args) {
  args[5] ??= TEST_INFINITE_TOKEN;
  return installInfiniteCodexConfigWithToken(...args);
}

async function upgradeInstalledInfiniteCodexConfig(options = {}) {
  return upgradeInstalledInfiniteCodexConfigWithToken({
    ...options,
    apiKey: options.apiKey || TEST_INFINITE_TOKEN,
  });
}
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

test("custom Codex profiles ignore legacy Infinite state owned by another config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-codex-profile-"));
  const preferredStatePath = join(directory, "custom-install-state.json");
  const legacyStatePath = join(directory, "legacy-install-state.json");
  const customConfigPath = join(directory, "custom-config.toml");
  try {
    await writeFile(legacyStatePath, `${JSON.stringify({
      configPath: join(directory, "unrelated-config.toml"),
    })}\n`);
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedConfigPath: customConfigPath,
        enableLegacyFallback: true,
      }),
      preferredStatePath,
    );
    await writeFile(legacyStatePath, "{malformed");
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedConfigPath: customConfigPath,
        enableLegacyFallback: true,
      }),
      preferredStatePath,
    );
    await unlink(legacyStatePath);
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedConfigPath: customConfigPath,
        enableLegacyFallback: true,
      }),
      preferredStatePath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom Codex profiles reuse legacy Infinite state only when ownership matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-codex-legacy-"));
  const preferredStatePath = join(directory, "custom-install-state.json");
  const legacyStatePath = join(directory, "legacy-install-state.json");
  const customConfigPath = join(directory, "custom-config.toml");
  try {
    await writeFile(legacyStatePath, `${JSON.stringify({
      configPath: customConfigPath,
    })}\n`);
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedConfigPath: customConfigPath,
        enableLegacyFallback: true,
      }),
      legacyStatePath,
    );
  } finally {
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
  assert.match(patched, /^model = "gpt-5.6-sol"/m);
  assert.match(patched, /\[model_providers\.promptrail-infinite\]/);
  assert.ok(patched.includes(`base_url = ${JSON.stringify(DEFAULT_INFINITE_BASE_URL)}`));
  assert.match(patched, /env_key = "PROMPTRAIL_API_KEY"/);
  assert.doesNotMatch(patched, /\[model_providers\.promptrail-infinite\.auth\]/);
  assert.match(patched, /requires_openai_auth = false/);
  assert.match(patched, /wire_api = "responses"/);
  assert.doesNotMatch(patched, /model_catalog_json/);
  assert.doesNotMatch(patched, /127\.0\.0\.1/);
});

test("hides free actors and builds strict picker entries for connected OpenAI models", () => {
  const catalog = buildInfiniteModelCatalog([
    {
      id: "promptrail/infinite",
      object: "model",
    },
    {
      id: "promptrail/direct-openrouter-cohere--north-mini-code",
      object: "model",
      routing_mode: "direct-free-v1",
      display_name: "openrouter · cohere/north-mini-code",
      description: "Direct actor with no semantic fallback.",
      context_window: 64_000,
      max_output_tokens: 8_192,
      capabilities: {
        tool_calling: true,
        vision: false,
        reasoning: true,
        streaming: true,
      },
    },
    {
      id: "gpt-5.6-sol",
      object: "model",
      owned_by: "openai",
      routing_mode: "subscription-direct-v1",
      display_name: "GPT-5.6 Sol",
      description: "Use this model through your connected OpenAI subscription.",
      context_window: 128_000,
      max_output_tokens: 32_768,
      capabilities: {
        tool_calling: true,
        vision: true,
        reasoning: true,
        streaming: true,
      },
    },
  ]);

  assert.equal(catalog.models.length, 2);
  const subscription = catalog.models[1];
  assert.equal(subscription.slug, "gpt-5.6-sol");
  assert.equal(subscription.display_name, "GPT-5.6 Sol");
  assert.doesNotMatch(JSON.stringify(catalog), /promptrail\/direct-|openrouter|north-mini/i);
  assert.equal(subscription.context_window, 128_000);
  assert.equal(subscription.max_context_window, 128_000);
  assert.deepEqual(subscription.input_modalities, ["text", "image"]);
  assert.equal(subscription.visibility, "list");
  assert.equal(subscription.supported_in_api, true);
  assert.equal(subscription.priority, 1);
});

test("rejects untrusted subscription model records before writing the Codex catalog", () => {
  const base = {
    object: "model",
    owned_by: "openai",
    routing_mode: "subscription-direct-v1",
    display_name: "GPT model",
    description: "Connected OpenAI subscription model.",
    context_window: 64_000,
    max_output_tokens: 8_192,
    capabilities: { tool_calling: true, streaming: true },
  };
  assert.throws(
    () => buildInfiniteModelCatalog([{ ...base, id: "provider/gpt-5.6-sol" }]),
    /subscription model id is invalid/,
  );
  assert.throws(
    () => buildInfiniteModelCatalog([{
      ...base,
      id: "gpt-text-only",
      capabilities: { tool_calling: false, streaming: true },
    }]),
    /not coding-harness compatible/,
  );
  assert.throws(
    () => buildInfiniteModelCatalog([{
      ...base,
      id: "gpt-header-injection",
      display_name: "bad\nname",
    }]),
    /display name is invalid/,
  );
  assert.throws(
    () => buildInfiniteModelCatalog([{
      ...base,
      id: "gpt-terminal-injection",
      display_name: "bad\u001b[31mname",
    }]),
    /display name is invalid/,
  );
});

test("refreshes an unmodified managed Infinite catalog and keeps uninstall safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-refresh-models-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  const original = 'model = "gpt-5.6-sol"\n';
  const dynamicCatalog = buildInfiniteModelCatalog([{
    id: "gpt-5.6-terra",
    object: "model",
    owned_by: "openai",
    routing_mode: "subscription-direct-v1",
    display_name: "GPT-5.6 Terra",
    description: "Connected OpenAI subscription model.",
    context_window: 128_000,
    max_output_tokens: 32_768,
    capabilities: { tool_calling: true, streaming: true, reasoning: false },
  }]);
  await writeFile(configPath, original);
  try {
    await installInfiniteCodexConfig(
      configPath,
      statePath,
      "https://gateway.example/v1",
      catalogPath,
    );
    await installInfiniteCodexConfig(
      configPath,
      statePath,
      "https://gateway.example/v1",
      catalogPath,
      dynamicCatalog,
    );

    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(
      catalog.models.map((model) => model.slug),
      ["promptrail/infinite", "gpt-5.6-terra"],
    );
    assert.equal(state.modelCatalogSha256, sha256(`${JSON.stringify(dynamicCatalog, null, 2)}\n`));
    await uninstallInfiniteCodexConfig(statePath);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(readFile(catalogPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires HTTPS for every Infinite endpoint", () => {
  assert.equal(infiniteBaseUrl("https://api.promptrail.ai/v1/"), "https://api.promptrail.ai/v1");
  assert.throws(() => infiniteBaseUrl("http://127.0.0.1:8787/v1"), /HTTPS/);
  assert.throws(() => infiniteBaseUrl("file:///tmp/service"), /HTTPS/);
  assert.throws(() => infiniteBaseUrl("https://user:secret@example.test"), /without credentials/);
  assert.throws(() => infiniteBaseUrl("https://example.test/v1?token=secret"), /query/);
  assert.throws(() => infiniteBaseUrl("https://example.test/v1#fragment"), /fragment/);
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
  const tokenPath = join(directory, "api-token");
  const helperPath = join(directory, "api-key-helper.sh");
  const original = 'model_provider = "openai"\n';
  await writeFile(configPath, original);
  try {
    await installInfiniteCodexConfig(configPath, statePath);
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(catalog.models[0].slug, "promptrail/infinite");
    assert.equal(catalog.models[0].context_window, 128_000);
    assert.deepEqual(catalog.models[0].input_modalities, ["text"]);
    assert.equal((await stat(catalogPath)).mode & 0o777, 0o600);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal((await stat(helperPath)).mode & 0o777, 0o700);
    assert.equal(await readFile(tokenPath, "utf8"), `${TEST_INFINITE_TOKEN}\n`);
    const helperResult = spawnSync(helperPath, [], {
      encoding: "utf8",
      env: { ...process.env, PROMPTRAIL_API_KEY: "wrong-environment-key" },
    });
    assert.equal(helperResult.status, 0, helperResult.stderr);
    assert.equal(helperResult.stdout, `${TEST_INFINITE_TOKEN}\n`);
    const launched = spawnSync(
      helperPath,
      [
        process.execPath,
        "-e",
        'process.exit(process.env.PROMPTRAIL_API_KEY === "pr_test_infinite_token" ? 0 : 1)',
      ],
      { encoding: "utf8", env: { ...process.env, PROMPTRAIL_API_KEY: "wrong-environment-key" } },
    );
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout, "");
    for (const publicArtifact of [configPath, statePath, helperPath]) {
      assert.doesNotMatch(await readFile(publicArtifact, "utf8"), new RegExp(TEST_INFINITE_TOKEN));
    }
    await uninstallInfiniteCodexConfig(statePath);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(() => readFile(catalogPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(tokenPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(helperPath, "utf8"), { code: "ENOENT" });
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

test("upgrades Infinite while preserving Codex additions outside managed settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-upgrade-user-config-"));
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
    const installed = await readFile(configPath, "utf8");
    await writeFile(configPath, installed.replace(
      "# <<< promptrail-infinite provider <<<",
      `[projects."${directory}"]\ntrust_level = "trusted"\n# <<< promptrail-infinite provider <<<`,
    ));

    await upgradeInstalledInfiniteCodexConfig({
      path: configPath,
      statePath,
      baseUrl: "https://new.example/v1",
      modelCatalogPath: catalogPath,
    });

    const upgraded = await readFile(configPath, "utf8");
    assert.match(upgraded, /base_url = "https:\/\/new\.example\/v1"/);
    assert.match(
      upgraded,
      /http_headers = \{ "X-PromptRail-Diagnostics" = "executed-model" \}/,
    );
    assert.match(upgraded, new RegExp(`\\[projects\\."${directory.replaceAll("/", "\\/")}"\\]`));
    await uninstallInfiniteCodexConfig(statePath);
    const restored = await readFile(configPath, "utf8");
    assert.match(restored, new RegExp(`\\[projects\\."${directory.replaceAll("/", "\\/")}"\\]`));
    assert.match(restored, /trust_level = "trusted"/);
    assert.doesNotMatch(restored, /model_providers\.promptrail-infinite|managed by promptrail-infinite/);
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
    await chmod(configDirectory, 0o500);
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
    await chmod(configDirectory, 0o700).catch(() => {});
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
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        'base_url = "https://old.example/v1"',
        'base_url = "https://user-changed.example/v1"',
      ),
    );
    await assert.rejects(
      () => upgradeInstalledInfiniteCodexConfig({
        path: configPath,
        statePath,
        baseUrl: "https://new.example/v1",
        modelCatalogPath: catalogPath,
      }),
      /PromptRail-managed Infinite settings changed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to restore a diagnostics header removed from a current Infinite install", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-diagnostics-conflict-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  await writeFile(configPath, "");
  try {
    await installInfiniteCodexConfig(configPath, statePath, undefined, catalogPath);
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        'http_headers = { "X-PromptRail-Diagnostics" = "executed-model" }\n',
        "",
      ),
    );
    await assert.rejects(
      () => upgradeInstalledInfiniteCodexConfig({
        path: configPath,
        statePath,
        modelCatalogPath: catalogPath,
      }),
      /PromptRail-managed Infinite settings changed/,
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
    assert.equal((await infiniteCodexStatus(statePath)).configured, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Infinite Codex status rejects an exposed token file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-token-mode-"));
  const configPath = join(directory, "config.toml");
  const statePath = join(directory, "install-state.json");
  const catalogPath = join(directory, "models.json");
  const tokenPath = join(directory, "api-token");
  await writeFile(configPath, "");
  try {
    await installInfiniteCodexConfig(configPath, statePath, undefined, catalogPath);
    await chmod(tokenPath, 0o644);
    assert.deepEqual(
      await infiniteCodexStatus(statePath),
      { configured: false, reason: "token_modified", statePath },
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
