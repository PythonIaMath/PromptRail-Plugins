import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installClaudeSettings,
  patchClaudeSettings,
  uninstallClaudeSettings,
} from "../../lib/claude-settings.mjs";

const CLEAN_ENVIRONMENT = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
};

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

test("refuses to overwrite settings changed after installation", async () => {
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
    await writeFile(settingsPath, "{\"userChanged\":true}\n");
    await assert.rejects(
      uninstallClaudeSettings(statePath),
      /settings changed after PromptRail installation/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
