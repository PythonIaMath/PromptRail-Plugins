import assert from "node:assert/strict";
import test from "node:test";

import { fetchInfiniteModelRecords } from "../lib/infinite-model-discovery.mjs";

function response(value, { status = 200, headers = {} } = {}) {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("downloads the tenant model catalog without placing its key in the URL", async () => {
  const calls = [];
  const records = await fetchInfiniteModelRecords({
    baseUrl: "https://gateway.example/v1",
    apiKey: "secret-key",
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return response({
        object: "list",
        data: [{ id: "promptrail/infinite", object: "model" }],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://gateway.example/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-key");
  assert.equal(calls[0].options.redirect, "error");
  assert.doesNotMatch(calls[0].url, /secret-key/);
  assert.equal(records[0].id, "promptrail/infinite");
});

test("sanitizes discovery failures and rejects malformed or oversized catalogs", async () => {
  await assert.rejects(
    fetchInfiniteModelRecords({
      baseUrl: "https://gateway.example/v1",
      apiKey: "do-not-reflect",
      fetchImpl: async () => response("upstream secret body", { status: 503 }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /do-not-reflect|upstream secret body/);
      return true;
    },
  );
  await assert.rejects(
    fetchInfiniteModelRecords({
      baseUrl: "https://gateway.example/v1",
      apiKey: "key",
      fetchImpl: async () => response("not-json"),
    }),
    /malformed model catalog/,
  );
  await assert.rejects(
    fetchInfiniteModelRecords({
      baseUrl: "https://gateway.example/v1",
      apiKey: "key",
      fetchImpl: async () => response("x", { headers: { "content-length": "1048577" } }),
    }),
    /oversized model catalog/,
  );
});

test("requires an API key before making a discovery request", async () => {
  let called = false;
  await assert.rejects(
    fetchInfiniteModelRecords({
      baseUrl: "https://gateway.example/v1",
      apiKey: "",
      fetchImpl: async () => {
        called = true;
        return response({ object: "list", data: [] });
      },
    }),
    /PROMPTRAIL_API_KEY is required/,
  );
  assert.equal(called, false);
});
