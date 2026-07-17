# Co-located Model + Thinking Router

This is the production PromptRail worker for Codex and Claude Code routing.

It co-locates two routing layers on one L4 GPU:

1. LFM2.5-350M selects the model tier: Luna, Terra, or Sol.
2. Arch-Router-1.5B selects the client-specific thinking grade.

Both layers receive the same three-message context: previous user prompt, previous assistant
summary, and current prompt. Sequential same-container execution is the production default because
parallel CUDA execution increased contention and latency.

## Model mappings

| Difficulty | Codex | Claude Code |
| --- | --- | --- |
| 1, simple | Luna | Sonnet |
| 2, standard | Terra | Fable |
| 3, complex | Sol | Opus |

The default model IDs can be overridden with `PROMPTRAIL_CODEX_MODELS` and
`PROMPTRAIL_CLAUDE_MODELS`. Each value is a comma-separated list ordered from simple to complex.

## Local tests

```bash
python3 -m unittest discover -s workers/model-thinking-router/tests -v
```

## Deploy

The worker expects the existing `promptrail-router-service-token` Modal secret to expose
`PROMPTRAIL_ROUTER_TOKEN`.

```bash
modal deploy workers/model-thinking-router/co_located_modal_app.py
```

Benchmark agreement and latency against the production effort graders:

```bash
modal run --write-result /tmp/colocated-benchmark.json \
  workers/model-thinking-router/co_located_modal_app.py::benchmark \
  --endpoint-url "https://<co-located-route-endpoint>.modal.run" \
  --execution sequential \
  --runs 3
```

## Route request

```json
{
  "client": "codex",
  "prompt": "Design and verify a lock-free queue.",
  "previous_user_prompt": "We need a concurrent queue for the scheduler.",
  "previous_assistant_summary": "Outlined the queue requirements and identified linearizability as a constraint.",
  "current_model": "gpt-5.6-sol"
}
```

`previous_user_prompt` and `previous_assistant_summary` are required, non-empty fields. Both
LFM2 and ArchRouter receive the same three-message context: previous user prompt, previous
assistant summary, and current prompt.

The endpoint requires `Authorization: Bearer <PROMPTRAIL_ROUTER_TOKEN>`.

## Latency benchmark

```bash
python3 workers/model-thinking-router/benchmark.py \
  --url "https://<deployment>.modal.run/route" \
  --token "$PROMPTRAIL_ROUTER_TOKEN" \
  --runs 10 \
  --warmup 2
```

The benchmark covers simple, standard, and complex prompts for both clients and prints p50, p95,
mean, min, and max latency.
