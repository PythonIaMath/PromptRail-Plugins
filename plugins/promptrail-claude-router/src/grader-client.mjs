export async function gradePrompt({
  graderUrl,
  routerToken,
  prompt,
  model,
  previousUserPrompt,
  previousAssistantSummary,
  fetchImpl = fetch,
}) {
  if (!String(previousUserPrompt || "").trim()) {
    throw new TypeError("previousUserPrompt is required.");
  }
  if (!String(previousAssistantSummary || "").trim()) {
    throw new TypeError("previousAssistantSummary is required.");
  }
  const body = {
    client: "claude",
    prompt,
    current_model: String(model || "").trim() || null,
    previous_user_prompt: previousUserPrompt,
    previous_assistant_summary: previousAssistantSummary,
  };
  const response = await fetchImpl(graderUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${routerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `PromptRail Claude grader returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const payload = await response.json();
  const grade = payload?.thinking_grade;
  if (!Number.isInteger(grade) || grade < 1 || grade > 5) {
    throw new RangeError(
      "PromptRail Claude router returned an invalid thinking_grade; expected an integer from 1 through 5.",
    );
  }
  const selectedModel = String(payload?.model || "").trim();
  if (!selectedModel) {
    throw new TypeError("PromptRail Claude router returned an empty model.");
  }
  return {
    grade,
    model: selectedModel,
    difficulty: Number(payload.difficulty || 0),
    latencyMs: Number(payload.latency_ms?.total || 0),
  };
}
