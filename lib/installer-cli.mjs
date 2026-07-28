import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { infiniteBaseUrl } from "./codex-config.mjs";
import { fetchInfiniteModelRecords } from "./infinite-model-discovery.mjs";

export const DEFAULT_GRADER_URLS = Object.freeze({
  codex: "https://promptrail--codexandclaudeplugin-colocatedrouterv7-route-v7.modal.run",
  claude: "https://promptrail--codexandclaudeplugin-colocatedrouterv7-route-v7.modal.run",
});

export const DEFAULT_MARKETPLACE_SOURCE = "PythonIaMath/PromptRail-Plugins";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routerBins = Object.freeze({
  plugins: Object.freeze({
    codex: resolve(repositoryRoot, "bin", "promptrail-codex-router.mjs"),
    claude: resolve(repositoryRoot, "bin", "promptrail-claude-router.mjs"),
  }),
  infinite: Object.freeze({
    codex: resolve(repositoryRoot, "bin", "promptrail-infinite-codex.mjs"),
    claude: resolve(repositoryRoot, "bin", "promptrail-infinite-claude.mjs"),
  }),
});
const supportedTargets = Object.freeze(["codex", "claude", "both"]);
const supportedModes = Object.freeze(["plugins", "infinite"]);

export function usage() {
  return `PromptRail reasoning-effort router

Usage:
  promptrail
  promptrail install [infinite] both [--token <token>]
  promptrail install plugins both [--token <token>]
  promptrail switch <plugins|infinite> [codex|claude|both]
  promptrail status [infinite|plugins] <codex|claude|both>
  promptrail uninstall [infinite|plugins] <codex|claude|both>

Environment:
  PROMPTRAIL_ACCESS_TOKEN       PromptRail access token
  PROMPTRAIL_ROUTER_TOKEN       Alias for PROMPTRAIL_ACCESS_TOKEN
  PROMPTRAIL_API_KEY            Infinite API key (kept outside project files)
  PROMPTRAIL_INFINITE_BASE_URL  Explicit hosted endpoint override (for example https://APP.modal.direct/v1)
  PROMPTRAIL_MARKETPLACE_SOURCE Marketplace source override for development
  CODEX_BIN                     Codex CLI override
  CLAUDE_BIN                    Claude Code CLI override
`;
}

export function parseCliArgs(argv) {
  const values = [...argv];
  if (values.length === 0) {
    return { command: "switch", mode: "infinite", target: "both", options: {} };
  }
  if (values.includes("--help") || values.includes("-h")) {
    return { help: true };
  }
  const command = values.shift();
  if (command === "switch") {
    const mode = values.shift();
    const target = values[0] && !values[0].startsWith("--") ? values.shift() : "both";
    if (!supportedModes.includes(mode) || !supportedTargets.includes(target)) {
      throw new Error("Switch requires a mode (plugins or infinite) and an optional target (codex, claude, or both).");
    }
    const options = parseOptions(values);
    return { command, mode, target, options };
  }
  if (!["install", "status", "uninstall"].includes(command)) {
    throw new Error(`Unsupported command: ${command || "<missing>"}.`);
  }
  let mode = command === "install" ? "infinite" : "all";
  if (supportedModes.includes(values[0])) mode = values.shift();
  const target = values.shift() || (command === "install" ? "both" : undefined);
  if (!supportedTargets.includes(target)) {
    throw new Error(`Target must be codex, claude, or both, received: ${target || "<missing>"}.`);
  }
  if (command === "install" && target !== "both") {
    throw new Error("Install both clients with `promptrail install both`.");
  }

  if (command !== "install" && values.length > 0) {
    throw new Error(`${command} does not accept options.`);
  }
  const options = parseOptions(values);
  return { command, mode, target, options };
}

function parseOptions(values) {
  const remaining = [...values];
  const options = {};
  while (remaining.length > 0) {
    const flag = remaining.shift();
    if (flag !== "--token" && flag !== "--grader-url") {
      throw new Error(`Unsupported option: ${flag}.`);
    }
    const value = remaining.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    options[flag === "--token" ? "token" : "graderUrl"] = value;
  }
  return options;
}

export function configuredToken(options, env) {
  return String(
    options.token || env.PROMPTRAIL_ACCESS_TOKEN || env.PROMPTRAIL_ROUTER_TOKEN || "",
  ).trim();
}

export function configuredInfiniteToken(options, env) {
  return String(
    options.token
    || env.PROMPTRAIL_API_KEY
    || env.PROMPTRAIL_ACCESS_TOKEN
    || env.PROMPTRAIL_ROUTER_TOKEN
    || "",
  ).trim();
}

