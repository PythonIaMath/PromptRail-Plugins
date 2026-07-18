import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOK_SCRIPT = fileURLToPath(
  new URL("../../plugins/promptrail-claude-router/scripts/user-prompt-submit.mjs", import.meta.url),
);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readStream(stream) {
  let output = "";
  for await (const chunk of stream) {
    output += chunk;
  }
  return output;
}

test("selects and displays the Claude thinking level for the submitted session", async () => {
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
    const payload = JSON.stringify({
      thinking_grade: 4,
      model: "claude-fable-5",
      effort: "xhigh",
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
  const port = await listen(server);
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-hook-"));
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
      env: { ...process.env, PROMPTRAIL_CLAUDE_ROUTER_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutPromise = readStream(child.stdout);
    const stderrPromise = readStream(child.stderr);
    child.stdin.end(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-123",
      prompt: "Audit this authorization boundary.",
    }));
    const [exitCode] = await once(child, "close");
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      systemMessage: "PromptRail: claude-fable-5 | Extra High",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "PromptRail selected claude-fable-5 with Extra High effort for this turn.",
      },
    });
    assert.deepEqual(routeRequest, {
      authorization: "Bearer router-secret",
      body: {
        sessionId: "session-123",
        prompt: "Audit this authorization boundary.",
      },
    });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks the prompt when route selection fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-claude-hook-"));
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      graderUrl: "https://grader.test/grade",
      routerToken: "router-secret",
      host: "127.0.0.1",
      port: 1,
    }),
  );
  try {
    const child = spawn(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, PROMPTRAIL_CLAUDE_ROUTER_CONFIG: configPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutPromise = readStream(child.stdout);
    child.stdin.end(JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-123",
      prompt: "Do the work.",
    }));
    await once(child, "close");
    const payload = JSON.parse(await stdoutPromise);
    assert.equal(payload.decision, "block");
    assert.match(payload.reason, /Thinking level selection failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
