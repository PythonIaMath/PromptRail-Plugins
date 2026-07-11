import assert from "node:assert/strict";
import test from "node:test";

import {
  linuxServiceDefinition,
  macServiceDefinition,
} from "../../lib/codex-user-service.mjs";

const values = {
  nodePath: "/opt/node/bin/node",
  proxyPath: "/home/user/PromptRail Router/proxy.mjs",
  logPath: "/home/user/.codex/promptrail-router/proxy.log",
  configPath: "/home/user/.codex/promptrail-router/config.json",
};

test("launchd service starts the exact installed proxy before Codex", () => {
  const definition = macServiceDefinition(values);
  assert.match(definition, /ai\.promptrail\.codex-router/);
  assert.match(definition, /RunAtLoad/);
  assert.match(definition, /KeepAlive/);
  assert.match(definition, /PromptRail Router\/proxy\.mjs/);
  assert.doesNotMatch(definition, /routerToken|Authorization/);
});

test("systemd service restarts only the installed proxy process", () => {
  const definition = linuxServiceDefinition(values);
  assert.match(
    definition,
    /ExecStart="\/opt\/node\/bin\/node" "\/home\/user\/PromptRail Router\/proxy\.mjs"/,
  );
  assert.match(definition, /Restart=on-failure/);
  assert.match(definition, /PROMPTRAIL_ROUTER_CONFIG=/);
  assert.doesNotMatch(definition, /routerToken|Authorization/);
});
