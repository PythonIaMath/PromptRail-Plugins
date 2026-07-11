import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  ANTHROPIC_UPSTREAM_BASE_URL,
  loadRouterConfig,
} from "./config.mjs";
import { gradePrompt } from "./grader-client.mjs";
import { applyGrade, effortForGrade } from "./routing.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const ROUTE_CACHE_TTL_MS = 30 * 60 * 1000;
const ALLOWED_UPSTREAM_REQUESTS = new Set([
  "HEAD /",
  "GET /v1/models",
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
]);
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

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function assertSubscriptionAuth(request) {
  const authorization = String(request.headers.authorization || "");
  const apiKey = String(request.headers["x-api-key"] || "");
  const betaCapabilities = String(request.headers["anthropic-beta"] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase());
  const hasOAuthCapability = betaCapabilities.some((value) => value.includes("oauth"));
  if (apiKey || !authorization.startsWith("Bearer ") || !hasOAuthCapability) {
    const error = new Error(
      "A claude.ai subscription login is required. Remove ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, and apiKeyHelper, then run `claude auth login`.",
    );
    error.statusCode = 401;
    error.code = "claude_subscription_required";
    throw error;
  }
}

function assertRouterAuth(request, routerToken) {
  if (!secureEqual(request.headers.authorization || "", `Bearer ${routerToken}`)) {
    const error = new Error("PromptRail Claude router authentication is required.");
    error.statusCode = 401;
    error.code = "promptrail_router_auth_required";
    throw error;
  }
}

function validateRouteInput(payload) {
  const sessionId = String(payload?.sessionId || "").trim();
  const prompt = String(payload?.prompt || "").trim();
  if (!sessionId) {
    throw new TypeError("PromptRail route request requires a Claude session ID.");
  }
  if (!prompt) {
    throw new TypeError("PromptRail route request requires a non-empty prompt.");
  }
  return { sessionId, prompt };
}

function requestPath(request) {
  return new URL(request.url || "/", "http://127.0.0.1").pathname;
}

function assertAllowedUpstreamRequest(request) {
  const signature = `${request.method} ${requestPath(request)}`;
  if (!ALLOWED_UPSTREAM_REQUESTS.has(signature)) {
    const error = new Error(`Unsupported Claude gateway request: ${signature}.`);
    error.statusCode = 404;
    error.code = "promptrail_unsupported_gateway_request";
    throw error;
  }
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
  upstreamBaseUrl = ANTHROPIC_UPSTREAM_BASE_URL,
  logger = console,
}) {
  const routeCache = new Map();

  function cacheRoute(sessionId, route) {
    const now = Date.now();
    for (const [key, cached] of routeCache) {
      if (now - cached.createdAt > ROUTE_CACHE_TTL_MS) {
        routeCache.delete(key);
      }
    }
    routeCache.set(sessionId, { ...route, createdAt: now });
  }

  function requireCachedRoute(sessionId) {
    const cached = routeCache.get(sessionId);
    if (!cached || Date.now() - cached.createdAt > ROUTE_CACHE_TTL_MS) {
      routeCache.delete(sessionId);
      const error = new Error(
        "Thinking level was not selected before the Claude request. Start a new Claude Code session so the PromptRail UserPromptSubmit hook is loaded.",
      );
      error.statusCode = 409;
      error.code = "promptrail_route_missing";
      throw error;
    }
    return cached;
  }

  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      jsonResponse(response, 200, {
        status: "ok",
        mode: "claude-subscription-only",
        grades: 5,
      });
      return;
    }

    try {
      if (request.method === "POST" && request.url === "/route") {
        assertRouterAuth(request, config.routerToken);
        const { sessionId, prompt } = validateRouteInput(
          JSON.parse(await readRequestBody(request)),
        );
        const graded = await gradePrompt({
          graderUrl: config.graderUrl,
          routerToken: config.routerToken,
          prompt,
          fetchImpl,
        });
        const route = { ...graded, effort: effortForGrade(graded.grade) };
        cacheRoute(sessionId, route);
        jsonResponse(response, 200, route);
        return;
      }

      assertAllowedUpstreamRequest(request);
      assertSubscriptionAuth(request);
      let bodyText;
      let route;
      if (request.method === "POST") {
        bodyText = await readRequestBody(request);
      }
      if (request.method === "POST" && requestPath(request) === "/v1/messages") {
        const sessionId = String(request.headers["x-claude-code-session-id"] || "").trim();
        if (!sessionId) {
          const error = new Error("Claude inference request is missing x-claude-code-session-id.");
          error.statusCode = 400;
          error.code = "claude_session_id_required";
          throw error;
        }
        const graded = requireCachedRoute(sessionId);
        const applied = applyGrade(JSON.parse(bodyText), graded.grade);
        bodyText = JSON.stringify(applied.body);
        route = { ...graded, effort: applied.effort };
        logger.info?.(
          JSON.stringify({
            event: "promptrail_claude_route",
            grade: route.grade,
            effort: route.effort,
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
      const status = Number(error.statusCode) || (
        error instanceof RangeError || error instanceof TypeError ? 422 : 502
      );
      jsonResponse(response, status, {
        error: error.code || "promptrail_claude_router_error",
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
    `${JSON.stringify({ event: "promptrail_claude_proxy_started", host: config.host, port: config.port })}\n`,
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startProxy().catch((error) => {
    process.stderr.write(`PromptRail Claude proxy failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
