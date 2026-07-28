import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  installClaudeSettings,
  installInfiniteClaudeSettings as installInfiniteClaudeSettingsWithToken,
  infiniteClaudeStatus,
  infiniteClaudeBaseUrl,
  patchClaudeSettings,
  patchInfiniteClaudeSettings,
  resolveInfiniteInstallStatePath,
  uninstallClaudeSettings,
  uninstallInfiniteClaudeSettings,
} from "../../lib/claude-settings.mjs";

const TEST_INFINITE_TOKEN = "pr_test_infinite_token";

async function installInfiniteClaudeSettings(options = {}) {
  return installInfiniteClaudeSettingsWithToken({
    ...options,
    apiKey: options.apiKey || TEST_INFINITE_TOKEN,
  });
}

const CLEAN_ENVIRONMENT = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
};
const INFINITE_CLAUDE_BIN = fileURLToPath(
  new URL("../../bin/promptrail-infinite-claude.mjs", import.meta.url),
);

test("adds only the local gateway URL to Claude settings", () => {
  const patched = JSON.parse(patchClaudeSettings(
    JSON.stringify({ theme: "dark", env: { KEEP_ME: "yes" } }),
    "http://127.0.0.1:8788",
    CLEAN_ENVIRONMENT,
  ));
  assert.equal(patched.theme, "dark");
  assert.equal(patched.env.KEEP_ME, "yes");
  assert.equal(patched.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8788");
  assert.equal(patched.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(patched.env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("refuses API credentials and existing gateways", () => {
  assert.throws(
    () => patchClaudeSettings(
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "secret" } }),
      "http://127.0.0.1:8788",
      CLEAN_ENVIRONMENT,
    ),
    /API credential configuration is active/,
  );
  assert.throws(
    () => patchClaudeSettings(
      JSON.stringify({ apiKeyHelper: "/bin/key" }),
      "http://127.0.0.1:8788",
      CLEAN_ENVIRONMENT,
    ),
    /apiKeyHelper/,
  );
  assert.throws(
    () => patchClaudeSettings(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
      "http://127.0.0.1:8788",
      CLEAN_ENVIRONMENT,
    ),
    /refusing to replace/,
  );
});

test("generates an Infinite Claude configuration without storing a PromptRail key", () => {
  const patched = JSON.parse(patchInfiniteClaudeSettings(
    JSON.stringify({ theme: "dark", env: { KEEP_ME: "yes" } }),
    undefined,
    undefined,
    CLEAN_ENVIRONMENT,
  ));
  assert.equal(patched.theme, "dark");
  assert.equal(patched.env.KEEP_ME, "yes");
  assert.equal(
    patched.env.ANTHROPIC_BASE_URL,
    "https://promptrail--promptrail-infinite-beta-gateway-server.us-west.modal.direct",
  );
  assert.equal(patched.env.ANTHROPIC_MODEL, "promptrail/infinite");
  assert.equal(patched.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(
    patched.env.ANTHROPIC_CUSTOM_HEADERS,
    "X-PromptRail-Diagnostics: executed-model",
  );
  assert.match(patched.apiKeyHelper, /api-key-helper\.sh/);
  assert.doesNotMatch(JSON.stringify(patched), /PROMPTRAIL_API_KEY|infinite-secret/);
});

test("preserves unrelated Claude custom headers while enabling actor diagnostics", () => {
  const patched = JSON.parse(patchInfiniteClaudeSettings(
    JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: "X-Trace: enabled" } }),
    undefined,
    undefined,
    CLEAN_ENVIRONMENT,
  ));

  assert.equal(
    patched.env.ANTHROPIC_CUSTOM_HEADERS,
    "X-Trace: enabled\nX-PromptRail-Diagnostics: executed-model",
  );
  assert.throws(
    () => patchInfiniteClaudeSettings(
      JSON.stringify({
        env: { ANTHROPIC_CUSTOM_HEADERS: "X-PromptRail-Diagnostics: another-mode" },
      }),
      undefined,
      undefined,
      CLEAN_ENVIRONMENT,
    ),
    /refusing to replace/,
  );
});

test("normalizes the shared Modal endpoint for Claude's Anthropic paths", () => {
  assert.equal(
    infiniteClaudeBaseUrl("https://gateway.example/v1/"),
    "https://gateway.example",
  );
  assert.throws(
    () => infiniteClaudeBaseUrl("https://user:secret@gateway.example/v1"),
    /without credentials/,
  );
  assert.throws(
    () => infiniteClaudeBaseUrl("https://gateway.example/v1?token=secret"),
    /query/,
  );
  assert.throws(
    () => infiniteClaudeBaseUrl("https://gateway.example/v1#fragment"),
    /fragment/,
  );
  assert.throws(
    () => infiniteClaudeBaseUrl("http://127.0.0.1:8787/v1"),
    /HTTPS/,
  );
});

