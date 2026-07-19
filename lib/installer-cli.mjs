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
  codex: resolve(repositoryRoot, "bin", "promptrail-codex-router.mjs"),
  claude: resolve(repositoryRoot, "bin", "promptrail-claude-router.mjs"),
});

export function usage() {
  return `PromptRail reasoning-effort router

Usage:
  promptrail install <codex|claude> [--token <token>]
  promptrail status <codex|claude>
  promptrail uninstall <codex|claude>

Environment:
  PROMPTRAIL_ACCESS_TOKEN       PromptRail access token
  PROMPTRAIL_ROUTER_TOKEN       Alias for PROMPTRAIL_ACCESS_TOKEN
  PROMPTRAIL_MARKETPLACE_SOURCE Marketplace source override for development
  CODEX_BIN                     Codex CLI override
  CLAUDE_BIN                    Claude Code CLI override
`;
}

export function parseCliArgs(argv) {
  const values = [...argv];
  if (values.length === 0 || values.includes("--help") || values.includes("-h")) {
    return { help: true };
  }
  const command = values.shift();
  const target = values.shift();
  if (!["install", "status", "uninstall"].includes(command)) {
    throw new Error(`Unsupported command: ${command || "<missing>"}.`);
  }
  if (!Object.hasOwn(routerBins, target)) {
    throw new Error(`Target must be codex or claude, received: ${target || "<missing>"}.`);
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
  return { command, target, options };
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
  if (parsed.command === "install") {
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
  if (parsed.command === "install") {
    childEnv.PROMPTRAIL_ROUTER_TOKEN = token;
    childEnv.PROMPTRAIL_GRADER_URL =
      parsed.options.graderUrl || DEFAULT_GRADER_URLS[parsed.target];
  }

  const result = spawn(process.execPath, [routerBins[parsed.target], parsed.command], {
    env: childEnv,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    stderr.write(`PromptRail ${parsed.command} failed for ${parsed.target}.\n`);
    return Number(result.status) || 1;
  }
  return 0;
}
