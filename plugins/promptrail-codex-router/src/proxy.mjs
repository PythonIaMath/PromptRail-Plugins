import http from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  CHATGPT_UPSTREAM_BASE_URL,
  loadRouterConfig,
} from "./config.mjs";
import { gradePrompt } from "./grader-client.mjs";
import {
  applyRoute,
  effortForGrade,
  extractLatestUserPrompt,
  extractPreviousTurnContext,
  FIRST_TURN_ASSISTANT_CONTEXT,
  FIRST_TURN_USER_CONTEXT,
  normalizeGradeForPrompt,
} from "./routing.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function jsonResponse(response, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new RangeError(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertSubscriptionAuth(request) {
  const authorization = String(request.headers.authorization || "");
  const accountId = String(request.headers["chatgpt-account-id"] || "");
  if (!authorization.startsWith("Bearer ") || !accountId.trim()) {
    const error = new Error(
      "ChatGPT subscription authentication is required. Run `codex login` and sign in with ChatGPT, not an API key.",
    );
    error.statusCode = 401;
    error.code = "chatgpt_subscription_required";
    throw error;
  }
}

function assertRouterAuth(request, routerToken) {
  if (String(request.headers.authorization || "") !== `Bearer ${routerToken}`) {
    const error = new Error("PromptRail router authentication is required.");
    error.statusCode = 401;
    error.code = "promptrail_router_auth_required";
    throw error;
  }
}

function validateRouteInput(payload) {
  const prompt = String(payload?.prompt || "").trim();
  const model = String(payload?.model || "").trim();
  if (!prompt) {
    throw new TypeError("PromptRail route request requires a non-empty prompt.");
  }
  if (!model) {
    throw new TypeError("PromptRail route request requires a model.");
  }
  return {
    prompt,
    model,
    previousUserPrompt:
      String(payload?.previous_user_prompt || "").trim() || FIRST_TURN_USER_CONTEXT,
    previousAssistantSummary:
      String(payload?.previous_assistant_summary || "").trim() ||
      FIRST_TURN_ASSISTANT_CONTEXT,
  };
}

function forwardHeaders(incomingHeaders, body) {
  const headers = {};
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  headers["accept-encoding"] = "identity";
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return headers;
}

async function pipeFetchResponse(upstream, response, route) {
  const headers = {};
  upstream.headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  });
  if (route) {
    headers["x-promptrail-grade"] = String(route.grade);
    headers["x-promptrail-effort"] = route.effort;
  }
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", reject);
    response.on("error", reject);
    response.on("finish", resolve);
    stream.pipe(response);
  });
}

export function createProxyServer({
  config,
  fetchImpl = fetch,
  upstreamBaseUrl = CHATGPT_UPSTREAM_BASE_URL,
  logger = console,
}) {
  async function selectRoute(prompt, model, context = {}) {
    const graded = await gradePrompt({
      graderUrl: config.graderUrl,
      routerToken: config.routerToken,
      prompt,
      model,
      ...context,
      fetchImpl,
    });
    const grade = normalizeGradeForPrompt(graded.grade, prompt);
    const route = { ...graded, grade, effort: effortForGrade(grade) };
    return { ...route, source: "proxy_request" };
  }

  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      jsonResponse(response, 200, {
        status: "ok",
        mode: "chatgpt-subscription-only",
        grades: 6,
      });
      return;
    }

    try {
      if (request.method === "POST" && request.url === "/route") {
        assertRouterAuth(request, config.routerToken);
        const {
          prompt,
          model,
          previousUserPrompt,
          previousAssistantSummary,
        } = validateRouteInput(JSON.parse(await readRequestBody(request)));
        const graded = await gradePrompt({
          graderUrl: config.graderUrl,
          routerToken: config.routerToken,
          prompt,
          model,
          previousUserPrompt,
          previousAssistantSummary,
          fetchImpl,
        });
        const grade = normalizeGradeForPrompt(graded.grade, prompt);
        const route = { ...graded, grade, effort: effortForGrade(grade) };
        jsonResponse(response, 200, route);
        return;
      }

      assertSubscriptionAuth(request);
      let bodyText;
      let route;
      if (request.method === "POST") {
        bodyText = await readRequestBody(request);
      }
      if (request.method === "POST" && request.url === "/responses") {
        const requestBody = JSON.parse(bodyText);
        const prompt = extractLatestUserPrompt(requestBody);
        const context = extractPreviousTurnContext(requestBody);
        const graded = await selectRoute(prompt, requestBody.model, context);
        const applied = applyRoute(requestBody, graded);
        bodyText = JSON.stringify(applied.body);
        route = { ...graded, effort: applied.effort, model: applied.model };
        logger.info?.(
          JSON.stringify({
            event: "promptrail_route",
            grade: route.grade,
            effort: route.effort,
            model: route.model,
            route_source: graded.source,
            grader_latency_ms: route.latencyMs,
          }),
        );
      }

      const upstreamUrl = `${upstreamBaseUrl.replace(/\/$/, "")}${request.url}`;
      const upstream = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers: forwardHeaders(request.headers, bodyText),
        body: bodyText,
        redirect: "manual",
      });
      await pipeFetchResponse(upstream, response, route);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = Number(error.statusCode) || (error instanceof RangeError ? 422 : 502);
      jsonResponse(response, status, {
        error: error.code || "promptrail_router_error",
        message: error.message,
      });
    }
  });
}

export async function startProxy() {
  const config = await loadRouterConfig();
  const server = createProxyServer({ config });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  process.stdout.write(
    `${JSON.stringify({ event: "promptrail_proxy_started", host: config.host, port: config.port })}\n`,
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startProxy().catch((error) => {
    process.stderr.write(`PromptRail proxy failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
