import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGrade,
  effortForGrade,
  extractLatestUserPrompt,
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

test("applies the selected effort without deleting reasoning summary settings", () => {
  const result = applyGrade(
    { model: "gpt-5.6-sol", reasoning: { effort: "medium", summary: "auto" } },
    5,
  );
  assert.deepEqual(result.body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal(result.effort, "xhigh");
});

test("six-level catalog preserves the complete bundled Codex instructions", () => {
  const catalog = buildModelCatalog(
    { models: [{ slug: "gpt-5.5", base_instructions: "full bundled instructions", priority: 7 }] },
    {
      models: [
        {
          slug: "gpt-5.6-sol",
          base_instructions: "untrusted override",
          supported_reasoning_levels: [{ effort: "max" }],
        },
      ],
    },
  );
  assert.equal(catalog.models[0].slug, "gpt-5.6-sol");
  assert.equal(catalog.models[0].base_instructions, "full bundled instructions");
  assert.equal(catalog.models[0].priority, 7);
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [{ effort: "max" }]);
});
