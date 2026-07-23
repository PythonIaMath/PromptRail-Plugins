import assert from "node:assert/strict";
import test from "node:test";

import { matchingProxyPids } from "../lib/detached-proxy-process.mjs";

test("finds only proxy processes owned by the requested PromptRail plugin", () => {
  const output = `
  101 /usr/bin/node /home/user/.codex/plugins/cache/promptrail/promptrail-codex-router/0.1.0+codex.1/src/proxy.mjs
  102 /usr/bin/node /home/user/.claude/plugins/cache/promptrail/promptrail-claude-router/0.1.0/src/proxy.mjs
  103 grep promptrail-codex-router/0.1.0/src/proxy.mjs
  104 /usr/bin/node /tmp/unrelated/src/proxy.mjs
`;
  assert.deepEqual(matchingProxyPids(output, "promptrail-codex-router", 999), [101]);
  assert.deepEqual(matchingProxyPids(output, "promptrail-claude-router", 999), [102]);
});

test("never returns the current process", () => {
  const output = "  101 /usr/bin/node /tmp/promptrail-codex-router/dev/src/proxy.mjs\n";
  assert.deepEqual(matchingProxyPids(output, "promptrail-codex-router", 101), []);
});
