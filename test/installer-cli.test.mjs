import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GRADER_URLS,
  DEFAULT_MARKETPLACE_SOURCE,
  configuredToken,
  parseCliArgs,
  runCli,
} from "../lib/installer-cli.mjs";

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value() { return value; },
  };
}

test("defaults every top-level install invocation to both clients", () => {
  assert.deepEqual(parseCliArgs([]), { command: "install", mode: "plugins", target: "both", options: {} });
  assert.deepEqual(parseCliArgs(["install"]), { command: "install", mode: "plugins", target: "both", options: {} });
  assert.deepEqual(parseCliArgs(["install", "both"]), {
    command: "install",
    mode: "plugins",
    target: "both",
    options: {},
  });
});

test("parses explicit Infinite installs and safe mode switches", () => {
  assert.deepEqual(parseCliArgs(["install", "infinite", "both"]), {
    command: "install",
    mode: "infinite",
    target: "both",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["switch", "infinite"]), {
    command: "switch",
    mode: "infinite",
    target: "both",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["switch", "infinite", "codex"]), {
    command: "switch",
    mode: "infinite",
    target: "codex",
    options: {},
  });
  assert.throws(() => parseCliArgs(["switch", "both"]), /Switch requires a mode/);
});

test("rejects unknown targets and options instead of guessing", () => {
  assert.throws(() => parseCliArgs(["install", "cursor"]), /codex, claude, or both/);
  assert.throws(() => parseCliArgs(["install", "codex"]), /Install both clients/);
  assert.throws(() => parseCliArgs(["install", "both", "--quiet"]), /Unsupported option/);
});

test("prefers the dedicated access-token environment variable", () => {
  assert.equal(
    configuredToken({}, {
      PROMPTRAIL_ACCESS_TOKEN: "access-token",
      PROMPTRAIL_ROUTER_TOKEN: "legacy-token",
    }),
    "access-token",
  );
  assert.equal(configuredToken({}, { PROMPTRAIL_API_KEY: "infinite-only" }), "");
});

test("passes secrets through child environment, never command arguments", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["install", "both"],
    env: {
      PROMPTRAIL_ACCESS_TOKEN: "router-secret",
      PROMPTRAIL_API_KEY: "infinite-secret-that-must-stay-isolated",
      PROMPTRAIL_INFINITE_BASE_URL: "https://infinite.example/v1",
    },
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, process.execPath);
  assert.match(calls[0].args[0], /promptrail-codex-router\.mjs$/);
  assert.match(calls[1].args[0], /promptrail-claude-router\.mjs$/);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(1), ["install"]);
    assert.doesNotMatch(call.args.join(" "), /router-secret/);
    assert.equal(call.options.env.PROMPTRAIL_ROUTER_TOKEN, "router-secret");
    assert.equal(call.options.env.PROMPTRAIL_API_KEY, undefined);
    assert.equal(call.options.env.PROMPTRAIL_INFINITE_BASE_URL, undefined);
  }
  assert.equal(calls[0].options.env.PROMPTRAIL_GRADER_URL, DEFAULT_GRADER_URLS.codex);
  assert.equal(calls[0].options.env.PROMPTRAIL_OPTIONAL_CLIENT, "1");
  assert.equal(calls[1].options.env.PROMPTRAIL_OPTIONAL_CLIENT, "1");
  assert.equal(
    calls[0].options.env.PROMPTRAIL_MARKETPLACE_SOURCE,
    DEFAULT_MARKETPLACE_SOURCE,
  );
});

test("prints help without starting a child installer", async () => {
  const output = outputBuffer();
  let spawned = false;
  const status = await runCli({
    argv: ["--help"],
    env: {},
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn() {
      spawned = true;
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(spawned, false);
  assert.match(output.value(), /promptrail install \[plugins\] both/);
});

test("installs both client routers with one shared token", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["install", "both"],
    env: { PROMPTRAIL_ACCESS_TOKEN: "router-secret" },
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].args[0], /promptrail-codex-router\.mjs$/);
  assert.match(calls[1].args[0], /promptrail-claude-router\.mjs$/);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(1), ["install"]);
    assert.equal(call.options.env.PROMPTRAIL_ROUTER_TOKEN, "router-secret");
  }
  assert.equal(calls[0].options.env.PROMPTRAIL_GRADER_URL, DEFAULT_GRADER_URLS.codex);
  assert.equal(calls[1].options.env.PROMPTRAIL_GRADER_URL, DEFAULT_GRADER_URLS.claude);
});

test("installs Infinite without passing its API key to child commands or local proxies", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["install", "infinite", "both"],
    env: {
      PROMPTRAIL_API_KEY: "infinite-secret",
      PROMPTRAIL_ACCESS_TOKEN: "plugins-secret-that-must-stay-isolated",
      PROMPTRAIL_ROUTER_TOKEN: "legacy-plugins-secret",
      PROMPTRAIL_GRADER_URL: "https://plugins-router.example",
    },
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].args[0], /promptrail-infinite-codex\.mjs$/);
  assert.match(calls[1].args[0], /promptrail-infinite-claude\.mjs$/);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(1), ["install"]);
    assert.equal(call.options.env.PROMPTRAIL_ROUTER_TOKEN, undefined);
    assert.equal(call.options.env.PROMPTRAIL_ACCESS_TOKEN, undefined);
    assert.equal(call.options.env.PROMPTRAIL_GRADER_URL, undefined);
    assert.doesNotMatch(call.args.join(" "), /infinite-secret/);
  }
});

test("switches by uninstalling the previous mode before installing the selected mode", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["switch", "infinite"],
    env: {},
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((call) => call.args.slice(1)), [
    ["uninstall", "--switch-if-installed"],
    ["uninstall", "--switch-if-installed"],
    ["install"],
    ["install"],
  ]);
  assert.match(calls[0].args[0], /promptrail-codex-router\.mjs$/);
  assert.match(calls[2].args[0], /promptrail-infinite-codex\.mjs$/);
});

test("switches only the explicitly requested client", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["switch", "infinite", "codex"],
    env: {},
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((call) => call.args.slice(1)), [
    ["uninstall", "--switch-if-installed"],
    ["install"],
  ]);
  assert.match(calls[0].args[0], /promptrail-codex-router\.mjs$/);
  assert.match(calls[1].args[0], /promptrail-infinite-codex\.mjs$/);
});
