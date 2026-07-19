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

test("exposes the selected route as hook context without an assistant instruction", async () => {
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
      grade: 3,
      effort: "medium",
      model: "gpt-5.6-terra",
    });
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
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Model_Selected: gpt-5.6-terra | Thinking_Level: medium",
      },
    });
    assert.deepEqual(routeRequest, {
      authorization: "Bearer router-secret",
      body: {
        prompt: "Review this queue design.",
        model: "gpt-5.6-sol",
        previous_user_prompt: "No previous user prompt; this is the first turn.",
        previous_assistant_summary: "No previous assistant response; this is the first turn.",
      },
    });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses the previous turn from the Codex transcript for the visible route", async () => {
  let routeRequest;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    routeRequest = JSON.parse(body);
    const payload = JSON.stringify({
      grade: 5,
      effort: "xhigh",
      model: "gpt-5.6-sol",
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  });
  const port = await listen(server);
  const directory = await mkdtemp(join(tmpdir(), "promptrail-hook-transcript-"));
  const configPath = join(directory, "config.json");
  const transcriptPath = join(directory, "session.jsonl");
  await writeFile(
    configPath,
    JSON.stringify({
      graderUrl: "https://grader.test/grade",
      routerToken: "router-secret",
      host: "127.0.0.1",
      port,
    }),
  );
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Fix the race condition in the cache worker." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Found unsafe shared mutation; implement synchronization and test it." }],
        },
      }),
    ].join("\n"),
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
        prompt: "Do it.",
        model: "gpt-5.6-sol",
        transcript_path: transcriptPath,
      }),
    );
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 0);
    assert.equal(await stderrPromise, "");
    assert.deepEqual(JSON.parse(await stdoutPromise), {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Model_Selected: gpt-5.6-sol | Thinking_Level: xhigh",
      },
    });
    assert.deepEqual(routeRequest, {
      prompt: "Do it.",
      model: "gpt-5.6-sol",
      previous_user_prompt: "Fix the race condition in the cache worker.",
      previous_assistant_summary:
        "Found unsafe shared mutation; implement synchronization and test it.",
    });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});