export async function readSecret({ input, output }) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "A PromptRail token or --token is required when the installer is not running in an interactive terminal.",
    );
  }
  output.write("PromptRail access token: ");
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) {
        rejectPromise(error);
      } else if (!value.trim()) {
        rejectPromise(new Error("PromptRail access token cannot be empty."));
      } else {
        resolvePromise(value.trim());
      }
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("PromptRail installation cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    input.on("data", onData);
  });
}

export async function runCli({
  argv,
  env,
  input,
  output,
  errorOutput,
  spawn = spawnSync,
  preflightInfinite = fetchInfiniteModelRecords,
} = {}) {
  const parsed = parseCliArgs(argv ?? process.argv.slice(2));
  const stdout = output ?? process.stdout;
  const stderr = errorOutput ?? process.stderr;
  const processEnv = env ?? process.env;
  const stdin = input ?? process.stdin;

  if (parsed.help) {
    stdout.write(usage());
    return 0;
  }

  let token = "";
  if (["install", "switch"].includes(parsed.command)) {
    token = parsed.mode === "infinite"
      ? configuredInfiniteToken(parsed.options, processEnv)
      : configuredToken(parsed.options, processEnv);
    if (!token) {
      token = await readSecret({ input: stdin, output: stdout });
    }
    if (parsed.mode === "infinite") {
      await preflightInfinite({
        baseUrl: infiniteBaseUrl(processEnv.PROMPTRAIL_INFINITE_BASE_URL ?? null),
        apiKey: token,
      });
    }
  }

  const childEnv = {
    ...processEnv,
    PROMPTRAIL_MARKETPLACE_SOURCE:
      processEnv.PROMPTRAIL_MARKETPLACE_SOURCE || DEFAULT_MARKETPLACE_SOURCE,
  };
  const targets = parsed.target === "both" ? ["codex", "claude"] : [parsed.target];
  const actions = [];
  if (parsed.command === "switch") {
    for (const childCommand of ["uninstall", "install"]) {
      const mode = childCommand === "uninstall"
        ? (parsed.mode === "plugins" ? "infinite" : "plugins")
        : parsed.mode;
      for (const target of targets) actions.push({ childCommand, mode, target });
    }
  } else {
    const modes = parsed.mode === "all" ? ["infinite", "plugins"] : [parsed.mode];
    for (const mode of modes) {
      for (const target of targets) {
        actions.push({ childCommand: parsed.command, mode, target });
      }
    }
  }
  let exitCode = 0;
  for (const { childCommand, mode, target } of actions) {
    const targetEnv = { ...childEnv };
    if (mode === "plugins") {
      delete targetEnv.PROMPTRAIL_API_KEY;
      delete targetEnv.PROMPTRAIL_INFINITE_BASE_URL;
    } else {
      delete targetEnv.PROMPTRAIL_ACCESS_TOKEN;
      delete targetEnv.PROMPTRAIL_ROUTER_TOKEN;
      delete targetEnv.PROMPTRAIL_GRADER_URL;
    }
    if (childCommand === "install" && mode === "plugins") {
      targetEnv.PROMPTRAIL_ROUTER_TOKEN = token;
      targetEnv.PROMPTRAIL_GRADER_URL = parsed.options.graderUrl || DEFAULT_GRADER_URLS[target];
      if (parsed.target === "both") {
        targetEnv.PROMPTRAIL_OPTIONAL_CLIENT = "1";
      }
    }
    if (childCommand === "install" && mode === "infinite") {
      targetEnv.PROMPTRAIL_API_KEY = token;
    }

    const childArgs = [routerBins[mode][target], childCommand];
    // A mode switch may start from a machine where the other mode was never
    // installed. Let the legacy uninstallers distinguish that idempotent
    // case from an explicit uninstall, which still fails closed when plugin
    // state cannot be inspected safely.
    if (
      childCommand === "uninstall"
      && (parsed.command === "switch" || parsed.mode === "all")
      && mode === "plugins"
    ) {
      childArgs.push("--switch-if-installed");
    }
    const result = spawn(process.execPath, childArgs, {
      env: targetEnv,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      stderr.write(`PromptRail ${childCommand} failed for ${mode} ${target}.\n`);
      exitCode = exitCode || Number(result.status) || 1;
      if (parsed.command === "switch" && childCommand === "uninstall") {
        return exitCode;
      }
      if (childCommand === "install") {
        return exitCode;
      }
    }
  }
  return exitCode;
}
