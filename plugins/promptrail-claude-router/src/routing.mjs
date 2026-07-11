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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
