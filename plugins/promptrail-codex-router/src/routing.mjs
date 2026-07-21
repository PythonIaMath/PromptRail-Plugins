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

const MAX_ASSISTANT_CONTEXT_CHARACTERS = 2_000;
export const FIRST_TURN_USER_CONTEXT = "No previous user prompt; this is the first turn.";
export const FIRST_TURN_ASSISTANT_CONTEXT =
  "No previous assistant response; this is the first turn.";
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

function compactAssistantText(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ASSISTANT_CONTEXT_CHARACTERS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ASSISTANT_CONTEXT_CHARACTERS - 1).trimEnd()}…`;
}

function assistantContextFromContent(content) {
  const explicitSummary = summaryFromContent(content);
  if (explicitSummary) {
    return compactAssistantText(explicitSummary);
  }
  if (typeof content === "string") {
    return compactAssistantText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return compactAssistantText(
    content
      .filter(
        (part) =>
          isObject(part) &&
          (part.type === "output_text" || part.type === "text"),
      )
      .map((part) => String(part.text || "").trim())
      .filter(Boolean)
      .join("\n"),
  );
}

function transcriptItem(record) {
  if (!isObject(record)) {
    return null;
  }
  if (record.type === "response_item" && isObject(record.payload)) {
    return record.payload;
  }
  if (isObject(record.payload) && isObject(record.payload.payload)) {
    return record.payload.payload;
  }
  return null;
}

function transcriptText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part) =>
        isObject(part) &&
        (part.type === "input_text" ||
          part.type === "text" ||
          part.type === "output_text" ||
          part.type === "summary_text"),
    )
    .map((part) => String(part.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractPreviousTurnContextFromTranscript(
  transcriptJsonl,
  currentPrompt,
) {
  const records = [];
  for (const line of String(transcriptJsonl || "").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = transcriptItem(JSON.parse(line));
      if (item?.role === "user" || item?.role === "assistant") {
        const text =
          item.role === "assistant"
            ? assistantContextFromContent(item.content)
            : transcriptText(item.content);
        if (text) {
          records.push({ role: item.role, text });
        }
      }
    } catch {
      // Ignore non-JSON or malformed transcript lines.
    }
  }

  const current = String(currentPrompt || "").trim();
  let currentIndex = records.length;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].role === "user" && records[index].text === current) {
      currentIndex = index;
      break;
    }
  }

  let previousUserIndex = -1;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (records[index].role === "user") {
      previousUserIndex = index;
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
  for (let index = currentIndex - 1; index > previousUserIndex; index -= 1) {
    if (records[index].role === "assistant") {
      previousAssistantSummary = records[index].text;
      if (previousAssistantSummary) {
        break;
      }
    }
  }
  return {
    previousUserPrompt: records[previousUserIndex].text,
    previousAssistantSummary:
      previousAssistantSummary || "The previous assistant response did not include a summary.",
  };
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
    return {
      previousUserPrompt: FIRST_TURN_USER_CONTEXT,
      previousAssistantSummary: FIRST_TURN_ASSISTANT_CONTEXT,
    };
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
    return {
      previousUserPrompt: FIRST_TURN_USER_CONTEXT,
      previousAssistantSummary: FIRST_TURN_ASSISTANT_CONTEXT,
    };
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
    return {
      previousUserPrompt: FIRST_TURN_USER_CONTEXT,
      previousAssistantSummary: FIRST_TURN_ASSISTANT_CONTEXT,
    };
  }

  let previousAssistantSummary = "";
  for (let index = currentUserIndex - 1; index > previousUserIndex; index -= 1) {
    const item = body.input[index];
    if (!isObject(item) || item.role !== "assistant") {
      continue;
    }
    previousAssistantSummary = assistantContextFromContent(item.content);
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

export function normalizeGradeForPrompt(grade) {
  effortForGrade(grade);
  return grade;
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

export function applyRoute(body, route) {
  const applied = applyGrade(body, route.grade);
  const model = String(route.model || "").trim();
  if (!model) {
    throw new TypeError("PromptRail route must include a model.");
  }
  return {
    body: {
      ...applied.body,
      model,
    },
    effort: applied.effort,
    model,
  };
}
