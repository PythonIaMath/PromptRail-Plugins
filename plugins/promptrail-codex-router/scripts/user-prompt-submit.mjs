import { loadRouterConfig, routerConfigPath } from "../src/config.mjs";
import { readFile } from "node:fs/promises";
import {
  extractPreviousTurnContextFromTranscript,
  fallbackRoute,
  FIRST_TURN_ASSISTANT_CONTEXT,
  FIRST_TURN_USER_CONTEXT,
} from "../src/routing.mjs";

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

  let previousUserPrompt = String(input?.previous_user_prompt || "").trim();
  let previousAssistantSummary = String(input?.previous_assistant_summary || "").trim();
  const transcriptPath = String(input?.transcript_path || "").trim();
  if ((!previousUserPrompt || !previousAssistantSummary) && transcriptPath) {
    try {
      const transcript = await readFile(transcriptPath, "utf8");
      const context = extractPreviousTurnContextFromTranscript(transcript, prompt);
      previousUserPrompt ||= context.previousUserPrompt;
      previousAssistantSummary ||= context.previousAssistantSummary;
    } catch {
      // Use explicit first-turn context when the transcript is unavailable.
    }
  }
  previousUserPrompt ||= FIRST_TURN_USER_CONTEXT;
  previousAssistantSummary ||= FIRST_TURN_ASSISTANT_CONTEXT;

  const config = await loadRouterConfig(routerConfigPath());
  const response = await fetch(`http://${config.host}:${config.port}/route`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.routerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      prompt,
      model,
      previous_user_prompt: previousUserPrompt,
      previous_assistant_summary: previousAssistantSummary,
    }),
  });
  if (!response.ok) {
    throw new Error(`PromptRail local router returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const route = await response.json();
  const selectedModel = String(route?.model || "").trim();
  const selectedEffort = String(route?.effort || "").trim();
  if (!selectedModel || !selectedEffort) {
    throw new TypeError("PromptRail local router returned an invalid route.");
  }
  const status = `Model_Selected: ${selectedModel} | Thinking_Level: ${selectedEffort}`;
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: status,
    },
  };
  if (route.warning) {
    output.systemMessage = String(route.warning);
  }
  process.stdout.write(
    `${JSON.stringify(output)}\n`,
  );
}

main().catch((error) => {
  const route = fallbackRoute(error);
  const status = `Model_Selected: ${route.model} | Thinking_Level: ${route.effort}`;
  process.stdout.write(
    `${JSON.stringify({
      continue: true,
      systemMessage: route.warning,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: status,
      },
    })}\n`,
  );
});
