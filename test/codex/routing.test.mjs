import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGrade,
  effortForGrade,
  extractLatestUserPrompt,
  extractPreviousTurnContext,
  extractPreviousTurnContextFromTranscript,
  normalizeGradeForPrompt,
  thinkingLevelForEffort,
} from "../../plugins/promptrail-codex-router/src/routing.mjs";
import { buildModelCatalog } from "../../plugins/promptrail-codex-router/src/config.mjs";

test("maps all six grades to OpenAI reasoning efforts", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(effortForGrade),
    ["none", "low", "medium", "high", "xhigh", "max"],
  );
});

test("rejects grades outside the six-grade contract", () => {
  assert.throws(() => effortForGrade(7), /integer grade from 1 through 6/);
  assert.throws(() => effortForGrade(2.5), /integer grade from 1 through 6/);
});

test("passes every valid router grade through without heuristic calibration", () => {
  for (const grade of [1, 2, 3, 4, 5, 6]) {
    assert.equal(normalizeGradeForPrompt(grade, "Fix the login bug"), grade);
  }
});

test("formats the six visible thinking levels", () => {
  assert.deepEqual(
    ["none", "low", "medium", "high", "xhigh", "max"].map(thinkingLevelForEffort),
    ["None", "Low", "Medium", "High", "Extra High", "Max"],
  );
});

test("extracts only the latest user prompt from a Responses request", () => {
  const prompt = extractLatestUserPrompt({
    input: [
      { role: "developer", content: [{ type: "input_text", text: "secret instructions" }] },
      { role: "user", content: [{ type: "input_text", text: "first request" }] },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "latest request" },
          { type: "input_image", image_url: "data:image/png;base64,ignored" },
        ],
      },
    ],
  });
  assert.equal(prompt, "latest request");
});

test("ignores Codex image envelope text when extracting an attached-image prompt", () => {
  const prompt = extractLatestUserPrompt({
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: '<image name=[Image #1] path="/tmp/dashboard.png">',
          },
          { type: "input_image", image_url: "data:image/png;base64,ignored" },
          { type: "input_text", text: "</image>" },
          {
            type: "input_text",
            text: "[Image #1] fix this display issue in dark mode",
          },
        ],
      },
    ],
  });
  assert.equal(prompt, "[Image #1] fix this display issue in dark mode");
});

test("extracts the previous user prompt and last assistant summary", () => {
  assert.deepEqual(
    extractPreviousTurnContext({
      input: [
        { role: "user", content: [{ type: "input_text", text: "Fix the login bug." }] },
        {
          role: "assistant",
          content: [
            { type: "output_text", text: "Long final answer is not sent." },
            { type: "summary_text", text: "Found a stale session cookie." },
          ],
        },
        { role: "user", content: [{ type: "input_text", text: "Do it." }] },
      ],
    }),
    {
      previousUserPrompt: "Fix the login bug.",
      previousAssistantSummary: "Found a stale session cookie.",
    },
  );
});

test("uses a bounded prior assistant response when no explicit summary exists", () => {
  const context = extractPreviousTurnContext({
    input: [
      { role: "user", content: [{ type: "input_text", text: "Investigate it." }] },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: `  Found the race condition.\n\n${"x".repeat(2_100)}  `,
          },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "Fix it." }] },
    ],
  });

  assert.equal(context.previousUserPrompt, "Investigate it.");
  assert.equal(context.previousAssistantSummary.length, 2_000);
  assert.match(context.previousAssistantSummary, /^Found the race condition\. x+/);
  assert.match(context.previousAssistantSummary, /x…$/);
});

test("supplies explicit context when there is no earlier user turn", () => {
  assert.deepEqual(
    extractPreviousTurnContext({
      input: [{ role: "user", content: [{ type: "input_text", text: "First turn" }] }],
    }),
    {
      previousUserPrompt: "No previous user prompt; this is the first turn.",
      previousAssistantSummary: "No previous assistant response; this is the first turn.",
    },
  );
});

test("extracts the previous turn from a Codex JSONL transcript", () => {
  const transcript = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Fix the race condition." }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Found unsafe shared mutation." }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Do it." }],
      },
    }),
  ].join("\n");

  assert.deepEqual(
    extractPreviousTurnContextFromTranscript(transcript, "Do it."),
    {
      previousUserPrompt: "Fix the race condition.",
      previousAssistantSummary: "Found unsafe shared mutation.",
    },
  );
});

test("applies the selected effort without deleting reasoning summary settings", () => {
  const result = applyGrade(
    { model: "gpt-5.6-sol", reasoning: { effort: "medium", summary: "auto" } },
    5,
  );
  assert.deepEqual(result.body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal(result.effort, "xhigh");
});

test("six-level catalog preserves native models and extends matching entries", () => {
  const catalog = buildModelCatalog(
    {
      refresh_interval: 300,
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "sol instructions",
          priority: 0,
          supported_reasoning_levels: [{ effort: "low" }],
        },
        {
          slug: "gpt-5.6-terra",
          base_instructions: "terra instructions",
          priority: 1,
          supported_reasoning_levels: [{ effort: "max" }],
        },
        {
          slug: "gpt-5.6-luna",
          base_instructions: "luna instructions",
          priority: 2,
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    },
    {
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "untrusted override",
          supported_reasoning_levels: [{ effort: "none" }, { effort: "max" }],
        },
      ],
    },
  );
  assert.equal(catalog.refresh_interval, 300);
  assert.deepEqual(catalog.models.map(({ slug }) => slug), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
  assert.equal(catalog.models[0].base_instructions, "sol instructions");
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [
    { effort: "none" },
    { effort: "max" },
  ]);
  assert.deepEqual(catalog.models[1].supported_reasoning_levels, [{ effort: "max" }]);
  assert.deepEqual(catalog.models[2].supported_reasoning_levels, [{ effort: "high" }]);
});

test("catalog generation rejects an override for an unavailable native model", () => {
  assert.throws(
    () => buildModelCatalog(
      { models: [{ slug: "gpt-5.5", base_instructions: "instructions" }] },
      { models: [{ slug: "gpt-5.6-sol" }] },
    ),
    /does not contain PromptRail model gpt-5\.6-sol/,
  );
});
