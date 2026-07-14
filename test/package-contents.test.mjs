import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("published package contains both plugin marketplace manifests", () => {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const [pack] = JSON.parse(result.stdout);
  const files = new Set(pack.files.map((file) => file.path));

  assert.ok(files.has(".agents/plugins/marketplace.json"));
  assert.ok(files.has(".claude-plugin/marketplace.json"));
  assert.ok(files.has("plugins/promptrail-codex-router/.codex-plugin/plugin.json"));
  assert.ok(files.has("plugins/promptrail-claude-router/.claude-plugin/plugin.json"));
});
