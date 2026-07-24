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

function routerPayload(thinkingGrade, model = "gpt-5.6-terra", latency = 0) {
  return {
    thinking_grade: thinkingGrade,
    model,
    difficulty: model.endsWith("luna") ? 1 : model.endsWith("sol") ? 3 : 2,
    latency_ms: { total: latency },
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
        JSON.stringify(routerPayload(5, "gpt-5.6-sol", 12)),
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

    assert.equal(calls.length, 3);
    const graderCall = calls[0];
    assert.equal(graderCall.options.headers.authorization, "Bearer router-secret");
    assert.deepEqual(JSON.parse(graderCall.options.body), {
      client: "codex",
      prompt: "Design a lock-free queue.",
      current_model: "gpt-5.6-sol",
      previous_user_prompt: "No previous user prompt; this is the first turn.",
      previous_assistant_summary: "No previous assistant response; this is the first turn.",
    });
    assert.doesNotMatch(graderCall.options.body, /subscription-secret|account-123|developer context/);

    const upstreamCall = calls[2];
    assert.equal(upstreamCall.options.headers.authorization, "Bearer subscription-secret");
    assert.equal(upstreamCall.options.headers["chatgpt-account-id"], "account-123");
    assert.equal(JSON.parse(upstreamCall.options.body).reasoning.effort, "xhigh");
  } finally {
    await close(server);
  }
});

test("routes an attached-image prompt independently on every request", async () => {
  const prompt = "[Image #1] fix this display issue in dark mode";
  const upstreamBodies = [];
  let graderCalls = 0;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        graderCalls += 1;
        return new Response(JSON.stringify(routerPayload(2)), {
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
    assert.equal((await routeResponse.json()).effort, "low");

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
    assert.equal(graderCalls, 2);
  } finally {
    await close(server);
  }
});

test("regrades with the previous user prompt and assistant summary", async () => {
  const graderBodies = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        graderBodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify(routerPayload(graderBodies.length === 1 ? 1 : 4)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
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
      body: JSON.stringify({ prompt: "Do it.", model: "gpt-5.6-sol" }),
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
          { role: "user", content: [{ type: "input_text", text: "Fix the login bug." }] },
          {
            role: "assistant",
            content: [
              { type: "output_text", text: "Full response must stay local." },
              { type: "summary_text", text: "Found a stale session cookie." },
            ],
          },
          { role: "user", content: [{ type: "input_text", text: "Do it." }] },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-grade"), "4");
    assert.equal(response.headers.get("x-promptrail-effort"), "high");
    assert.equal(graderBodies.length, 2);
    assert.deepEqual(graderBodies[1], {
      client: "codex",
      prompt: "Do it.",
      current_model: "gpt-5.6-sol",
      previous_user_prompt: "Fix the login bug.",
      previous_assistant_summary: "Found a stale session cookie.",
    });
    assert.doesNotMatch(JSON.stringify(graderBodies[1]), /Full response must stay local/);
  } finally {
    await close(server);
  }
});

test("regrades with compact assistant output when no explicit summary exists", async () => {
  let graderBody;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        graderBody = JSON.parse(options.body);
        return new Response(JSON.stringify(routerPayload(3)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    },
    upstreamBaseUrl: "https://chatgpt.test/backend-api/codex",
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
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Inspect the queue." }] },
          {
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "  Found unsafe shared mutation.\n\nSynchronization is still missing.  ",
              },
            ],
          },
          { role: "user", content: [{ type: "input_text", text: "Fix it." }] },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(graderBody, {
      client: "codex",
      prompt: "Fix it.",
      current_model: "gpt-5.6-sol",
      previous_user_prompt: "Inspect the queue.",
      previous_assistant_summary:
        "Found unsafe shared mutation. Synchronization is still missing.",
    });
  } finally {
    await close(server);
  }
});