test("refuses to replace an unrelated Claude model or gateway for Infinite", () => {
  assert.throws(
    () => patchInfiniteClaudeSettings(
      JSON.stringify({ env: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "0" } }),
      undefined,
      undefined,
      CLEAN_ENVIRONMENT,
    ),
    /explicitly disabled/,
  );
  assert.throws(
    () => patchInfiniteClaudeSettings(
      JSON.stringify({ env: { ANTHROPIC_MODEL: "other" } }),
      undefined,
      undefined,
      CLEAN_ENVIRONMENT,
    ),
    /ANTHROPIC_MODEL is already configured/,
  );
  assert.throws(
    () => patchInfiniteClaudeSettings(
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://other" } }),
      undefined,
      undefined,
      CLEAN_ENVIRONMENT,
    ),
    /ANTHROPIC_BASE_URL is already configured/,
  );
  assert.throws(
    () => patchInfiniteClaudeSettings(
      JSON.stringify({ apiKeyHelper: "/unrelated/key-helper" }),
      undefined,
      undefined,
      CLEAN_ENVIRONMENT,
    ),
    /apiKeyHelper is already configured/,
  );
  assert.throws(
    () => patchInfiniteClaudeSettings(
      "{}",
      undefined,
      undefined,
      { ...CLEAN_ENVIRONMENT, ANTHROPIC_AUTH_TOKEN: "unrelated" },
    ),
    /would override PromptRail/,
  );
});

