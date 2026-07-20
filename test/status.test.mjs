import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function runMissingConfig(script, envName) {
  const home = await mkdtemp(join(tmpdir(), "promptrail-status-"));
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, [envName]: join(home, "missing.json") },
  });
}

test("Codex status reports a missing install without failing", async () => {
  const result = await runMissingConfig(
    "plugins/promptrail-codex-router/scripts/status.mjs",
    "PROMPTRAIL_ROUTER_CONFIG",
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    configured: false,
    healthy: false,
    reason: "not_installed",
  });
});

test("Claude status reports a missing install without failing", async () => {
  const result = await runMissingConfig(
    "plugins/promptrail-claude-router/scripts/status.mjs",
    "PROMPTRAIL_CLAUDE_ROUTER_CONFIG",
  );
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    configured: false,
    healthy: false,
    reason: "not_installed",
  });
});
