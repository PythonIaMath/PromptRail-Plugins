import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGrade,
  assertEffortSupported,
  effortForGrade,
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
