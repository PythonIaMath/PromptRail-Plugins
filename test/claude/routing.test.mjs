import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGrade,
  assertEffortSupported,
  effortForGrade,
  extractLatestUserPrompt,
  supportedEffortsForModel,
  thinkingLevelForEffort,
} from "../../plugins/promptrail-claude-router/src/routing.mjs";

test("maps all five grades to real Claude effort levels", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(effortForGrade),
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("rejects grades outside the five-grade Claude contract", () => {
  assert.throws(() => effortForGrade(0), /integer grade from 1 through 5/);
  assert.throws(() => effortForGrade(6), /integer grade from 1 through 5/);
  assert.throws(() => effortForGrade(2.5), /integer grade from 1 through 5/);
});

test("formats the five visible thinking levels", () => {
  assert.deepEqual(
    ["low", "medium", "high", "xhigh", "max"].map(thinkingLevelForEffort),
    ["Low", "Medium", "High", "Extra High", "Max"],
  );
});

test("extracts only direct text from the latest user-authored message", () => {
  assert.equal(
    extractLatestUserPrompt({
      system: [{ type: "text", text: "private system context" }],
      messages: [
        { role: "user", content: "Earlier request." },
        { role: "assistant", content: [{ type: "text", text: "Working." }] },
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", data: "private-image" } },
            { type: "text", text: "Audit this authorization boundary." },
            { type: "text", text: "Include every access path." },
          ],
        },
      ],
    }),
    "Audit this authorization boundary.\nInclude every access path.",
  );
});

test("skips tool-only user messages when recovering the submitted prompt", () => {
  assert.equal(
    extractLatestUserPrompt({
      messages: [
        { role: "user", content: "Repair the failing checkout flow." },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1" }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "private tool output",
          }],
        },
      ],
    }),
    "Repair the failing checkout flow.",
  );
});

test("rejects fallback routing when no user-authored text is available", () => {
  assert.throws(
    () => extractLatestUserPrompt({
      messages: [{
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private" }],
      }],
    }),
    /does not contain user text/,
  );
});

test("applies effort without deleting structured output configuration", () => {
  const result = applyGrade(
    {
      model: "claude-opus-4-8",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: { type: "object" } },
      },
    },
    4,
  );
  assert.deepEqual(result.body.output_config, {
    effort: "xhigh",
    format: { type: "json_schema", schema: { type: "object" } },
  });
  assert.equal(result.effort, "xhigh");
});

test("models with five-level support accept every routed effort", () => {
  assert.deepEqual(
    [...supportedEffortsForModel("claude-sonnet-5")],
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    [...supportedEffortsForModel("claude-opus-4-8-20260701")],
    ["low", "medium", "high", "xhigh", "max"],
  );
});

test("rejects xhigh on Claude 4.6 instead of silently clamping", () => {
  assert.throws(
    () => assertEffortSupported("claude-sonnet-4-6", "xhigh"),
    /does not support PromptRail effort xhigh/,
  );
  assert.doesNotThrow(() => assertEffortSupported("claude-sonnet-4-6", "max"));
});

test("requires Claude Code to send its native effort capability", () => {
  assert.throws(
    () => applyGrade({ model: "claude-opus-4-8", messages: [] }, 3),
    /did not send output_config\.effort/,
  );
});
