export async function gradePrompt({
  graderUrl,
  routerToken,
  prompt,
  model,
  previousUserPrompt,
  previousAssistantSummary,
  fetchImpl = fetch,
}) {
  const body = { prompt, model };
  if (previousUserPrompt) {
    body.previous_user_prompt = previousUserPrompt;
  }
  if (previousAssistantSummary) {
    body.previous_assistant_summary = previousAssistantSummary;
  }
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
  if (!Number.isInteger(payload?.grade) || payload.grade < 1 || payload.grade > 6) {
    throw new RangeError("PromptRail grader returned an invalid grade; expected an integer from 1 through 6.");
  }
  return {
    grade: payload.grade,
    latencyMs: Number(payload.latency_ms || 0),
  };
}
