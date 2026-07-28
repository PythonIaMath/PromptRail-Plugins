import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GRADER_URLS,
  DEFAULT_MARKETPLACE_SOURCE,
  configuredInfiniteToken,
  configuredToken,
  parseCliArgs,
  runCli as runCliWithPreflight,
} from "../lib/installer-cli.mjs";

async function runCli(options) {
  return runCliWithPreflight({
    ...options,
    preflightInfinite: options.preflightInfinite || (async () => []),
  });
}

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value() { return value; },
  };
}

test("defaults installs to Infinite while implicit status and uninstall inspect both modes", () => {
  assert.deepEqual(parseCliArgs([]), { command: "switch", mode: "infinite", target: "both", options: {} });
  assert.deepEqual(parseCliArgs(["install"]), { command: "install", mode: "infinite", target: "both", options: {} });
  assert.deepEqual(parseCliArgs(["install", "both"]), {
    command: "install",
    mode: "infinite",
    target: "both",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["status", "both"]), {
    command: "status",
    mode: "all",
    target: "both",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["uninstall", "both"]), {
    command: "uninstall",
    mode: "all",
    target: "both",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["install", "plugins", "both"]), {
    command: "install",
    mode: "plugins",
    target: "both",
    options: {},
  });
});

test("implicit status and uninstall cover Infinite and legacy Plugins installations", async () => {
  for (const command of ["status", "uninstall"]) {
    const calls = [];
    const output = outputBuffer();
    const status = await runCli({
      argv: [command, "both"],
      env: {},
      input: {},
      output: output.stream,
      errorOutput: output.stream,
      spawn(executable, args) {
        calls.push({ executable, args });
        return { status: 0 };
      },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 4);
    assert.match(calls[0].args[0], /promptrail-infinite-codex\.mjs$/);
    assert.match(calls[1].args[0], /promptrail-infinite-claude\.mjs$/);
    assert.match(calls[2].args[0], /promptrail-codex-router\.mjs$/);
    assert.match(calls[3].args[0], /promptrail-claude-router\.mjs$/);
    assert.deepEqual(calls.slice(0, 2).map((call) => call.args.slice(1)), [
      [command],
      [command],
    ]);
    assert.deepEqual(calls.slice(2).map((call) => call.args.slice(1)), [
      command === "uninstall" ? [command, "--switch-if-installed"] : [command],
      command === "uninstall" ? [command, "--switch-if-installed"] : [command],
    ]);
  }
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
  assert.deepEqual(parseCliArgs(["switch", "infinite", "--token", "secret"]), {
    command: "switch",
    mode: "infinite",
    target: "both",
    options: { token: "secret" },
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
  assert.equal(
    configuredInfiniteToken({}, {
      PROMPTRAIL_API_KEY: "infinite-token",
      PROMPTRAIL_ACCESS_TOKEN: "fallback-token",
    }),
    "infinite-token",
  );
  assert.equal(
    configuredInfiniteToken({}, { PROMPTRAIL_ACCESS_TOKEN: "shared-token" }),
    "shared-token",
  );
});

test("passes secrets through child environment, never command arguments", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["install", "plugins", "both"],
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
  assert.match(output.value(), /promptrail install \[infinite\] both/);
});

test("installs both client routers with one shared token", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["install", "plugins", "both"],
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

test("installs Infinite with its API key only in child environments", async () => {
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
    assert.equal(call.options.env.PROMPTRAIL_API_KEY, "infinite-secret");
    assert.doesNotMatch(call.args.join(" "), /infinite-secret/);
  }
});

test("preflights Infinite authentication before changing either client", async () => {
  let spawned = false;
  let preflight;
  const output = outputBuffer();
  const status = await runCli({
    argv: ["switch", "infinite", "--token", "one-time-secret"],
    env: { PROMPTRAIL_INFINITE_BASE_URL: "https://gateway.example/v1" },
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    async preflightInfinite(options) {
      preflight = options;
      return [];
    },
    spawn() {
      spawned = true;
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(spawned, true);
  assert.deepEqual(preflight, {
    baseUrl: "https://gateway.example/v1",
    apiKey: "one-time-secret",
  });
});

test("an invalid Infinite token cannot uninstall the current mode", async () => {
  let spawned = false;
  const output = outputBuffer();
  await assert.rejects(
    () => runCliWithPreflight({
      argv: ["switch", "infinite"],
      env: { PROMPTRAIL_API_KEY: "invalid-token" },
      input: {},
      output: output.stream,
      errorOutput: output.stream,
      async preflightInfinite() {
        throw new Error("PromptRail Infinite model discovery failed with HTTP 401.");
      },
      spawn() {
        spawned = true;
        return { status: 0 };
      },
    }),
    /HTTP 401/,
  );
  assert.equal(spawned, false);
});

test("switches by uninstalling the previous mode before installing the selected mode", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["switch", "infinite"],
    env: { PROMPTRAIL_API_KEY: "infinite-secret" },
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

test("the bare command safely migrates Plugins to Infinite", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: [],
    env: { PROMPTRAIL_API_KEY: "infinite-secret" },
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
  assert.match(calls[1].args[0], /promptrail-claude-router\.mjs$/);
  assert.match(calls[2].args[0], /promptrail-infinite-codex\.mjs$/);
  assert.match(calls[3].args[0], /promptrail-infinite-claude\.mjs$/);
});

test("the bare migration never installs Infinite after Plugins cleanup fails", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: [],
    env: { PROMPTRAIL_API_KEY: "infinite-secret" },
    input: {},
    output: output.stream,
    errorOutput: output.stream,
    spawn(command, args) {
      calls.push({ command, args });
      return { status: 17 };
    },
  });
  assert.equal(status, 17);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[0], /promptrail-codex-router\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ["uninstall", "--switch-if-installed"]);
  assert.match(output.value(), /uninstall failed for plugins codex/);
});

test("switches only the explicitly requested client", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["switch", "infinite", "codex"],
    env: { PROMPTRAIL_API_KEY: "infinite-secret" },
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
