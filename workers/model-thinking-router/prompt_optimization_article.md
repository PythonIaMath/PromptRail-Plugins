# Codex for moonshots and everything in between

Source supplied by the user: https://x.com/pvncher/status/2077708372363624894

Some missions demand deep planning and coordination. Others are a straight shot. GPT-5.6 offers
three Codex model families. Sol Medium is the default when unsure.

## Where each model shines

Sol handles complex, ambiguous, difficult, or high-value work where deeper investigation and
polish can change the outcome. It connects ideas across a problem, catches easy-to-miss details,
and can avoid expensive wrong turns in hard debugging.

Terra is the pragmatic all-rounder for everyday implementation, testing, and multi-step work that
still requires judgment. It handles ambiguity and context gathering and can coordinate subagents,
but tends to converge on a solid result without pursuing every possible insight. Terra High is
useful when scope is understood but implementation still has meaningful complexity.

Luna is fast and suits clear, well-scoped work, including extraction, classification,
transformation, and structured summaries. It can handle substantial implementation when scope and
expected outcome are clear. Luna xHigh can produce strong results on bounded implementation.

## What Ultra means

Most tasks do not need Ultra. Sol Ultra is for the hardest work, combining maximum reasoning with
proactive multi-agent collaboration. Use it when stakes, ambiguity, or scattered context justify
the added tokens. Planning across Slack, issues, PRs, docs, code, and git history is a good example.
Once scope is defined, implementation can move to Sol Medium or High, Terra High, or Luna xHigh.
Large plans do not automatically require Ultra; Sol Medium can work well with proactive subagents
and clearly divided lanes.

Out of the box, Codex subagents inherit the conversation and use the same model family and
reasoning level as the parent. Those defaults are deliberate. Lighter context-gathering settings
can be customized later while stronger settings remain available for implementation.

## Give Codex a clear finish line

Strong prompts provide a goal, starting context, output boundaries, and a finish line. They give
direction rather than prescribing every step. The model can discover context, follow promising
leads, and resolve ambiguity. Ask for subagents early when the problem spans multiple lanes.

An example Ultra planning request starts from a Slack thread, finds related issues, PRs, docs,
code, and git history, and turns them into a self-contained implementation plan covering scope,
approach, risks, open decisions, and verification. It asks for a reviewable artifact and explicitly
does not implement yet.

## Match effort to the work

Sol Medium is the baseline. Increase reasoning as models get smaller, so work suited to Sol Medium
may call for Terra High or Luna xHigh. Use Sol Ultra for high-stakes work, scattered context, or
problems still taking shape; Terra High for well-scoped implementation with meaningful complexity;
and Luna xHigh for well-scoped implementation where speed matters.

## Router evaluation interpretation

For routing, judge the latest user intent. Earlier difficult context matters only when the latest
request depends on it. A topic switch to a greeting, status check, date question, or short factual
request must not inherit the previous task's difficulty merely because that context is present.
