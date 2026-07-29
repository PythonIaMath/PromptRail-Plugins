const MAX_MODEL_CATALOG_BYTES = 1024 * 1024;
const MAX_MODEL_RECORDS = 500;

export async function fetchInfiniteModelRecords({
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }
  const token = String(apiKey || "").trim();
  if (!token) {
    throw new Error("PROMPTRAIL_API_KEY is required to download the Infinite model catalog.");
  }
  const endpoint = `${String(baseUrl || "").replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "X-PromptRail-Model-Catalog": "picker-v2",
      },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("PromptRail Infinite model discovery timed out.");
    }
    throw new Error("PromptRail Infinite model discovery is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      `PromptRail Infinite model discovery failed with HTTP ${response.status}.`,
    );
  }
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MODEL_CATALOG_BYTES) {
    throw new Error("PromptRail Infinite returned an oversized model catalog.");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_MODEL_CATALOG_BYTES) {
    throw new Error("PromptRail Infinite returned an oversized model catalog.");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PromptRail Infinite returned a malformed model catalog.");
  }
  if (
    !value
    || value.object !== "list"
    || !Array.isArray(value.data)
    || value.data.length > MAX_MODEL_RECORDS
  ) {
    throw new Error("PromptRail Infinite returned an invalid model catalog.");
  }
  return value.data;
}
