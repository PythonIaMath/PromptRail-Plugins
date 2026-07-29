import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateInfiniteCli,
  infiniteAccountBaseUrl,
  infiniteVerificationUrl,
  openBrowserUrl,
} from "../lib/infinite-browser-auth.mjs";

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    value() { return value; },
  };
}

test("accepts the production account origin and local HTTP development only", () => {
  assert.equal(infiniteAccountBaseUrl(), "https://www.promptrail.ai");
  assert.equal(infiniteAccountBaseUrl("http://127.0.0.1:3002"), "http://127.0.0.1:3002");
  assert.throws(() => infiniteAccountBaseUrl("http://promptrail.example"), /HTTPS origin/);
  assert.throws(() => infiniteAccountBaseUrl("https://user@example.com"), /HTTPS origin/);
  assert.throws(() => infiniteAccountBaseUrl("https://example.com?token=secret"), /HTTPS origin/);
  assert.throws(() => infiniteAccountBaseUrl("https://example.com/account"), /HTTPS origin/);
});

test("accepts only same-origin PromptRail device authorization URLs", () => {
  assert.equal(
    infiniteVerificationUrl(
      "https://accounts.example/device?code=ABCD-EFGH",
      "https://accounts.example",
    ),
    "https://accounts.example/device?code=ABCD-EFGH",
  );
  assert.throws(
    () => infiniteVerificationUrl("https://attacker.example/device", "https://accounts.example"),
    /untrusted browser authorization URL/,
  );
  assert.throws(
    () => infiniteVerificationUrl("javascript:alert(1)", "https://accounts.example"),
    /untrusted browser authorization URL/,
  );
});

test("opens the authorization URL with the platform browser command", () => {
  const calls = [];
  const child = { once() {}, unref() {} };
  assert.equal(openBrowserUrl("https://example.com/device", {
    platformName: "darwin",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  }), true);
  assert.deepEqual(calls, [{
    command: "open",
    args: ["https://example.com/device"],
    options: { detached: true, stdio: "ignore" },
  }]);
});

test("completes browser authorization without exposing either secret", async () => {
  const requests = [];
  const sleeps = [];
  const output = outputBuffer();
  const responses = [
    new Response(JSON.stringify({
      device_code: "private-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://accounts.example/device",
      verification_uri_complete: "https://accounts.example/device?code=ABCD-EFGH",
      expires_in: 600,
      interval: 2,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 428,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify({
      install_token: "private-install-token",
      token_type: "Bearer",
      expires_in: 300,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      credential: { api_key: "private-api-key", api_key_id: "key-1" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  ];

  const token = await authenticateInfiniteCli({
    accountBaseUrl: "https://accounts.example",
    detectedHarnesses: ["codex", "claude"],
    deviceName: "PromptRail test CLI",
    output: output.stream,
    openBrowserImpl(url) {
      assert.equal(url, "https://accounts.example/device?code=ABCD-EFGH");
      return true;
    },
    async sleepImpl(milliseconds) {
      sleeps.push(milliseconds);
    },
    now: () => 1_000,
    async fetchImpl(url, options) {
      requests.push({ url, options });
      return responses.shift();
    },
  });

  assert.equal(token, "private-api-key");
  assert.deepEqual(sleeps, [2_000, 2_000]);
  assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
    ["https://accounts.example/api/cli/device", "POST"],
    ["https://accounts.example/api/cli/device", "PUT"],
    ["https://accounts.example/api/cli/device", "PUT"],
    ["https://accounts.example/api/cli/infinite/install", "POST"],
  ]);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    product: "infinite",
    device_name: "PromptRail test CLI",
    detected_harnesses: ["codex", "claude"],
  });
  assert.equal(requests[3].options.headers.Authorization, "Bearer private-install-token");
  assert.match(output.value(), /ABCD-EFGH/);
  assert.match(output.value(), /authorization complete/);
  assert.doesNotMatch(output.value(), /private-device-code|private-install-token|private-api-key/);
});

test("prints a manual URL when the browser cannot be opened", async () => {
  const output = outputBuffer();
  await assert.rejects(() => authenticateInfiniteCli({
    accountBaseUrl: "https://accounts.example",
    output: output.stream,
    openBrowserImpl() { return false; },
    sleepImpl: async () => {},
    now: (() => {
      let value = 0;
      return () => (value += 61_000);
    })(),
    async fetchImpl() {
      return new Response(JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.example/device",
        expires_in: 60,
        interval: 1,
      }), { status: 200 });
    },
  }), /expired/);
  assert.match(output.value(), /Open the URL above manually/);
});

test("fails closed on denial and never exchanges a token", async () => {
  let requestCount = 0;
  await assert.rejects(() => authenticateInfiniteCli({
    accountBaseUrl: "https://accounts.example",
    output: outputBuffer().stream,
    openBrowserImpl: () => true,
    sleepImpl: async () => {},
    now: () => 1_000,
    async fetchImpl() {
      requestCount += 1;
      return requestCount === 1
        ? new Response(JSON.stringify({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.example/device",
          expires_in: 600,
          interval: 1,
        }), { status: 200 })
        : new Response(JSON.stringify({ error: "access_denied" }), { status: 400 });
    },
  }), /access denied/);
  assert.equal(requestCount, 2);
});
