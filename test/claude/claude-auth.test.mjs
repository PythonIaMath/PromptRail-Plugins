import assert from "node:assert/strict";
import test from "node:test";

import {
  assertClaudeSubscriptionStatus,
  claudeSubscriptionError,
} from "../../lib/claude-auth.mjs";

test("accepts first-party Claude subscription authentication", () => {
  const status = { loggedIn: true, apiProvider: "firstParty", authMethod: "oauth" };
  assert.equal(claudeSubscriptionError(status), null);
  assert.doesNotThrow(() => assertClaudeSubscriptionStatus(status));
});

test("reports unauthenticated Claude as unavailable for optional setup", () => {
  const status = { loggedIn: false, apiProvider: null };
  assert.match(claudeSubscriptionError(status), /not logged in/);
  assert.throws(() => assertClaudeSubscriptionStatus(status), /claude auth login/);
});

test("rejects Claude API authentication", () => {
  const status = { loggedIn: true, apiProvider: "firstParty", authMethod: "apiKey" };
  assert.match(claudeSubscriptionError(status), /API authentication/);
});
