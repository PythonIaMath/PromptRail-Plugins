from __future__ import annotations

import json
import re
from typing import Any

from router_core import RouteValidationError, conversation_messages, validate_client

MODEL_FAMILY_SYSTEM_PROMPT = """
You extract the minimum model family that can finish the latest user request reliably.
Use the supplied conversation context and return exactly one JSON object matching this schema:
{"difficulty": 1 | 2 | 3}

First isolate the latest user request. Earlier turns matter only when that request explicitly
depends on them or cannot be answered correctly without them. If it is a standalone factual
question, acknowledgement, topic change, or superseding request, ignore the difficulty and
unfinished state of prior work. Never inherit a previous task's tier merely because the supplied
summary says that task was difficult, unresolved, high-stakes, or open-ended.

1 = Luna for Codex or Sonnet for Claude. Choose 1 for clear, bounded work with an explicit
outcome and little discovery or coordination: extraction, classification, transformation,
structured summaries, mechanical edits, or contained implementation with a known finish line.
The task may be substantial, but its scope and expected result must already be clear.

2 = Terra for Codex or Fable for Claude. Choose 2 for pragmatic everyday engineering, testing,
debugging, and multi-step implementation where the scope is mostly understood but meaningful
judgment, context gathering, or coordination is still required.

3 = Sol for Codex or Opus for Claude. Choose 3 for ambiguous, difficult, high-value, or
open-ended work where deeper investigation can change the answer: planning from scattered
context, architecture, migrations, security, correctness invariants, hard debugging with many
plausible causes, research, or work that should split across multiple lanes or subagents.

Do not route by prompt length. Prefer 3 when uncertainty comes from ambiguity, stakes, missing
context, or an unclear finish line. Do not choose 3 merely because a request involves multiple
files, debugging, tests, architecture-related vocabulary, or substantial implementation. Those
belong to 2 when the cause, scope, and finish line are already understood.

Apply this decision order:
1. Choose 3 only when important discovery or decisions remain unresolved, several causes or
   approaches are genuinely plausible, the stakes demand deep investigation, or the work must
   synthesize scattered context.
2. Otherwise choose 1 when the work is mechanical or fully specified, including structured data
   extraction, transformation, or an approved implementation whose contract and acceptance tests
   are fixed.
3. Choose 2 for everything else that requires ordinary engineering judgment or coordinated edits.

Boundary examples:
- Extract invoice fields into a specified JSON schema: 1.
- Implement an approved parser with fixed grammar, behavior, and tests: 1.
- Add endpoint pagination, update its query, and add tests: 2.
- Fix a confirmed race across two modules and add a deterministic regression test: 2.
- Diagnose intermittent corruption with several plausible subsystems and no known cause: 3.
- Plan a migration from scattered discussions, code, issues, and history: 3.

Do not solve the task. Return only the JSON object.
""".strip()

MODEL_FAMILY_OUTPUT_PREFIX = '{"difficulty":'
MODEL_FAMILY_MAX_INPUT_TOKENS = 4096
_TRUNCATION_MARKER = "\n...[earlier context truncated]...\n"

ARCH_TASK_INSTRUCTION = """
You select the reasoning effort required by the latest user intent for one specific model tier.
The selected route is used directly. There is no arithmetic calibration after your decision.
You are provided with route descriptions within <routes></routes> XML tags:
<routes>

{routes}

</routes>

<conversation>

{conversation}

</conversation>

<guidance>

{guidance}

</guidance>
"""

ARCH_FORMAT_PROMPT = """
Your task is to decide which route best suits the latest user intent in the
<conversation></conversation> XML tags.

Routing procedure:
1. Identify the latest user request and its actual finish line. Route the work needed to answer
   that request, not the difficulty of the conversation as a whole.
2. Determine whether earlier conversation is necessary to fulfill the latest request:
   - Use prior context only when the latest request explicitly relies on it or cannot be completed
     correctly without it.
   - If the latest request starts a new topic, asks a standalone question, gives a simple social
     response, or explicitly supersedes earlier work, ignore prior task complexity.
   - Do not infer continuing implementation, planning, investigation, or verification merely
     because those appeared earlier in the conversation.
3. Assess the work required using ambiguity, stakes, context dispersion, coordination, technical
   specialization, verification burden, and finish-line clarity—not prompt length or number of
   stated requirements.
4. Analyze every route description and choose the lowest effort that can complete the request
   reliably for the model tier named in the guidance:
   - Choose the minimum route for acknowledgements, simple conversational replies, direct status,
     and standalone factual requests.
   - Choose low effort for clear bounded transformations, extraction, classification, editing, or
     narrowly specified changes with known targets and expected results.
   - Choose moderate effort for routine implementation or testing with a settled contract that
     still requires practical judgment.
   - Escalate only when meaningful uncertainty, difficult debugging, substantial coordination,
     consequential design decisions, specialized correctness, or broad investigation makes deeper
     reasoning materially reduce the risk of a wrong result.
   - Reserve the highest route for rare work with scattered or conflicting sources, major open
     decisions, multiple investigation lanes, formal correctness obligations, or exhaustive
     adversarial verification.
5. Treat clear specifications, known repository context, defined acceptance criteria, and explicit
   verification plans as evidence for lower effort. Do not escalate solely because work is
   multi-step, spans components, or asks for tests.
6. When uncertain between adjacent routes, prefer the lower route unless the higher route is
   necessary to meet the finish line reliably for this model tier.

Respond with only the exact route name in JSON: {"route": "route_name"}.
"""

