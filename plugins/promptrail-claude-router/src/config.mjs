import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8788;
export const ANTHROPIC_UPSTREAM_BASE_URL = "https://api.anthropic.com";

export function routerHome() {
  return process.env.PROMPTRAIL_CLAUDE_ROUTER_HOME
    || join(homedir(), ".claude", "promptrail-router");
}

export function routerConfigPath() {
  return process.env.PROMPTRAIL_CLAUDE_ROUTER_CONFIG || join(routerHome(), "config.json");
}

export function validateRouterConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("PromptRail Claude router configuration must be a JSON object.");
  }
  const graderUrl = String(config.graderUrl || "").trim();
  const routerToken = String(config.routerToken || "").trim();
  if (!graderUrl) {
    throw new TypeError("graderUrl is required.");
  }
  const parsedUrl = new URL(graderUrl);
  if (
    parsedUrl.protocol !== "https:"
    && parsedUrl.hostname !== "127.0.0.1"
    && parsedUrl.hostname !== "localhost"
  ) {
    throw new TypeError("graderUrl must use HTTPS unless it points to localhost.");
  }
  if (!routerToken) {
    throw new TypeError("routerToken is required.");
  }
  const host = String(config.host || DEFAULT_HOST);
  if (host !== DEFAULT_HOST) {
    throw new TypeError(`The Claude router must bind to ${DEFAULT_HOST}.`);
  }
  const port = Number(config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("port must be an integer from 1 through 65535.");
  }
  return { graderUrl: parsedUrl.toString(), routerToken, host, port };
}

export async function loadRouterConfig(path = routerConfigPath()) {
  return validateRouterConfig(JSON.parse(await readFile(path, "utf8")));
}

export async function saveRouterConfig(config, path = routerConfigPath()) {
  const validated = validateRouterConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return validated;
}
