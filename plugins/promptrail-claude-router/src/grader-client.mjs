export async function gradePrompt({ graderUrl, routerToken, prompt, fetchImpl = fetch }) {
  const response = await fetchImpl(graderUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${routerToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    throw new Error(
      `PromptRail Claude grader returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const payload = await response.json();
  if (!Number.isInteger(payload.grade) || payload.grade < 1 || payload.grade > 5) {
    throw new RangeError("PromptRail Claude grader returned an invalid grade; expected an integer from 1 through 5.");
  }
  return {
    grade: payload.grade,
    latencyMs: Number(payload.latency_ms || 0),
  };
}
