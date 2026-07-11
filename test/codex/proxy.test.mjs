import assert from "node:assert/strict";
import test from "node:test";

import { createProxyServer } from "../../plugins/promptrail-codex-router/src/proxy.mjs";

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

function requestBody() {
  return {
    model: "gpt-5.6-sol",
    input: [
      { role: "developer", content: [{ type: "input_text", text: "developer context" }] },
      { role: "user", content: [{ type: "input_text", text: "Design a lock-free queue." }] },
    ],
    reasoning: { effort: "medium", summary: "auto" },
    stream: true,
  };
}

test("rejects API-key-style requests before calling the grader or upstream", async () => {
  const calls = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error("must not be called");
    },
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "chatgpt_subscription_required");
    assert.equal(calls.length, 0);
  } finally {
    await close(server);
  }
});

test("sends only the prompt to the grader and forwards the routed subscription request", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://grader.test/grade") {
      return new Response(
        JSON.stringify({ grade: 5, latency_ms: 12 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(url, "https://chatgpt.test/backend-api/codex/responses");
    return new Response('data: {"type":"response.completed"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl,
    upstreamBaseUrl: "https://chatgpt.test/backend-api/codex",
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    const routeResponse = await fetch(`http://127.0.0.1:${port}/route`, {
      method: "POST",
      headers: {
        authorization: "Bearer router-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "Design a lock-free queue.", model: "gpt-5.6-sol" }),
    });
    assert.equal(routeResponse.status, 200);
    assert.equal((await routeResponse.json()).effort, "xhigh");

    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer subscription-secret",
        "chatgpt-account-id": "account-123",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-grade"), "5");
    assert.equal(response.headers.get("x-promptrail-effort"), "xhigh");
    assert.match(await response.text(), /response.completed/);

    assert.equal(calls.length, 2);
    const graderCall = calls[0];
    assert.equal(graderCall.options.headers.authorization, "Bearer router-secret");
    assert.deepEqual(JSON.parse(graderCall.options.body), {
      prompt: "Design a lock-free queue.",
      model: "gpt-5.6-sol",
    });
    assert.doesNotMatch(graderCall.options.body, /subscription-secret|account-123|developer context/);

    const upstreamCall = calls[1];
    assert.equal(upstreamCall.options.headers.authorization, "Bearer subscription-secret");
    assert.equal(upstreamCall.options.headers["chatgpt-account-id"], "account-123");
    assert.equal(JSON.parse(upstreamCall.options.body).reasoning.effort, "xhigh");
  } finally {
    await close(server);
  }
});

test("matches a cached route when Codex wraps an attached image around the prompt", async () => {
  const prompt = "[Image #1] fix this display issue in dark mode";
  const upstreamBodies = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        return new Response(JSON.stringify({ grade: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamBodies.push(JSON.parse(options.body));
      return new Response("ok", { status: 200 });
    },
    upstreamBaseUrl: "https://chatgpt.test/backend-api/codex",
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    const routeResponse = await fetch(`http://127.0.0.1:${port}/route`, {
      method: "POST",
      headers: {
        authorization: "Bearer router-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt, model: "gpt-5.6-sol" }),
    });
    assert.equal(routeResponse.status, 200);

    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer subscription-secret",
        "chatgpt-account-id": "account-123",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: '<image name=[Image #1] path="/tmp/dashboard.png">' },
              { type: "input_image", image_url: "data:image/png;base64,ignored" },
              { type: "input_text", text: "</image>" },
              { type: "input_text", text: prompt },
            ],
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-effort"), "low");
    assert.equal(upstreamBodies[0].reasoning.effort, "low");
  } finally {
    await close(server);
  }
});

test("does not call OpenAI when the grader violates the six-grade contract", async () => {
  let calls = 0;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ grade: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/route`, {
      method: "POST",
      headers: {
        authorization: "Bearer router-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "Design a lock-free queue.", model: "gpt-5.6-sol" }),
    });
    assert.equal(response.status, 422);
    assert.match((await response.json()).message, /integer from 1 through 6/);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("stops a Codex request when the thinking level was not selected first", async () => {
  let calls = 0;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer subscription-secret",
        "chatgpt-account-id": "account-123",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "promptrail_route_missing");
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});
