import assert from "node:assert/strict";
import test from "node:test";

import {
  linuxServiceDefinition,
  macServiceDefinition,
} from "../../lib/claude-user-service.mjs";

const values = {
  nodePath: "/opt/node/bin/node",
  proxyPath: "/home/user/PromptRail Claude Router/proxy.mjs",
  logPath: "/home/user/.claude/promptrail-router/proxy.log",
  configPath: "/home/user/.claude/promptrail-router/config.json",
};

test("launchd starts only the installed Claude proxy", () => {
  const definition = macServiceDefinition(values);
  assert.match(definition, /ai\.promptrail\.claude-router/);
  assert.match(definition, /RunAtLoad/);
  assert.match(definition, /KeepAlive/);
  assert.match(definition, /PromptRail Claude Router\/proxy\.mjs/);
  assert.match(definition, /PROMPTRAIL_CLAUDE_ROUTER_CONFIG/);
  assert.doesNotMatch(definition, /routerToken|Authorization/);
});

test("systemd restarts only the installed Claude proxy", () => {
  const definition = linuxServiceDefinition(values);
  assert.match(
    definition,
    /ExecStart="\/opt\/node\/bin\/node" "\/home\/user\/PromptRail Claude Router\/proxy\.mjs"/,
  );
  assert.match(definition, /Restart=on-failure/);
  assert.match(definition, /PROMPTRAIL_CLAUDE_ROUTER_CONFIG=/);
  assert.doesNotMatch(definition, /routerToken|Authorization/);
});
