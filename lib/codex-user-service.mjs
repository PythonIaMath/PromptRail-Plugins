import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  loadRouterConfig,
  routerConfigPath,
  routerHome,
} from "../plugins/promptrail-codex-router/src/config.mjs";

const SERVICE_LABEL = "ai.promptrail.codex-router";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function macServicePath() {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function linuxServicePath() {
  return join(homedir(), ".config", "systemd", "user", "promptrail-codex-router.service");
}

async function waitForLaunchdRemoval(serviceTarget) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (run("launchctl", ["print", serviceTarget], { allowFailure: true }).status !== 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`launchd did not remove ${serviceTarget} before reload.`);
}

async function waitForRouterHealth() {
  const config = await loadRouterConfig();
  const url = `http://${config.host}:${config.port}/health`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      const payload = response.ok ? await response.json() : null;
      if (payload?.status === "ok" && payload.mode === "chatgpt-subscription-only") {
        return;
      }
    } catch {
      // The service is still starting. The bounded loop below determines failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PromptRail user service did not become healthy at ${url}.`);
}

export function macServiceDefinition({ nodePath, proxyPath, logPath, configPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(proxyPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PROMPTRAIL_ROUTER_CONFIG</key>
    <string>${xmlEscape(configPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export function linuxServiceDefinition({ nodePath, proxyPath, logPath, configPath }) {
  return `[Unit]
Description=PromptRail Codex reasoning router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(proxyPath)}
Environment="PROMPTRAIL_ROUTER_CONFIG=${String(configPath).replaceAll('"', '\\"')}"
Restart=on-failure
RestartSec=1
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

export async function installUserService(pluginRoot) {
  const proxyPath = resolve(pluginRoot, "src", "proxy.mjs");
  await readFile(proxyPath, "utf8");
  const values = {
    nodePath: process.execPath,
    proxyPath,
    logPath: join(routerHome(), "proxy.log"),
    configPath: routerConfigPath(),
  };
  await mkdir(routerHome(), { recursive: true, mode: 0o700 });

  if (platform() === "darwin") {
    const path = macServicePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, macServiceDefinition(values), { mode: 0o644 });
    await chmod(path, 0o644);
    const domain = `gui/${process.getuid()}`;
    const serviceTarget = `${domain}/${SERVICE_LABEL}`;
    const bootout = run("launchctl", ["bootout", serviceTarget], { allowFailure: true });
    if (bootout.status === 0) {
      await waitForLaunchdRemoval(serviceTarget);
    }
    run("launchctl", ["bootstrap", domain, path]);
    await waitForRouterHealth();
    return { manager: "launchd", path, label: SERVICE_LABEL };
  }

  if (platform() === "linux") {
    const path = linuxServicePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, linuxServiceDefinition(values), { mode: 0o644 });
    await chmod(path, 0o644);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "promptrail-codex-router.service"]);
    await waitForRouterHealth();
    return { manager: "systemd", path, label: "promptrail-codex-router.service" };
  }

  throw new Error(`Automatic user-service installation is not supported on ${platform()}.`);
}

export async function uninstallUserService() {
  if (platform() === "darwin") {
    const path = macServicePath();
    const domain = `gui/${process.getuid()}`;
    run("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], { allowFailure: true });
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    return;
  }

  if (platform() === "linux") {
    const path = linuxServicePath();
    run("systemctl", ["--user", "disable", "--now", "promptrail-codex-router.service"], {
      allowFailure: true,
    });
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    run("systemctl", ["--user", "daemon-reload"]);
    return;
  }

  throw new Error(`Automatic user-service removal is not supported on ${platform()}.`);
}
