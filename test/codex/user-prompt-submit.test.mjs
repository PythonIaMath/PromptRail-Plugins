import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = fileURLToPath(
  new URL("../../plugins/promptrail-codex-router/scripts/user-prompt-submit.mjs", import.meta.url),
);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readStream(stream) {
  let output = "";
  for await (const chunk of stream) {
    output += chunk;
  }
  return output;
}

test("displays only the selected thinking level for UserPromptSubmit", async () => {
  let routeRequest;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    routeRequest = {
      authorization: request.headers.authorization,
      body: JSON.parse(body),
    };
    const payload = JSON.stringify({ grade: 3, effort: "medium" });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
  const port = await listen(server);
  const directory = await mkdtemp(join(tmpdir(), "promptrail-hook-"));
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      graderUrl: "https://grader.test/grade",
      routerToken: "router-secret",
      host: "127.0.0.1",
      port,
    }),
  );

  try {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, PROMPTRAIL_ROUTER_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "Review this queue design.",
        model: "gpt-5.6-sol",
      }),
    );
    const [exitCode] = await once(child, "close");
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      systemMessage: "Thinking Level: Medium",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          'Begin your next user-visible message with exactly "Thinking Level: Medium" on its own line, before any other text. Do not add other wording to that line.',
      },
    });
    assert.deepEqual(routeRequest, {
      authorization: "Bearer router-secret",
      body: {
        prompt: "Review this queue design.",
        model: "gpt-5.6-sol",
      },
    });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
