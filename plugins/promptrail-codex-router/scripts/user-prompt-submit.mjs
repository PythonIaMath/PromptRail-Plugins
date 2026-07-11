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
  const prompt = String(input?.prompt || "").trim();
  const model = String(input?.model || "").trim();
  if (!prompt || !model) {
    throw new TypeError("UserPromptSubmit did not provide a prompt and model.");
  }

  const config = await loadRouterConfig(routerConfigPath());
  const response = await fetch(`http://${config.host}:${config.port}/route`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.routerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ prompt, model }),
  });
  if (!response.ok) {
    throw new Error(`PromptRail local router returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const route = await response.json();
  const thinkingLevel = thinkingLevelForEffort(route.effort);
  const label = `Thinking Level: ${thinkingLevel}`;
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: label,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Begin your next user-visible message with exactly "${label}" on its own line, before any other text. Do not add other wording to that line.`,
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
