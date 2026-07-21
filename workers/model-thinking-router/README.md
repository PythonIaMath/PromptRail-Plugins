# Model + Thinking Router

This is the production PromptRail worker for Codex and Claude Code routing.

It runs two independent routing layers on separate L4 GPUs:

1. A self-hosted INT4 Gemma 3 12B selector chooses the model tier: Luna, Terra, or Sol.
2. Arch-Router-1.5B selects the client-specific thinking grade for all three model tiers in one
   batched inference.

Both layers receive the previous user prompt, previous assistant summary, and current prompt. The
Gemma selector receives that context as one structured user document and generates the difficulty
inside a JSON output prefix; ArchRouter receives it as a routed conversation. They use independent
GPU workers, so parallel mode can overlap model-family and thinking classification without CUDA
contention.

Parallel split-GPU execution is the production default. Requests may still set
`"execution": "sequential"` explicitly for diagnostics and controlled comparisons.

The selector checkpoint is
`RedHatAI/gemma-3-12b-it-quantized.w4a16`, pinned to revision
`700b3cfd55276c9e404d97680ddd29e4fa18e9f5`. It is a public INT4-weight quantization of
`google/gemma-3-12b-it`, uses BF16 compute, and runs locally through vLLM. No third-party inference
API is used. Gemma remains subject to Google's Gemma Terms of Use.

The model-classifier input is capped at 4,096 tokens for predictable latency. When the rendered
conversation exceeds that budget, the router preserves the system instructions, current request,
and JSON output prefix, then spends the remaining budget on the previous assistant summary and
previous user prompt in that order. Oversized fields retain both their beginning and end.

## Model mappings

| Difficulty | Codex | Claude Code |
| --- | --- | --- |
| 1, simple | Luna | Sonnet |
| 2, standard | Terra | Fable |
| 3, complex | Sol | Opus |

The default model IDs can be overridden with `PROMPTRAIL_CODEX_MODELS` and
`PROMPTRAIL_CLAUDE_MODELS`. Each value is a comma-separated list ordered from simple to complex.
The model router judges ambiguity, stakes, discovery, coordination, and finish-line clarity rather
than prompt length. Clear bounded work can stay on the fast tier even when it is substantial;
everyday multi-step engineering uses the middle tier; open-ended or high-stakes work uses the
strongest tier.

## Model-aware thinking selection

ArchRouter directly predicts the final grade for each model tier. Its three tier-specific prompts
are generated as one GPU batch while Gemma independently selects the model tier on the other L4.
The router then selects the grade at Gemma's tier position. There is no arithmetic adjustment,
clamping, or fixed relationship between the three grades.

The prompt tells ArchRouter which concrete model will execute the request. Smaller models may need
more reasoning for some bounded tasks, but that is a judgment signal rather than a hardcoded offset.
Trivial requests can use the minimum grade on every tier, while hard work may still require deep
reasoning on the strongest tier.

Overrides preserve this behavior by position: ArchRouter grades the first, second, and third
configured model independently and the selected model receives its corresponding grade directly.

## Local tests

```bash
python3 -m unittest discover -s workers/model-thinking-router/tests -v
```

## Deploy

The worker expects these existing Modal secrets:

- `promptrail-router-service-token`, exposing `PROMPTRAIL_ROUTER_TOKEN` for internal requests.
- `lerouter-mongodb`, exposing `MONGODB_URI` for customer token and subscription validation.

```bash
modal run workers/model-thinking-router/co_located_modal_app.py::download_gemma_model
modal deploy workers/model-thinking-router/co_located_modal_app.py
```

The first command downloads the pinned quantized weights into the persistent
`promptrail-gemma-models` Modal volume. The public checkpoint does not require a Hugging Face token.

Benchmark agreement and latency against the production effort graders:

```bash
modal run --write-result /tmp/colocated-benchmark.json \
  workers/model-thinking-router/co_located_modal_app.py::benchmark \
  --endpoint-url "https://<route-endpoint>.modal.run" \
  --execution parallel \
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
Gemma and ArchRouter receive the same three-message context: previous user prompt, previous
assistant summary, and current prompt.

The endpoint requires `Authorization: Bearer <token>`. It accepts the private service token or a
non-revoked PromptRail customer token whose owner has an active or trialing Plugins subscription.

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

## Routing quality evaluation

The quality evaluator scores nine article-derived task archetypes for both clients. It reports model
tier accuracy, acceptable final-effort selection, response-contract validity, overall pass rate,
and wall latency. The access token is read from the environment and is never accepted as a command
argument.

```bash
PROMPTRAIL_ACCESS_TOKEN="..." python3 workers/model-thinking-router/quality_eval.py \
  --url "https://<deployment>.modal.run" \
  --execution parallel
```

Run the same matrix with `--execution sequential` to verify that execution mode does not change
route selection.

Compare Gemma and ArchRouter as direct tier-aware thinking-grade selectors:

```bash
modal run --write-result /tmp/thinking-comparison.json \
  workers/model-thinking-router/co_located_modal_app.py::compare_thinking_routers \
  --suite article
```

Use `--suite boundary` for the twelve-case unseen boundary set. It includes short high-stakes
requests, long mechanical requests, architecture-keyword extraction traps, fixed plans, scoped
debugging, and genuinely open-ended work.

## GEPA prompt optimization

The prompt optimizer uses 200 deterministic routing cases across 20 task archetypes. Each category
has six training examples, two validation examples, and two untouched test examples. The suite
includes explicit context-switch cases so a trivial latest request does not inherit the difficulty
of an unrelated previous task.

Terra at medium reasoning independently labels model difficulty and the final Codex and Claude
thinking grade for each model tier. It receives the supplied
[model-selection article](prompt_optimization_article.md) and the current Gemma and ArchRouter
outputs. Labels and API usage are cached after every case so an interrupted run can
resume without paying to judge completed examples again. GEPA then evolves the Gemma system prompt
and ArchRouter prompt template separately. It gets a default budget of 200 metric calls and eight
reflection proposals per selector.

The optimizer never stores `OPENAI_API_KEY`, never exposes a public prompt-override endpoint, and
never deploys or promotes a candidate automatically. A candidate is marked for review only if
validation accuracy improves while held-out grade accuracy, selected-route accuracy, distance, and
high-risk under-routing do not regress.

```bash
python3 -m pip install -r workers/model-thinking-router/requirements-prompt-optimization.txt

PROMPTRAIL_OPTIMIZER_DEPLOYMENT=1 modal deploy \
  --name PromptRailRouterPromptOptimizer \
  workers/model-thinking-router/co_located_modal_app.py

security add-generic-password -U -a "$USER" -s promptrail-gepa-openai -w
export OPENAI_KEYCHAIN_SERVICE="promptrail-gepa-openai"
export OPENAI_JUDGE_MODEL="gpt-5.6-terra"

python3 workers/model-thinking-router/prompt_optimizer.py \
  --mode all \
  --target both \
  --max-metric-calls 200 \
  --max-candidate-proposals 8
```

Generated datasets, cached judgments, GEPA state, prompts, and reports are written below
`workers/model-thinking-router/optimization_runs/`, which is gitignored. Use `--mode dataset` to
materialize the 200 cases without an API key or Modal connection, and `--mode label` to stop after
the cached Terra judgments. The dedicated optimizer deployment scales both GPU workers to zero when
idle and does not send evaluation traffic to the production router.