test("uses the router's grade 1 directly without client-side calibration", async () => {
  const upstreamBodies = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        return new Response(JSON.stringify(routerPayload(1)), {
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
      body: JSON.stringify({ prompt: "Fix the login bug", model: "gpt-5.6-sol" }),
    });
    assert.equal(routeResponse.status, 200);
    const route = await routeResponse.json();
    assert.equal(route.grade, 1);
    assert.equal(route.effort, "none");

    const response = await fetch(`http://127.0.0.1:${port}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer subscription-secret",
        "chatgpt-account-id": "account-123",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ role: "user", content: [{ type: "input_text", text: "Fix the login bug" }] }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-grade"), "1");
    assert.equal(response.headers.get("x-promptrail-effort"), "none");
    assert.equal(upstreamBodies[0].reasoning.effort, "none");
  } finally {
    await close(server);
  }
});

test("keeps grade 1 for a genuinely trivial prompt", async () => {
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async () => new Response(JSON.stringify(routerPayload(1, "gpt-5.6-luna")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
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
      body: JSON.stringify({ prompt: "Thanks!", model: "gpt-5.6-sol" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).effort, "none");
  } finally {
    await close(server);
  }
});

test("returns Terra Medium when the grader violates the six-grade contract", async () => {
  let calls = 0;
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(routerPayload(7)), {
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
    assert.equal(response.status, 200);
    const route = await response.json();
    assert.equal(route.grade, 3);
    assert.equal(route.effort, "medium");
    assert.equal(route.model, "gpt-5.6-terra");
    assert.equal(route.fallback, true);
    assert.match(route.warning, /integer from 1 through 6/);
    assert.match(route.warning, /Falling back to Terra Medium/);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});

test("forwards the request with Terra Medium when the grader fetch fails", async () => {
  const upstreamBodies = [];
  const errors = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      if (url === "https://grader.test/grade") {
        throw new Error("fetch failed");
      }
      upstreamBodies.push(JSON.parse(options.body));
      return new Response("ok", { status: 200 });
    },
    upstreamBaseUrl: "https://chatgpt.test/backend-api/codex",
    logger: {
      info() {},
      error(message) {
        errors.push(JSON.parse(message));
      },
    },
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
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-grade"), "3");
    assert.equal(response.headers.get("x-promptrail-effort"), "medium");
    assert.equal(response.headers.get("x-promptrail-route-source"), "terra_medium_fallback");
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0].model, "gpt-5.6-terra");
    assert.equal(upstreamBodies[0].reasoning.effort, "medium");
    assert.deepEqual(errors, [
      {
        event: "promptrail_route_fallback",
        error: "fetch failed",
        grade: 3,
        effort: "medium",
        model: "gpt-5.6-terra",
      },
    ]);
  } finally {
    await close(server);
  }
});

test("grades Codex Desktop background responses that do not run UserPromptSubmit", async () => {
  const calls = [];
  const server = createProxyServer({
    config: { graderUrl: "https://grader.test/grade", routerToken: "router-secret" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "https://grader.test/grade") {
        return new Response(JSON.stringify(routerPayload(2, "gpt-5.6-terra", 9)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    },
    logger: { info() {} },
    upstreamBaseUrl: "https://chatgpt.test/backend-api/codex",
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
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-promptrail-grade"), "2");
    assert.equal(response.headers.get("x-promptrail-effort"), "low");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://grader.test/grade");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      client: "codex",
      prompt: "Design a lock-free queue.",
      current_model: "gpt-5.6-sol",
      previous_user_prompt: "No previous user prompt; this is the first turn.",
      previous_assistant_summary: "No previous assistant response; this is the first turn.",
    });
    assert.equal(calls[1].url, "https://chatgpt.test/backend-api/codex/responses");
    assert.equal(JSON.parse(calls[1].options.body).reasoning.effort, "low");
    assert.equal(JSON.parse(calls[1].options.body).model, "gpt-5.6-terra");
  } finally {
    await close(server);
  }
});
