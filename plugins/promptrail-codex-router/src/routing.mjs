export const GRADE_TO_EFFORT = Object.freeze({
  1: "none",
  2: "low",
  3: "medium",
  4: "high",
  5: "xhigh",
  6: "max",
});

export const EFFORT_TO_THINKING_LEVEL = Object.freeze({
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCodexImageEnvelope(text) {
  return text === "</image>" || /^<image(?:\s[^>]*)?>$/.test(text);
}

const NONE_MAX_CHARACTERS = 80;
const NONE_MAX_WORDS = 12;
const NON_TRIVIAL_PROMPT_PATTERN =
  /(?:```|https?:\/\/|(?:^|[\s`"'(])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+|[$>#]\s|(?:^|\s)--[\w-]+|[{}[\]();]|(?:\b(?:add|analy[sz]e|build|change|check|compare|configure|create|debug|deploy|design|edit|explain|find|fix|implement|install|investigate|look up|modify|optimi[sz]e|plan|refactor|research|review|route|run|search|summari[sz]e|test|update|verify|why)\b))/i;

function textFromContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => isObject(part) && (part.type === "input_text" || part.type === "text"))
    .map((part) => String(part.text || "").trim())
    .filter((text) => text && !isCodexImageEnvelope(text))
    .join("\n")
    .trim();
}

function summaryFromContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part) => isObject(part) && part.type === "summary_text")
    .map((part) => String(part.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractLatestUserPrompt(body) {
  if (!isObject(body)) {
    throw new TypeError("Responses request body must be a JSON object.");
  }
  if (typeof body.input === "string" && body.input.trim()) {
    return body.input.trim();
  }
  if (!Array.isArray(body.input)) {
    throw new TypeError("Responses request must include input as a string or array.");
  }

  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index];
    if (!isObject(item) || item.role !== "user") {
      continue;
    }
    const text = textFromContent(item.content);
    if (text) {
      return text;
    }
  }
  throw new TypeError("Responses request does not contain a non-empty user prompt.");
}

export function extractPreviousTurnContext(body) {
  if (!isObject(body) || !Array.isArray(body.input)) {
    return {};
  }

  let currentUserIndex = -1;
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index];
    if (isObject(item) && item.role === "user" && textFromContent(item.content)) {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) {
    return {};
  }

  let previousUserIndex = -1;
  let previousUserPrompt = "";
  for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
    const item = body.input[index];
    if (!isObject(item) || item.role !== "user") {
      continue;
    }
    const text = textFromContent(item.content);
    if (text) {
      previousUserIndex = index;
      previousUserPrompt = text;
      break;
    }
  }
  if (previousUserIndex < 0) {
    return {};
  }

  let previousAssistantSummary = "";
  for (let index = currentUserIndex - 1; index > previousUserIndex; index -= 1) {
    const item = body.input[index];
    if (!isObject(item) || item.role !== "assistant") {
      continue;
    }
    previousAssistantSummary = summaryFromContent(item.content);
    if (previousAssistantSummary) {
      break;
    }
  }

  return {
    previousUserPrompt,
    ...(previousAssistantSummary ? { previousAssistantSummary } : {}),
  };
}

export function isEligibleForNone(prompt) {
  const text = String(prompt || "").trim();
  if (!text || text.length > NONE_MAX_CHARACTERS || text.includes("\n")) {
    return false;
  }
  const words = text.match(/\b[\p{L}\p{N}'-]+\b/gu) || [];
  return words.length <= NONE_MAX_WORDS && !NON_TRIVIAL_PROMPT_PATTERN.test(text);
}

export function normalizeGradeForPrompt(grade, prompt) {
  effortForGrade(grade);
  return grade === 1 && !isEligibleForNone(prompt) ? 2 : grade;
}

export function effortForGrade(grade) {
  if (!Number.isInteger(grade) || !GRADE_TO_EFFORT[grade]) {
    throw new RangeError("PromptRail grader must return an integer grade from 1 through 6.");
  }
  return GRADE_TO_EFFORT[grade];
}

export function thinkingLevelForEffort(effort) {
  const level = EFFORT_TO_THINKING_LEVEL[effort];
  if (!level) {
    throw new RangeError(`Unsupported reasoning effort: ${effort}`);
  }
  return level;
}

export function applyGrade(body, grade) {
  if (!isObject(body)) {
    throw new TypeError("Responses request body must be a JSON object.");
  }
  const effort = effortForGrade(grade);
  const existingReasoning = isObject(body.reasoning) ? body.reasoning : {};
  return {
    body: {
      ...body,
      reasoning: {
        ...existingReasoning,
        effort,
      },
    },
    effort,
  };
}
