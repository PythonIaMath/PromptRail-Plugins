from __future__ import annotations

import json
import math
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
    tier_grades: tuple[int, int, int]
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
        raise RouteValidationError("model selector returned an empty difficulty classification.")

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
        f"model selector returned an invalid difficulty classification: {text[:120]!r}",
    )


def difficulty_token_ids(tokenizer: Any) -> tuple[int, int, int]:
    token_ids: list[int] = []
    for label in ("1", "2", "3"):
        encoded = tokenizer.encode(label, add_special_tokens=False)
        if len(encoded) != 1 or isinstance(encoded[0], bool):
            raise RouteValidationError(
                f"LFM2 difficulty label {label!r} must encode to exactly one token.",
            )
        token_ids.append(int(encoded[0]))

    if len(set(token_ids)) != len(token_ids):
        raise RouteValidationError("LFM2 difficulty labels must use distinct tokens.")
    return tuple(token_ids)


def select_difficulty_from_logits(candidate_logits: Any) -> int:
    try:
        values = [float(value) for value in candidate_logits]
    except (TypeError, ValueError) as error:
        raise RouteValidationError(
            "LFM2 difficulty logits must contain three numeric values.",
        ) from error

    if len(values) != len(DIFFICULTY_LABELS):
        raise RouteValidationError("LFM2 difficulty logits must contain exactly three values.")
    if any(not math.isfinite(value) for value in values):
        raise RouteValidationError("LFM2 difficulty logits must all be finite.")

    return max(range(len(values)), key=lambda index: (values[index], index)) + 1


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


def validate_tier_grades(client: Any, tier_grades: Any) -> tuple[int, int, int]:
    normalized_client = validate_client(client)
    if not isinstance(tier_grades, (tuple, list)) or len(tier_grades) != 3:
        raise RouteValidationError("thinking grader must return exactly three model-tier grades.")
    return tuple(
        validate_thinking_grade(normalized_client, grade)
        for grade in tier_grades
    )


def select_tier_grade(client: Any, difficulty: Any, tier_grades: Any) -> int:
    normalized_client = validate_client(client)
    if isinstance(difficulty, bool) or not isinstance(difficulty, int) or difficulty not in {1, 2, 3}:
        raise RouteValidationError("difficulty must be an integer from 1 through 3.")
    validated = validate_tier_grades(normalized_client, tier_grades)
    return validated[difficulty - 1]


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
    tier_grades = validate_tier_grades(normalized_client, thinking_decision.tier_grades)
    grade = select_tier_grade(normalized_client, difficulty, tier_grades)
    expected_effort = EFFORT_MAP[normalized_client][grade]

    return {
        "client": normalized_client,
        "difficulty": difficulty,
        "difficulty_label": DIFFICULTY_LABELS[difficulty],
        "model": select_model(normalized_client, difficulty, model_map),
        "thinking_grade": grade,
        "effort": expected_effort,
        "thinking_grades_by_tier": {
            str(tier): tier_grades[tier - 1]
            for tier in (1, 2, 3)
        },
        "latency_ms": {
            "model": round(model_decision.latency_ms, 3),
            "thinking": round(thinking_decision.latency_ms, 3),
            "total": round(total_latency_ms, 3),
        },
        "router": {
            "model": "model-family-classifier",
            "thinking": "promptrail-effort-grader",
            "execution": "parallel",
        },
    }


def measure_ms(function: Callable[[], Any]) -> tuple[Any, float]:
    started = time.perf_counter()
    result = function()
    return result, (time.perf_counter() - started) * 1000
