import { loadRouterConfig, routerConfigPath } from "../src/config.mjs";

const config = await loadRouterConfig(routerConfigPath());
const response = await fetch(`http://${config.host}:${config.port}/health`);
if (!response.ok) {
  throw new Error(`PromptRail Claude proxy health check returned HTTP ${response.status}.`);
}
const health = await response.json();
if (health.status !== "ok" || health.mode !== "claude-subscription-only" || health.grades !== 5) {
  throw new Error("PromptRail Claude proxy returned an invalid health response.");
}

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "PromptRail subscription-only effort routing is active with five Claude effort levels.",
    },
  })}\n`,
);
