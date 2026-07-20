export function claudeSubscriptionError(status) {
  if (!status?.loggedIn || status.apiProvider !== "firstParty") {
    return "Claude Code is not logged in to a first-party claude.ai subscription.";
  }
  if (/api/i.test(String(status.authMethod || ""))) {
    return "Claude Code is using API authentication, not a claude.ai subscription.";
  }
  return null;
}

export function assertClaudeSubscriptionStatus(status) {
  const message = claudeSubscriptionError(status);
  if (message) {
    throw new Error(`${message} Run \`claude auth login\` before installing PromptRail.`);
  }
}
