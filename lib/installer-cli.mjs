import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  promptrail install [plugins] both [--token <token>]
  promptrail install infinite both
  promptrail switch <plugins|infinite> [codex|claude|both]
  promptrail status [plugins|infinite] <codex|claude|both>
  promptrail uninstall [plugins|infinite] <codex|claude|both>

Environment:
  PROMPTRAIL_ACCESS_TOKEN       PromptRail access token
  PROMPTRAIL_ROUTER_TOKEN       Alias for PROMPTRAIL_ACCESS_TOKEN
  PROMPTRAIL_API_KEY            Infinite API key (kept outside project files)
  PROMPTRAIL_INFINITE_BASE_URL  Explicit hosted beta endpoint override (for example https://APP.modal.direct/v1)
  PROMPTRAIL_MARKETPLACE_SOURCE Marketplace source override for development
  CODEX_BIN                     Codex CLI override
  CLAUDE_BIN                    Claude Code CLI override
`;
}

export function parseCliArgs(argv) {
  const values = [...argv];
  if (values.length === 0) {
    return { command: "install", mode: "plugins", target: "both", options: {} };
  }
  if (values.includes("--help") || values.includes("-h")) {
    return { help: true };
  }
  const command = values.shift();
  if (command === "switch") {
    const mode = values.shift();
    const target = values.shift() || "both";
    if (!supportedModes.includes(mode) || !supportedTargets.includes(target) || values.length > 0) {
      throw new Error("Switch requires a mode (plugins or infinite) and an optional target (codex, claude, or both).");
    }
    return { command, mode, target, options: {} };
  }
  if (!["install", "status", "uninstall"].includes(command)) {
    throw new Error(`Unsupported command: ${command || "<missing>"}.`);
  }
  let mode = "plugins";
  if (supportedModes.includes(values[0])) mode = values.shift();
  const target = values.shift() || (command === "install" ? "both" : undefined);
  if (!supportedTargets.includes(target)) {
    throw new Error(`Target must be codex, claude, or both, received: ${target || "<missing>"}.`);
  }
  if (command === "install" && target !== "both") {
    throw new Error("Install both clients with `promptrail install both`.");
  }

  const options = {};
  while (values.length > 0) {
    const flag = values.shift();
    if (flag !== "--token" && flag !== "--grader-url") {
      throw new Error(`Unsupported option: ${flag}.`);
    }
    const value = values.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    options[flag === "--token" ? "token" : "graderUrl"] = value;
  }
  return { command, mode, target, options };
}

export function configuredToken(options, env) {
  return String(
    options.token || env.PROMPTRAIL_ACCESS_TOKEN || env.PROMPTRAIL_ROUTER_TOKEN || "",
  ).trim();
}

export async function readSecret({ input, output }) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "PROMPTRAIL_ACCESS_TOKEN is required when the installer is not running in an interactive terminal.",
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
  if (parsed.command === "install" && parsed.mode === "plugins") {
    token = configuredToken(parsed.options, processEnv);
    if (!token) {
      token = await readSecret({ input: stdin, output: stdout });
    }
  }

  const childEnv = {
    ...processEnv,
    PROMPTRAIL_MARKETPLACE_SOURCE:
      processEnv.PROMPTRAIL_MARKETPLACE_SOURCE || DEFAULT_MARKETPLACE_SOURCE,
  };
  const targets = parsed.target === "both" ? ["codex", "claude"] : [parsed.target];
  const commands = parsed.command === "switch"
    ? ["uninstall", "install"]
    : [parsed.command];
  let exitCode = 0;
  for (const childCommand of commands) {
    const mode = childCommand === "uninstall" && parsed.command === "switch"
      ? (parsed.mode === "plugins" ? "infinite" : "plugins")
      : parsed.mode;
    for (const target of targets) {
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

      const childArgs = [routerBins[mode][target], childCommand];
      // A mode switch may start from a machine where the other mode was never
      // installed. Let the legacy uninstallers distinguish that idempotent
      // case from an explicit uninstall, which still fails closed when plugin
      // state cannot be inspected safely.
      if (parsed.command === "switch" && childCommand === "uninstall") {
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
      }
    }
  }
  return exitCode;
}
