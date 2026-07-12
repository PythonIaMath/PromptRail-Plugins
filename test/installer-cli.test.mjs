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

test("parses the one-command Codex installer syntax", () => {
  assert.deepEqual(parseCliArgs(["install", "codex"]), {
    command: "install",
    target: "codex",
    options: {},
  });
  assert.deepEqual(parseCliArgs(["install", "claude", "--token", "secret"]), {
    command: "install",
    target: "claude",
    options: { token: "secret" },
  });
});

test("rejects unknown targets and options instead of guessing", () => {
  assert.throws(() => parseCliArgs(["install", "cursor"]), /codex or claude/);
  assert.throws(() => parseCliArgs(["install", "codex", "--quiet"]), /Unsupported option/);
});

test("prefers the dedicated access-token environment variable", () => {
  assert.equal(
    configuredToken({}, {
      PROMPTRAIL_ACCESS_TOKEN: "access-token",
      PROMPTRAIL_ROUTER_TOKEN: "legacy-token",
    }),
    "access-token",
  );
});

test("passes secrets through child environment, never command arguments", async () => {
  const calls = [];
  const output = outputBuffer();
  const status = await runCli({
    argv: ["install", "codex"],
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.match(calls[0].args[0], /promptrail-codex-router\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ["install"]);
  assert.doesNotMatch(calls[0].args.join(" "), /router-secret/);
  assert.equal(calls[0].options.env.PROMPTRAIL_ROUTER_TOKEN, "router-secret");
  assert.equal(calls[0].options.env.PROMPTRAIL_GRADER_URL, DEFAULT_GRADER_URLS.codex);
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
  assert.match(output.value(), /promptrail install <codex\|claude>/);
});
