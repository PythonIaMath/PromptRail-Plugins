import { loadRouterConfig, routerConfigPath } from "../src/config.mjs";

async function isHealthy(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return payload.status === "ok" && payload.mode === "chatgpt-subscription-only";
  } catch {
    return false;
  }
}

const config = await loadRouterConfig(routerConfigPath());
const healthUrl = `http://${config.host}:${config.port}/health`;
if (!(await isHealthy(healthUrl))) {
  throw new Error(
    "PromptRail proxy is not healthy. Repair the user service before Codex can continue.",
  );
}

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "PromptRail subscription-only reasoning routing is active with six grades.",
    },
  })}\n`,
);
