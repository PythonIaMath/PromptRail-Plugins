from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

CLIENTS = frozenset({"codex", "claude"})
DIFFICULTY_LABELS = {
    1: "simple",
    2: "standard",
    3: "complex",
}
DEFAULT_MODEL_MAP = {
    "codex": {
        1: "gpt-5.6-luna",
        2: "gpt-5.6-terra",
        3: "gpt-5.6-sol",
    },
    "claude": {
        1: "claude-sonnet-5",
        2: "claude-fable-5",
        3: "claude-opus-4-8",
    },
}
EFFORT_MAP = {
    "codex": {
        1: "none",
        2: "low",
        3: "medium",
        4: "high",
        5: "xhigh",
        6: "max",
    },
    "claude": {
        1: "low",
        2: "medium",
        3: "high",
        4: "xhigh",
        5: "max",
    },
}

_GRADE_PATTERN = re.compile(r"(?:^|\D)([123])(?:\D|$)")
class RouteValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ModelDecision:
    difficulty: int
    raw_output: str
    latency_ms: float


@dataclass(frozen=True)
class ThinkingDecision:
    grade: int
    effort: str
    latency_ms: float


def validate_client(client: Any) -> str:
    normalized = str(client or "").strip().lower()
    if normalized not in CLIENTS:
        raise RouteValidationError("client must be either 'codex' or 'claude'.")
    return normalized


def validate_prompt(prompt: Any, max_characters: int = 100_000) -> str:
    normalized = str(prompt or "").strip()
    if not normalized:
        raise RouteValidationError("prompt must be a non-empty string.")
    if len(normalized) > max_characters:
        raise RouteValidationError(f"prompt must not exceed {max_characters} characters.")
    return normalized


def validate_conversation_context(
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
) -> tuple[str, str]:
    previous_user = validate_prompt(previous_user_prompt)
    previous_summary = validate_prompt(previous_assistant_summary)
    return previous_user, previous_summary


def conversation_messages(
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
) -> list[dict[str, str]]:
    current = validate_prompt(prompt)
    previous_user, previous_summary = validate_conversation_context(
        previous_user_prompt,
        previous_assistant_summary,
    )
    return [
        {"role": "user", "content": previous_user},
        {"role": "assistant", "content": previous_summary},
        {"role": "user", "content": current},
    ]


def parse_model_list(value: str | None, defaults: dict[int, str]) -> dict[int, str]:
    if not value:
        return dict(defaults)
    models = [item.strip() for item in value.split(",")]
    if len(models) != 3 or any(not item for item in models):
        raise RouteValidationError(
            "model override must contain exactly three comma-separated model IDs.",
        )
    return {index + 1: model for index, model in enumerate(models)}


def parse_difficulty(raw_output: Any) -> int:
    if isinstance(raw_output, int) and raw_output in DIFFICULTY_LABELS:
        return raw_output

    text = str(raw_output or "").strip()
    if not text:
        raise RouteValidationError("LFM2 returned an empty difficulty classification.")

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, dict):
        candidate = parsed.get("difficulty", parsed.get("grade"))
        if isinstance(candidate, int) and candidate in DIFFICULTY_LABELS:
            return candidate
        if isinstance(candidate, str) and candidate.isdigit():
            numeric = int(candidate)
            if numeric in DIFFICULTY_LABELS:
                return numeric

    match = _GRADE_PATTERN.search(text)
    if match:
        return int(match.group(1))

    raise RouteValidationError(
        f"LFM2 returned an invalid difficulty classification: {text[:120]!r}",
    )


def route_codes(client: Any) -> tuple[str, ...]:
    normalized_client = validate_client(client)
    maximum_grade = max(EFFORT_MAP[normalized_client])
    return tuple(
        f"<m{difficulty}t{grade}>"
        for difficulty in DIFFICULTY_LABELS
        for grade in range(1, maximum_grade + 1)
    )


def parse_lfm_route(raw_output: Any, client: Any) -> tuple[int, int]:
    normalized_client = validate_client(client)
    text = str(raw_output or "").strip()
    if text not in route_codes(normalized_client):
        raise RouteValidationError(
            f"LFM2 returned an invalid constrained route: {text[:120]!r}",
        )
    return int(text[2]), int(text[4:-1])


def validate_thinking_grade(client: str, grade: Any) -> int:
    if isinstance(grade, bool) or not isinstance(grade, int) or grade not in EFFORT_MAP[client]:
        maximum = max(EFFORT_MAP[client])
        raise RouteValidationError(
            f"thinking grader must return an integer grade from 1 through {maximum} for {client}.",
        )
    return grade


def select_model(client: str, difficulty: int, model_map: dict[str, dict[int, str]]) -> str:
    validate_client(client)
    if difficulty not in DIFFICULTY_LABELS:
        raise RouteValidationError("difficulty must be an integer from 1 through 3.")
    return model_map[client][difficulty]


def build_route(
    *,
    client: Any,
    prompt: Any,
    model_decision: ModelDecision,
    thinking_decision: ThinkingDecision,
    model_map: dict[str, dict[int, str]],
    total_latency_ms: float,
) -> dict[str, Any]:
    normalized_client = validate_client(client)
    validate_prompt(prompt)
    difficulty = model_decision.difficulty
    grade = validate_thinking_grade(normalized_client, thinking_decision.grade)
    expected_effort = EFFORT_MAP[normalized_client][grade]
    if thinking_decision.effort != expected_effort:
        raise RouteValidationError(
            f"thinking effort {thinking_decision.effort!r} does not match grade {grade}.",
        )

    return {
        "client": normalized_client,
        "difficulty": difficulty,
        "difficulty_label": DIFFICULTY_LABELS[difficulty],
        "model": select_model(normalized_client, difficulty, model_map),
        "thinking_grade": grade,
        "effort": expected_effort,
        "latency_ms": {
            "model": round(model_decision.latency_ms, 3),
            "thinking": round(thinking_decision.latency_ms, 3),
            "total": round(total_latency_ms, 3),
        },
        "router": {
            "model": "lfm2",
            "thinking": "promptrail-effort-grader",
            "execution": "parallel",
        },
    }


def measure_ms(function: Callable[[], Any]) -> tuple[Any, float]:
    started = time.perf_counter()
    result = function()
    return result, (time.perf_counter() - started) * 1000