ARCH_ROUTES_MARKER = "<<PROMPTRAIL_ROUTES>>"
ARCH_CONVERSATION_MARKER = "<<PROMPTRAIL_CONVERSATION>>"
ARCH_GUIDANCE_MARKER = "<<PROMPTRAIL_GUIDANCE>>"
ARCH_OPTIMIZATION_PROMPT = (
    ARCH_TASK_INSTRUCTION.replace("{routes}", ARCH_ROUTES_MARKER)
    .replace("{conversation}", ARCH_CONVERSATION_MARKER)
    .replace("{guidance}", ARCH_GUIDANCE_MARKER)
    + ARCH_FORMAT_PROMPT
)

MODEL_TIER_NAMES = {
    "codex": {1: "Luna", 2: "Terra", 3: "Sol"},
    "claude": {1: "Sonnet", 2: "Fable", 3: "Opus"},
}

EFFORT_GUIDANCE = {
    "codex": (
        "Grade 1 (None) is valid for requests needing no substantive reasoning. Choose the "
        "lowest route whose description can finish reliably. Routes 4 and 5 are for progressively "
        "deeper work. Route 6 is Ultra/max and must remain rare."
    ),
    "claude": (
        "Grade 1 (Low) is valid for trivial and bounded work. Choose the lowest route whose "
        "description can finish reliably. Routes 3 and 4 are for progressively deeper work. "
        "Route 5 is max and must remain rare."
    ),
}


def effort_guidance_for_tier(client: Any, model_tier: Any) -> str:
    normalized_client = validate_client(client)
    if isinstance(model_tier, bool) or not isinstance(model_tier, int) or model_tier not in {1, 2, 3}:
        raise RouteValidationError("model tier must be an integer from 1 through 3.")
    model_name = MODEL_TIER_NAMES[normalized_client][model_tier]
    return (
        f"Grade the effort specifically for model tier {model_tier} ({model_name}). "
        "Return the final grade that should be sent to that model; no later bonus or calibration "
        "will change it. Smaller models can need more reasoning than stronger models for some "
        "bounded work, but this is a judgment signal, not a fixed offset. Trivial requests can "
        "use the minimum grade on every tier, and difficult work can require high effort even on "
        "the strongest tier. "
        + EFFORT_GUIDANCE[normalized_client]
    )

CODEX_ROUTES = [
    {
        "name": "1",
        "description": (
            "None: thanks, greetings, acknowledgements, direct status, or a short factual "
            "definition with no engineering work, investigation, or tool use."
        ),
    },
    {
        "name": "2",
        "description": (
            "Low: one obvious, bounded operation with a fully specified outcome, such as a "
            "rename, formatting change, copy update, extraction, or simple transformation."
        ),
    },
    {
        "name": "3",
        "description": (
            "Medium, the default baseline: a clear meaningful task such as ordinary explanation, "
            "contained implementation, input validation, a feature with tests, or one localized "
            "failure. The goal and finish line are understood."
        ),
    },
    {
        "name": "4",
        "description": (
            "High: well-scoped work with meaningful complexity, judgment, or coordination, such "
            "as multi-file implementation, debugging or refactoring, races, concurrency, or "
            "substantial analysis."
        ),
    },
    {
        "name": "5",
        "description": (
            "xHigh: difficult, ambiguous, or high-stakes work where deep investigation and "
            "polish can change the outcome, including architecture, security or cryptographic "
            "review, distributed systems, migrations, failure modes, or invariant analysis."
        ),
    },
    {
        "name": "6",
        "description": (
            "Ultra/max, used rarely: the hardest high-stakes work with scattered context, major "
            "open decisions, multiple investigation lanes or proactive subagent coordination, "
            "ambiguous failures across several plausible subsystems, exhaustive adversarial "
            "security verification across trust boundaries, extreme formal proof, or memory-model "
            "correctness plus verified implementation. "
            "Do not use for ordinary planning, implementation, or security review."
        ),
    },
]

