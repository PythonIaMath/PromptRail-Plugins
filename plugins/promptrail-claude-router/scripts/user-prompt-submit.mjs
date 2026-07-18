import { loadRouterConfig, routerConfigPath } from "../src/config.mjs";
import { thinkingLevelForEffort } from "../src/routing.mjs";

async function readHookInput() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
}

async function main() {
  const input = await readHookInput();
  const sessionId = String(input?.session_id || "").trim();
  const prompt = String(input?.prompt || "").trim();
  if (!sessionId || !prompt) {
    throw new TypeError("UserPromptSubmit did not provide a session ID and prompt.");
  }

  const config = await loadRouterConfig(routerConfigPath());
  const response = await fetch(`http://${config.host}:${config.port}/route`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.routerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ sessionId, prompt }),
  });
  if (!response.ok) {
    throw new Error(
      `PromptRail local Claude router returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const route = await response.json();
  const label = `Thinking Level: ${thinkingLevelForEffort(route.effort)}`;
  const selectedModel = String(route.model || "").trim();
  if (!selectedModel) {
    throw new TypeError("PromptRail local Claude router returned an empty model.");
  }
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: `PromptRail: ${selectedModel} | ${label.replace("Thinking Level: ", "")}`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `PromptRail selected ${selectedModel} with ${label.replace("Thinking Level: ", "")} effort for this turn.`,
      },
    })}\n`,
  );
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      decision: "block",
      reason: `Thinking level selection failed: ${error.message}`,
    })}\n`,
  );
});
