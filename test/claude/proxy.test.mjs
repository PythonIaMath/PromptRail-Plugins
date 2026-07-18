import assert from "node:assert/strict";
import test from "node:test";

import { createProxyServer } from "../../plugins/promptrail-claude-router/src/proxy.mjs";

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

function messageBody() {
  return {
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: [{ type: "text", text: "private system context" }],
    messages: [{ role: "user", content: "Prove this queue is linearizable." }],
    output_config: { effort: "medium" },
    stream: true,
  };
}

function routerPayload(thinkingGrade, model = "claude-fable-5", latency = 0) {
  return {
    thinking_grade: thinkingGrade,
    model,
    difficulty: model.includes("opus") ? 3 : 2,
    latency_ms: { total: latency },
  };
}

async function selectRoute(port, prompt = "Prove this queue is linearizable.") {
  return fetch(`http://127.0.0.1:${port}/route`, {
    method: "POST",
    headers: {
      authorization: "Bearer router-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId: "session-123", prompt }),
  });
}

test("rejects API-key requests before calling the grader or Anthropic", async () => {
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
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "sk-ant-api-key",
        "content-type": "application/json",
        "x-claude-code-session-id": "session-123",
      },
      body: JSON.stringify(messageBody()),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "claude_subscription_required");
    assert.equal(calls.length, 0);
  } finally {
    await close(server);
  }
});

test("rejects bearer traffic without Claude's OAuth capability marker", async () => {
  let calls = 0;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        authorization: "Bearer manually-supplied-token",
        "anthropic-beta": "effort-capability",
        "content-type": "application/json",
      },
      body: JSON.stringify(messageBody()),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "claude_subscription_required");
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});

test("routes a Claude subscription request and preserves protocol capabilities", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://grader.test/grade") {
      return new Response(
        JSON.stringify(routerPayload(4, "claude-fable-5", 11)),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    assert.equal(url, "https://api.anthropic.test/v1/messages?beta=true");
    return new Response("event: message_stop\ndata: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl,
    upstreamBaseUrl: "https://api.anthropic.test",
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    const routeResponse = await selectRoute(port);
    assert.equal(routeResponse.status, 200);
    assert.deepEqual(await routeResponse.json(), {
      grade: 4,
      model: "claude-fable-5",
      difficulty: 2,
      latencyMs: 11,
      effort: "xhigh",
    });

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        authorization: "Bearer claude-oauth-secret",
        "anthropic-beta": "oauth-capability,effort-capability",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-claude-code-session-id": "session-123",
      },
      body: JSON.stringify(messageBody()),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-grade"), "4");
    assert.equal(response.headers.get("x-promptrail-effort"), "xhigh");
    assert.match(await response.text(), /message_stop/);

    assert.equal(calls.length, 3);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      client: "claude",
      prompt: "Prove this queue is linearizable.",
      current_model: null,
      previous_user_prompt: "No previous user prompt; this is the first turn.",
      previous_assistant_summary: "No previous assistant response; this is the first turn.",
    });
    assert.doesNotMatch(
      calls[0].options.body,
      /claude-oauth-secret|private system context|session-123/,
    );

    const upstream = calls[2];
    assert.equal(upstream.options.headers.authorization, "Bearer claude-oauth-secret");
    assert.equal(
      upstream.options.headers["anthropic-beta"],
      "oauth-capability,effort-capability",
    );
    assert.equal(upstream.options.headers["anthropic-version"], "2023-06-01");
    assert.equal(JSON.parse(upstream.options.body).output_config.effort, "xhigh");
    assert.equal(JSON.parse(upstream.options.body).model, "claude-fable-5");
  } finally {
    await close(server);
  }
});

test("regrades every Claude request instead of reusing a prior route", async () => {
  let graderCalls = 0;
  const upstreamBodies = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        graderCalls += 1;
        return new Response(JSON.stringify(routerPayload(2, "claude-sonnet-5")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      upstreamBodies.push(JSON.parse(options.body));
      return new Response("ok", { status: 200 });
    },
    upstreamBaseUrl: "https://api.anthropic.test",
    logger: { info() {} },
  });
  const port = await listen(server);
  try {
    assert.equal((await selectRoute(port)).status, 200);
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer claude-oauth-secret",
          "anthropic-beta": "oauth-capability,effort-capability",
          "content-type": "application/json",
          "x-claude-code-session-id": "session-123",
        },
        body: JSON.stringify(messageBody()),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(graderCalls, 3);
    assert.deepEqual(upstreamBodies.map((body) => body.output_config.effort), [
      "medium",
      "medium",
    ]);
    assert.deepEqual(upstreamBodies.map((body) => body.model), [
      "claude-sonnet-5",
      "claude-sonnet-5",
    ]);
  } finally {
    await close(server);
  }
});

test("forwards token counting without requiring an effort route", async () => {
  const calls = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    upstreamBaseUrl: "https://api.anthropic.test",
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        authorization: "Bearer claude-oauth-secret",
        "anthropic-beta": "oauth-capability,effort-capability",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(messageBody()),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 42 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.anthropic.test/v1/messages/count_tokens");
    assert.equal(
      JSON.parse(calls[0].options.body).output_config.effort,
      "medium",
    );
  } finally {
    await close(server);
  }
});

test("regrades requests from sessions that started before hook installation", async () => {
  const calls = [];
  const logs = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "https://grader.test/grade") {
        return new Response(JSON.stringify(routerPayload(4, "claude-fable-5", 13)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    },
    upstreamBaseUrl: "https://api.anthropic.test",
    logger: { info(message) { logs.push(JSON.parse(message)); } },
  });
  const port = await listen(server);
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer claude-oauth-secret",
          "anthropic-beta": "oauth-capability,effort-capability",
          "content-type": "application/json",
          "x-claude-code-session-id": "session-123",
        },
        body: JSON.stringify(messageBody()),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-promptrail-grade"), "4");
      assert.equal(response.headers.get("x-promptrail-effort"), "xhigh");
    }

    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, "https://grader.test/grade");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      client: "claude",
      prompt: "Prove this queue is linearizable.",
      current_model: "claude-opus-4-8",
      previous_user_prompt: "No previous user prompt; this is the first turn.",
      previous_assistant_summary: "No previous assistant response; this is the first turn.",
    });
    assert.doesNotMatch(
      calls[0].options.body,
      /private system context|claude-oauth-secret|session-123/,
    );
    assert.deepEqual(
      calls.filter(({ url }) => url !== "https://grader.test/grade")
        .map(({ options }) => JSON.parse(options.body).output_config.effort),
      ["xhigh", "xhigh"],
    );
    assert.deepEqual(logs.map(({ route_source }) => route_source), ["proxy_request", "proxy_request"]);
  } finally {
    await close(server);
  }
});

test("rejects unsupported paths instead of operating as an open proxy", async () => {
  let calls = 0;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin`, {
      headers: {
        authorization: "Bearer claude-oauth-secret",
        "anthropic-beta": "oauth-capability",
      },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "promptrail_unsupported_gateway_request");
    assert.equal(calls, 0);
  } finally {
    await close(server);
  }
});