CLAUDE_ROUTES = [
    {
        "name": "1",
        "description": (
            "Low: thanks, greetings, acknowledgements, direct status, standalone factual "
            "questions, short definitions, or one obvious bounded operation such as a rename, "
            "formatting change, extraction, or simple transformation."
        ),
    },
    {
        "name": "2",
        "description": (
            "Medium, the default baseline: explain an ordinary failure, implement a contained "
            "feature, add tests, or make a clear engineering change with an understood finish "
            "line."
        ),
    },
    {
        "name": "3",
        "description": (
            "High: well-scoped work with meaningful complexity, judgment, or coordination, such "
            "as multi-file debugging, cross-layer refactoring, concurrency, architecture, or "
            "substantial analysis."
        ),
    },
    {
        "name": "4",
        "description": (
            "xHigh: difficult, ambiguous, or high-stakes work where deeper investigation can "
            "change the outcome, including distributed systems, migrations, security or "
            "cryptographic review, serious failure modes, or broad correctness invariants."
        ),
    },
    {
        "name": "5",
        "description": (
            "Max, used rarely: the hardest work with scattered context, major open decisions, "
            "multiple investigation lanes, ambiguous failures across several plausible subsystems, "
            "exhaustive adversarial security verification across trust boundaries, extreme formal "
            "proof, or memory-model reasoning plus verified implementation."
        ),
    },
]

_GRADE_PATTERN = re.compile(r"(?:^|\D)([1-6])(?:\D|$)")
_ROUTE_VALUE_PATTERN = re.compile(
    r'''["']?route["']?\s*:\s*["']?([A-Za-z0-9_-]+)''',
    re.IGNORECASE,
)
_ROUTE_ALIASES = {
    "codex": {"none": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6, "ultra": 6},
    "claude": {"low": 1, "medium": 2, "high": 3, "xhigh": 4, "max": 5},
}


def routes_for_client(client: Any) -> list[dict[str, str]]:
    normalized = validate_client(client)
    return CODEX_ROUTES if normalized == "codex" else CLAUDE_ROUTES


def build_conversation(
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
) -> list[dict[str, str]]:
    return conversation_messages(
        prompt,
        previous_user_prompt,
        previous_assistant_summary,
    )


def model_classifier_messages(
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
    system_prompt: Any = MODEL_FAMILY_SYSTEM_PROMPT,
) -> list[dict[str, str]]:
    normalized_system_prompt = str(system_prompt or "").strip()
    if not normalized_system_prompt:
        raise RouteValidationError("model classifier system prompt must not be empty.")
    conversation = build_conversation(
        prompt,
        previous_user_prompt,
        previous_assistant_summary,
    )
    return [
        {"role": "system", "content": normalized_system_prompt},
        {
            "role": "user",
            "content": json.dumps(
                {"conversation": conversation},
                separators=(",", ":"),
            ),
        },
    ]


def render_model_classifier_input(
    *,
    tokenizer: Any,
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
    system_prompt: Any = MODEL_FAMILY_SYSTEM_PROMPT,
    max_length: int = MODEL_FAMILY_MAX_INPUT_TOKENS,
) -> str:
    if isinstance(max_length, bool) or not isinstance(max_length, int) or max_length < 1:
        raise RouteValidationError("model classifier max_length must be a positive integer.")

    conversation = build_conversation(
        prompt,
        previous_user_prompt,
        previous_assistant_summary,
    )
    previous_user = conversation[0]["content"]
    previous_summary = conversation[1]["content"]
    current = conversation[2]["content"]
    normalized_system_prompt = str(system_prompt or "").strip()
    if not normalized_system_prompt:
        raise RouteValidationError("model classifier system prompt must not be empty.")

    def render(previous_user_text: str, previous_summary_text: str, current_text: str) -> str:
        messages = [
            {"role": "system", "content": normalized_system_prompt},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "conversation": [
                            {"role": "user", "content": previous_user_text},
                            {"role": "assistant", "content": previous_summary_text},
                            {"role": "user", "content": current_text},
                        ],
                    },
                    separators=(",", ":"),
                ),
            },
        ]
        return (
            tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            + MODEL_FAMILY_OUTPUT_PREFIX
        )

    def input_length(rendered: str) -> int:
        encoded = tokenizer(rendered)
        input_ids = encoded["input_ids"]
        if input_ids and isinstance(input_ids[0], list):
            input_ids = input_ids[0]
        return len(input_ids)

    def clipped(text: str, token_limit: int) -> str:
        token_ids = tokenizer.encode(text, add_special_tokens=False)
        if len(token_ids) <= token_limit:
            return text
        if token_limit <= 0:
            return ""
        marker_ids = tokenizer.encode(_TRUNCATION_MARKER, add_special_tokens=False)
        if token_limit <= len(marker_ids) + 2:
            return tokenizer.decode(token_ids[:token_limit], skip_special_tokens=True)
        content_limit = token_limit - len(marker_ids)
        head_length = (content_limit + 1) // 2
        tail_length = content_limit // 2
        return (
            tokenizer.decode(token_ids[:head_length], skip_special_tokens=True)
            + _TRUNCATION_MARKER
            + tokenizer.decode(token_ids[-tail_length:], skip_special_tokens=True)
        )

    def fit_field(
        source: str,
        build: Any,
    ) -> str:
        source_tokens = tokenizer.encode(source, add_special_tokens=False)
        low = 0
        high = len(source_tokens)
        best = ""
        while low <= high:
            midpoint = (low + high) // 2
            candidate = clipped(source, midpoint)
            if input_length(build(candidate)) <= max_length:
                best = candidate
                low = midpoint + 1
            else:
                high = midpoint - 1
        return best

    full = render(previous_user, previous_summary, current)
    if input_length(full) <= max_length:
        return full

    fixed_overhead = render("", "", "")
    if input_length(fixed_overhead) >= max_length:
        raise RouteValidationError(
            "model classifier instructions exceed the configured input-token budget.",
        )

    fitted_current = fit_field(
        current,
        lambda candidate: render("", "", candidate),
    )
    if not fitted_current:
        raise RouteValidationError(
            "model classifier input-token budget cannot preserve the current request.",
        )

    fitted_summary = fit_field(
        previous_summary,
        lambda candidate: render("", candidate, fitted_current),
    )
    fitted_previous_user = fit_field(
        previous_user,
        lambda candidate: render(candidate, fitted_summary, fitted_current),
    )
    rendered = render(fitted_previous_user, fitted_summary, fitted_current)
    if input_length(rendered) > max_length:
        raise RouteValidationError("model classifier input exceeded its token budget.")
    return rendered


