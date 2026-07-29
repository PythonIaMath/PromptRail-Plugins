import { spawn as spawnProcess } from "node:child_process";
import { platform } from "node:os";

export const DEFAULT_PROMPTRAIL_ACCOUNT_URL = "https://www.promptrail.ai";

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

export function infiniteAccountBaseUrl(value = DEFAULT_PROMPTRAIL_ACCOUNT_URL) {
  let parsed;
  try {
    parsed = new URL(String(value || DEFAULT_PROMPTRAIL_ACCOUNT_URL));
  } catch {
    throw new Error("PromptRail account URL is invalid.");
  }
  const localDevelopment = parsed.protocol === "http:"
    && new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localDevelopment)
    || parsed.username
    || parsed.password
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("PromptRail account URL must be an HTTPS origin without credentials or query parameters.");
  }
  return parsed.origin;
}

export function infiniteVerificationUrl(value, accountBaseUrl) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("PromptRail returned an invalid browser authorization URL.");
  }
  const expectedOrigin = infiniteAccountBaseUrl(accountBaseUrl);
  if (
    parsed.origin !== expectedOrigin
    || parsed.pathname !== "/device"
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new Error("PromptRail returned an untrusted browser authorization URL.");
  }
  return parsed.toString();
}

export function openBrowserUrl(url, { spawnImpl = spawnProcess, platformName = platform() } = {}) {
  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd.exe", ["/d", "/s", "/c", "start", "", url]],
  };
  const [command, args] = commands[platformName] || ["xdg-open", [url]];
  try {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.once?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

async function boundedResponseJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error("PromptRail authentication returned an oversized response.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error("PromptRail authentication returned an oversized response.");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("PromptRail authentication returned malformed JSON.");
  }
}

async function requestJson(url, options, { fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: controller.signal,
    });
    return { response, payload: await boundedResponseJson(response) };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("PromptRail browser authentication timed out.");
    }
    if (/PromptRail authentication/u.test(String(error?.message || ""))) throw error;
    throw new Error("PromptRail browser authentication is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

function authorizationError(payload, fallback) {
  return String(payload?.error || payload?.message || fallback).replaceAll("_", " ");
}

export async function authenticateInfiniteCli({
  accountBaseUrl = DEFAULT_PROMPTRAIL_ACCOUNT_URL,
  detectedHarnesses = [],
  deviceName = `PromptRail CLI on ${platform()}`,
  fetchImpl = globalThis.fetch,
  openBrowserImpl = openBrowserUrl,
  output = process.stdout,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch for browser authentication.");
  }
  const baseUrl = infiniteAccountBaseUrl(accountBaseUrl);
  const started = await requestJson(
    `${baseUrl}/api/cli/device`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        product: "infinite",
        device_name: String(deviceName).slice(0, 120),
        detected_harnesses: detectedHarnesses.map(String).slice(0, 4),
      }),
    },
    { fetchImpl },
  );
  const device = started.payload;
  if (
    !started.response.ok
    || typeof device.device_code !== "string"
    || typeof device.user_code !== "string"
    || typeof device.verification_uri !== "string"
  ) {
    throw new Error(authorizationError(device, "Unable to start PromptRail browser authentication."));
  }

  const verificationUrl = infiniteVerificationUrl(
    device.verification_uri_complete || device.verification_uri,
    baseUrl,
  );
  output.write("Authorize PromptRail Infinite in your browser:\n");
  output.write(`  ${verificationUrl}\n`);
  output.write(`Device code: ${device.user_code}\n`);
  if (!openBrowserImpl(verificationUrl)) {
    output.write("The browser could not be opened automatically. Open the URL above manually.\n");
  } else {
    output.write("Waiting for browser authorization...\n");
  }

  const expiresInSeconds = Math.min(30 * 60, Math.max(60, Number(device.expires_in) || 600));
  const expiresAt = now() + expiresInSeconds * 1_000;
  let intervalSeconds = Math.min(10, Math.max(1, Number(device.interval) || 2));
  let installToken = "";

  while (now() < expiresAt) {
    await sleepImpl(intervalSeconds * 1_000);
    const polled = await requestJson(
      `${baseUrl}/api/cli/device`,
      {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: device.device_code }),
      },
      { fetchImpl },
    );
    if (polled.response.ok && typeof polled.payload.install_token === "string") {
      installToken = polled.payload.install_token;
      break;
    }
    const code = String(polled.payload.error || "");
    if (polled.response.status === 428 || code === "authorization_pending") continue;
    if (polled.response.status === 429 || code === "slow_down") {
      intervalSeconds = Math.min(15, intervalSeconds + 2);
      continue;
    }
    throw new Error(authorizationError(polled.payload, "PromptRail browser authorization failed."));
  }
  if (!installToken) {
    throw new Error("PromptRail browser authorization expired. Run the installer again.");
  }

  const exchanged = await requestJson(
    `${baseUrl}/api/cli/infinite/install`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${installToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_name: String(deviceName).slice(0, 120) }),
    },
    { fetchImpl },
  );
  const apiKey = String(exchanged.payload?.credential?.api_key || "").trim();
  if (!exchanged.response.ok || !apiKey) {
    throw new Error(authorizationError(exchanged.payload, "PromptRail Infinite access was not granted."));
  }
  output.write("PromptRail Infinite authorization complete.\n");
  return apiKey;
}
