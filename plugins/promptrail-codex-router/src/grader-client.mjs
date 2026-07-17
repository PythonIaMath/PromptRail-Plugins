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
    client: "codex",
    prompt,
    current_model: model,
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
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`PromptRail grader returned HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json();
  const grade = payload?.thinking_grade;
  if (!Number.isInteger(grade) || grade < 1 || grade > 6) {
    throw new RangeError(
      "PromptRail router returned an invalid thinking_grade; expected an integer from 1 through 6.",
    );
  }
  const selectedModel = String(payload?.model || "").trim();
  if (!selectedModel) {
    throw new TypeError("PromptRail router returned an empty model.");
  }
  return {
    grade,
    model: selectedModel,
    difficulty: Number(payload.difficulty || 0),
    latencyMs: Number(payload.latency_ms?.total || 0),
  };
}