test("restores the original Claude settings when Infinite is uninstalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  const helperPath = join(directory, "api-key-helper.sh");
  const tokenPath = join(directory, "api-token");
  const original = '{\n  "theme": "dark"\n}\n';
  await writeFile(settingsPath, original);
  try {
    await installInfiniteClaudeSettings({
      path: settingsPath,
      statePath,
      helperPath,
      environment: CLEAN_ENVIRONMENT,
    });
    const helperStat = await stat(helperPath);
    assert.equal(helperStat.mode & 0o777, 0o700);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(tokenPath, "utf8"), `${TEST_INFINITE_TOKEN}\n`);
    const helperResult = spawnSync(helperPath, [], {
      encoding: "utf8",
      env: { ...process.env, PROMPTRAIL_API_KEY: "wrong-environment-key" },
    });
    assert.equal(helperResult.status, 0, helperResult.stderr);
    assert.equal(helperResult.stdout, `${TEST_INFINITE_TOKEN}\n`);
    assert.doesNotMatch(await readFile(settingsPath, "utf8"), /pr_test_infinite_token|PROMPTRAIL_API_KEY/);
    await uninstallInfiniteClaudeSettings(statePath);
    assert.equal(await readFile(settingsPath, "utf8"), original);
    await assert.rejects(readFile(helperPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(tokenPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a user-modified Infinite key helper during uninstall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-helper-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  const helperPath = join(directory, "api-key-helper.sh");
  await writeFile(settingsPath, "{}\n");
  try {
    await installInfiniteClaudeSettings({
      path: settingsPath,
      statePath,
      helperPath,
      environment: CLEAN_ENVIRONMENT,
    });
    await writeFile(helperPath, "#!/bin/sh\nprintf custom\\n");
    await uninstallInfiniteClaudeSettings(statePath);
    assert.equal(await readFile(helperPath, "utf8"), "#!/bin/sh\nprintf custom\\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a user-modified token during uninstall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-token-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  const tokenPath = join(directory, "api-token");
  await writeFile(settingsPath, "{}\n");
  try {
    await installInfiniteClaudeSettings({
      path: settingsPath,
      statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    await writeFile(tokenPath, "user-replaced-token\n", { mode: 0o600 });
    await uninstallInfiniteClaudeSettings(statePath);
    assert.equal(await readFile(tokenPath, "utf8"), "user-replaced-token\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Infinite Claude status verifies settings and the key helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-status-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  const helperPath = join(directory, "api-key-helper.sh");
  await writeFile(settingsPath, "{}\n");
  try {
    await installInfiniteClaudeSettings({
      path: settingsPath,
      statePath,
      helperPath,
      environment: CLEAN_ENVIRONMENT,
    });
    assert.equal((await infiniteClaudeStatus(statePath)).configured, true);
    await writeFile(helperPath, "#!/bin/sh\nexit 1\n");
    assert.deepEqual(
      await infiniteClaudeStatus(statePath),
      { configured: false, reason: "helper_modified", statePath },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("upgrades an unchanged Infinite endpoint without losing original Claude settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-upgrade-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  const helperPath = join(directory, "api-key-helper.sh");
  const original = '{"theme":"dark"}\n';
  await writeFile(settingsPath, original);
  try {
    await installInfiniteClaudeSettings({
      baseUrl: "https://old.example/v1",
      path: settingsPath,
      statePath,
      helperPath,
      environment: CLEAN_ENVIRONMENT,
    });
    await installInfiniteClaudeSettings({
      baseUrl: "https://new.example/v1",
      path: settingsPath,
      statePath,
      helperPath,
      environment: CLEAN_ENVIRONMENT,
    });
    assert.equal(
      JSON.parse(await readFile(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL,
      "https://new.example",
    );
    await uninstallInfiniteClaudeSettings(statePath);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Infinite Claude CLI stores its token only in the user-only credential file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-cli-"));
  const infiniteHome = join(directory, "promptrail-infinite");
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: directory,
    PROMPTRAIL_INFINITE_CLAUDE_HOME: infiniteHome,
    PROMPTRAIL_INFINITE_BASE_URL: "https://gateway.example/v1",
    PROMPTRAIL_API_KEY: "test-cli-token",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
  try {
    const installed = spawnSync(process.execPath, [INFINITE_CLAUDE_BIN, "install"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(installed.status, 0, installed.stderr);
    const settings = await readFile(join(directory, "settings.json"), "utf8");
    assert.doesNotMatch(settings, /test-cli-token|PROMPTRAIL_API_KEY/);
    assert.equal(JSON.parse(settings).env.ANTHROPIC_BASE_URL, "https://gateway.example");
    assert.equal(
      await readFile(join(infiniteHome, "api-token"), "utf8"),
      "test-cli-token\n",
    );
    assert.doesNotMatch(
      await readFile(join(infiniteHome, "install-state.json"), "utf8"),
      /test-cli-token/,
    );

    const uninstalled = spawnSync(process.execPath, [INFINITE_CLAUDE_BIN, "uninstall"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(uninstalled.status, 0, uninstalled.stderr);
    await assert.rejects(readFile(join(infiniteHome, "api-key-helper.sh"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(join(infiniteHome, "api-token"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom Claude profiles ignore legacy Infinite state owned by another settings file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-profile-"));
  const preferredStatePath = join(directory, "custom-install-state.json");
  const legacyStatePath = join(directory, "legacy-install-state.json");
  const customSettingsPath = join(directory, "custom-settings.json");
  try {
    await writeFile(legacyStatePath, `${JSON.stringify({
      settingsPath: join(directory, "unrelated-settings.json"),
    })}\n`);
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedSettingsPath: customSettingsPath,
        enableLegacyFallback: true,
      }),
      preferredStatePath,
    );
    await writeFile(legacyStatePath, "{malformed");
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedSettingsPath: customSettingsPath,
        enableLegacyFallback: true,
      }),
      preferredStatePath,
    );
    await unlink(legacyStatePath);
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedSettingsPath: customSettingsPath,
        enableLegacyFallback: true,
      }),
      preferredStatePath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom Claude profiles reuse legacy Infinite state only when ownership matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-claude-legacy-"));
  const preferredStatePath = join(directory, "custom-install-state.json");
  const legacyStatePath = join(directory, "legacy-install-state.json");
  const customSettingsPath = join(directory, "custom-settings.json");
  try {
    await writeFile(legacyStatePath, `${JSON.stringify({
      settingsPath: customSettingsPath,
    })}\n`);
    assert.equal(
      await resolveInfiniteInstallStatePath(preferredStatePath, {
        legacyPath: legacyStatePath,
        expectedSettingsPath: customSettingsPath,
        enableLegacyFallback: true,
      }),
      legacyStatePath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores the exact original Claude settings on uninstall", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-settings-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  const original = "{\n  \"theme\": \"dark\"\n}\n";
  await writeFile(settingsPath, original);
  try {
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: settingsPath,
      statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    assert.match(await readFile(settingsPath, "utf8"), /ANTHROPIC_BASE_URL/);
    await uninstallClaudeSettings(statePath);
    assert.equal(await readFile(settingsPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves unrelated settings changed after installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-settings-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  await writeFile(settingsPath, "{}\n");
  try {
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: settingsPath,
      statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    await writeFile(settingsPath, `${JSON.stringify({
      userChanged: true,
      env: {
        KEEP_ME: "yes",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
      },
    }, null, 2)}\n`);
    await uninstallClaudeSettings(statePath);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      userChanged: true,
      env: { KEEP_ME: "yes" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a gateway changed by the user after installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-settings-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  await writeFile(settingsPath, "{}\n");
  try {
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: settingsPath,
      statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    await writeFile(settingsPath, `${JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
    }, null, 2)}\n`);
    await uninstallClaudeSettings(statePath);
    assert.equal(
      JSON.parse(await readFile(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL,
      "https://gateway.example",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy install state still removes the PromptRail gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-settings-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  await writeFile(settingsPath, "{}\n");
  try {
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: settingsPath,
      statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.baseUrl;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await writeFile(settingsPath, `${JSON.stringify({
      statusLine: { type: "command", command: "printf ready" },
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8788" },
    }, null, 2)}\n`);
    await uninstallClaudeSettings(statePath);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      statusLine: { type: "command", command: "printf ready" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats a missing Claude settings file as already restored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-settings-"));
  const settingsPath = join(directory, "settings.json");
  const statePath = join(directory, "install-state.json");
  await writeFile(settingsPath, "{}\n");
  try {
    await installClaudeSettings({
      baseUrl: "http://127.0.0.1:8788",
      path: settingsPath,
      statePath,
      environment: CLEAN_ENVIRONMENT,
    });
    await unlink(settingsPath);
    assert.equal(await uninstallClaudeSettings(statePath), settingsPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("treats uninstalling a missing Claude router as already uninstalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-missing-claude-"));
  try {
    assert.equal(await uninstallClaudeSettings(join(directory, "install-state.json")), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