def format_arch_prompt(
    *,
    client: Any,
    model_tier: int,
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
    prompt_template: Any = ARCH_OPTIMIZATION_PROMPT,
) -> str:
    normalized_client = validate_client(client)
    routes = routes_for_client(normalized_client)
    conversation = build_conversation(
        prompt,
        previous_user_prompt,
        previous_assistant_summary,
    )
    template_text = str(prompt_template or "")
    if not template_text.strip():
        raise RouteValidationError("ArchRouter prompt template must not be empty.")
    required_markers = (
        ARCH_ROUTES_MARKER,
        ARCH_CONVERSATION_MARKER,
        ARCH_GUIDANCE_MARKER,
    )
    missing = [marker for marker in required_markers if template_text.count(marker) != 1]
    if missing:
        raise RouteValidationError(
            "ArchRouter prompt template must contain each protected input marker exactly once: "
            + ", ".join(missing),
        )
    return (
        template_text.replace(
            ARCH_ROUTES_MARKER,
            json.dumps(routes, separators=(",", ":")),
        )
        .replace(
            ARCH_CONVERSATION_MARKER,
            json.dumps(conversation, separators=(",", ":")),
        )
        .replace(
            ARCH_GUIDANCE_MARKER,
            effort_guidance_for_tier(normalized_client, model_tier),
        )
    )


def format_arch_prompts(
    *,
    client: Any,
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
    prompt_template: Any = ARCH_OPTIMIZATION_PROMPT,
) -> tuple[str, str, str]:
    return tuple(
        format_arch_prompt(
            client=client,
            model_tier=model_tier,
            prompt=prompt,
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
            prompt_template=prompt_template,
        )
        for model_tier in (1, 2, 3)
    )


def parse_arch_grade(raw_output: Any, client: Any) -> int:
    normalized_client = validate_client(client)
    maximum = 6 if normalized_client == "codex" else 5
    text = str(raw_output or "").strip()
    if not text:
        raise RouteValidationError("ArchRouter returned an empty route.")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        route = payload.get("route")
        if isinstance(route, int):
            grade = route
        elif isinstance(route, str) and route.strip().isdigit():
            grade = int(route.strip())
        else:
            grade = 0
        if 1 <= grade <= maximum:
            return grade

    route_match = _ROUTE_VALUE_PATTERN.search(text)
    if route_match:
        route_value = route_match.group(1).strip().lower().replace("-", "")
        if route_value.isdigit():
            grade = int(route_value)
        else:
            grade = _ROUTE_ALIASES[normalized_client].get(route_value, 0)
        if 1 <= grade <= maximum:
            return grade

    match = _GRADE_PATTERN.search(text)
    if match:
        grade = int(match.group(1))
        if 1 <= grade <= maximum:
            return grade
    raise RouteValidationError(
        f"ArchRouter returned an invalid {normalized_client} route: {text[:120]!r}",
    )
