export const GRADE_TO_EFFORT = Object.freeze({
  1: "low",
  2: "medium",
  3: "high",
  4: "xhigh",
  5: "max",
});

export const EFFORT_TO_THINKING_LEVEL = Object.freeze({
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
});

const MAX_ASSISTANT_CONTEXT_CHARACTERS = 2_000;
export const FIRST_TURN_USER_CONTEXT = "No previous user prompt; this is the first turn.";
export const FIRST_TURN_ASSISTANT_CONTEXT =
  "No previous assistant response; this is the first turn.";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromUserContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => isObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

function compactAssistantText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ASSISTANT_CONTEXT_CHARACTERS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ASSISTANT_CONTEXT_CHARACTERS - 1).trimEnd()}…`;
}

function textFromAssistantContent(content) {
  if (typeof content === "string") {
    return compactAssistantText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return compactAssistantText(
    content
      .filter(
        (block) =>
          isObject(block) && block.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n"),
  );
}

export function extractLatestUserPrompt(body) {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    throw new TypeError("Anthropic Messages request must include a messages array.");
  }
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!isObject(message) || message.role !== "user") {
      continue;
    }
    const prompt = textFromUserContent(message.content);
    if (prompt) {
      return prompt;
    }
  }
  throw new TypeError("Anthropic Messages request does not contain user text for PromptRail routing.");
}

export function extractPreviousTurnContext(body) {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    return {
      previousUserPrompt: FIRST_TURN_USER_CONTEXT,
      previousAssistantSummary: FIRST_TURN_ASSISTANT_CONTEXT,
    };
  }

  let currentUserIndex = -1;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (isObject(message) && message.role === "user" && textFromUserContent(message.content)) {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) {
    return {
      previousUserPrompt: FIRST_TURN_USER_CONTEXT,
      previousAssistantSummary: FIRST_TURN_ASSISTANT_CONTEXT,
    };
  }

  let previousUserIndex = -1;
  let previousUserPrompt = "";
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!isObject(message) || message.role !== "user") {
      continue;
    }
    const text = textFromUserContent(message.content);
    if (text) {
      previousUserIndex = index;
      previousUserPrompt = text;
      break;
    }
  }
  if (previousUserIndex < 0) {
    return {
      previousUserPrompt: FIRST_TURN_USER_CONTEXT,
      previousAssistantSummary: FIRST_TURN_ASSISTANT_CONTEXT,
    };
  }

  let previousAssistantSummary = "";
  for (let index = currentUserIndex - 1; index > previousUserIndex; index -= 1) {
    const message = body.messages[index];
    if (!isObject(message) || message.role !== "assistant") {
      continue;
    }
    previousAssistantSummary = textFromAssistantContent(message.content);
    if (previousAssistantSummary) {
      break;
    }
  }

  return {
    previousUserPrompt,
    previousAssistantSummary:
      previousAssistantSummary || "The previous assistant response did not include a summary.",
  };
}

export function supportedEffortsForModel(model) {
  const modelId = String(model || "").toLowerCase();
  if (
    /(?:^|[-_/])fable-5(?:$|[-_/])/.test(modelId)
    || /(?:^|[-_/])sonnet-5(?:$|[-_/])/.test(modelId)
    || /(?:^|[-_/])opus-4-[78](?:$|[-_/])/.test(modelId)
  ) {
    return new Set(["low", "medium", "high", "xhigh", "max"]);
  }
  if (/(?:^|[-_/])(?:opus|sonnet)-4-6(?:$|[-_/])/.test(modelId)) {
    return new Set(["low", "medium", "high", "max"]);
  }
  return new Set();
}

export function assertEffortSupported(model, effort) {
  if (!supportedEffortsForModel(model).has(effort)) {
    throw new RangeError(
      `Claude model ${String(model || "<missing>")} does not support PromptRail effort ${effort}.`,
    );
  }
}

export function effortForGrade(grade) {
  if (!Number.isInteger(grade) || !GRADE_TO_EFFORT[grade]) {
    throw new RangeError("PromptRail Claude grader must return an integer grade from 1 through 5.");
  }
  return GRADE_TO_EFFORT[grade];
}

export function thinkingLevelForEffort(effort) {
  const level = EFFORT_TO_THINKING_LEVEL[effort];
  if (!level) {
    throw new RangeError(`Unsupported Claude effort: ${effort}`);
  }
  return level;
}

export function applyGrade(body, grade) {
  if (!isObject(body)) {
    throw new TypeError("Anthropic Messages request body must be a JSON object.");
  }
  const effort = effortForGrade(grade);
  if (!isObject(body.output_config) || typeof body.output_config.effort !== "string") {
    throw new TypeError(
      "Claude Code did not send output_config.effort; update Claude Code and select an effort-capable model.",
    );
  }
  assertEffortSupported(body.model, effort);
  const existingOutputConfig = body.output_config;
  return {
    body: {
      ...body,
      output_config: {
        ...existingOutputConfig,
        effort,
      },
    },
    effort,
  };
}

export function applyRoute(body, route) {
  const model = String(route?.model || "").trim();
  if (!model) {
    throw new TypeError("PromptRail Claude route must include a model.");
  }
  const applied = applyGrade({ ...body, model }, route.grade);
  return {
    body: applied.body,
    effort: applied.effort,
    model,
  };
}
