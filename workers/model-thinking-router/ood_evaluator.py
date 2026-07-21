from __future__ import annotations

import json
import os
import re
import statistics
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from prompt_optimization_article import ARTICLE_TEXT
from prompt_optimization_cases import build_optimization_cases
from quality_eval import BOUNDARY_CASES, QUALITY_CASES


GENERATOR_MODEL = "gpt-5.6-luna"
JUDGE_MODEL = "gpt-5.6-terra"
GENERATOR_EFFORT = "high"
JUDGE_EFFORT = "medium"

CASE_SCHEMA = {
    "type": "object",
    "properties": {
        "cases": {
            "type": "array",
            "minItems": 24,
            "maxItems": 24,
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "style": {"type": "string"},
                    "prompt": {"type": "string"},
                    "previous_user_prompt": {"type": "string"},
                    "previous_assistant_summary": {"type": "string"},
                },
                "required": [
                    "category",
                    "style",
                    "prompt",
                    "previous_user_prompt",
                    "previous_assistant_summary",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["cases"],
    "additionalProperties": False,
}

LABEL_SCHEMA = {
    "type": "object",
    "properties": {
        "difficulty": {"type": "integer", "minimum": 1, "maximum": 3},
        "codex_tier_grades": {
            "type": "array",
            "items": {"type": "integer", "minimum": 1, "maximum": 6},
            "minItems": 3,
            "maxItems": 3,
        },
        "claude_tier_grades": {
            "type": "array",
            "items": {"type": "integer", "minimum": 1, "maximum": 5},
            "minItems": 3,
            "maxItems": 3,
        },
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "rationale": {"type": "string"},
    },
    "required": [
        "difficulty",
        "codex_tier_grades",
        "claude_tier_grades",
        "confidence",
        "rationale",
    ],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class OODCase:
    case_id: str
    category: str
    style: str
    prompt: str
    previous_user_prompt: str
    previous_assistant_summary: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class OODLabel:
    difficulty: int
    codex_tier_grades: tuple[int, int, int]
    claude_tier_grades: tuple[int, int, int]
    confidence: float
    rationale: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "OODLabel":
        return cls(
            difficulty=int(payload["difficulty"]),
            codex_tier_grades=tuple(int(value) for value in payload["codex_tier_grades"]),
            claude_tier_grades=tuple(int(value) for value in payload["claude_tier_grades"]),
            confidence=float(payload["confidence"]),
            rationale=str(payload["rationale"]).strip(),
        )

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["codex_tier_grades"] = list(self.codex_tier_grades)
        payload["claude_tier_grades"] = list(self.claude_tier_grades)
        return payload


class UsageCounter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.values = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

    def record(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        with self._lock:
            for key in self.values:
                self.values[key] += int(getattr(usage, key, 0) or 0)


def _words(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def _jaccard(left: str, right: str) -> float:
    left_words = _words(left)
    right_words = _words(right)
    if not left_words or not right_words:
        return 0.0
    return len(left_words & right_words) / len(left_words | right_words)


def known_prompts() -> tuple[str, ...]:
    prompts = [case.prompt for case in build_optimization_cases()]
    prompts.extend(case.prompt for case in QUALITY_CASES)
    prompts.extend(case.prompt for case in BOUNDARY_CASES)
    return tuple(prompts)


GENERATION_LANES = (
    (
        "non-software and interaction shifts",
        "Create diverse standalone knowledge questions, document/data transformations, customer "
        "operations, scientific or creative tasks, and abrupt topic switches after difficult prior "
        "work. Include terse, informal, multilingual, and highly structured requests.",
    ),
    (
        "unseen implementation ecosystems",
        "Create implementation, testing, and debugging requests in domains unlike ordinary web API "
        "examples: mobile, embedded, build systems, data pipelines, browser extensions, graphics, "
        "infrastructure, accessibility, developer tools, and scientific computing. Mix fixed and "
        "unresolved finish lines.",
    ),
    (
        "open-ended and high-consequence work",
        "Create architecture, incident response, security, formal correctness, migrations, research, "
        "and scattered-context planning requests in novel domains. Include deceptive short prompts "
        "that are hard, long prompts that are mechanical, and follow-ups whose latest intent either "
        "does or does not depend on prior context.",
    ),
)


def generate_candidates(client: Any, usage: UsageCounter) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    for lane_name, lane_instruction in GENERATION_LANES:
        response = client.responses.create(
            model=GENERATOR_MODEL,
            reasoning={"effort": GENERATOR_EFFORT},
            instructions=(
                "Generate a blind routing-evaluation dataset. Do not assign difficulty, model, or "
                "thinking labels. Do not imitate benchmark chestnuts such as CSV parsers, cursor "
                "pagination, lock-free queues, token exchange audits, or Slack-to-migration plans. "
                "Every latest prompt must describe a plausible real user request. Prior context must "
                "sometimes matter and sometimes be a deliberate distraction. Vary length, tone, "
                "domain, stakes, ambiguity, and finish-line clarity."
            ),
            input=f"Lane: {lane_name}\n\n{lane_instruction}\n\nReturn exactly 24 unique cases.",
            text={
                "format": {
                    "type": "json_schema",
                    "name": "ood_cases",
                    "strict": True,
                    "schema": CASE_SCHEMA,
                },
            },
            max_output_tokens=12_000,
            store=False,
        )
        usage.record(response)
        candidates.extend(json.loads(response.output_text)["cases"])
    return candidates


def deduplicate_cases(candidates: list[dict[str, str]], count: int) -> tuple[OODCase, ...]:
    known = list(known_prompts())
    accepted: list[OODCase] = []
    for candidate in candidates:
        prompt = str(candidate["prompt"]).strip()
        if not prompt:
            continue
        comparisons = known + [case.prompt for case in accepted]
        if any(_jaccard(prompt, existing) >= 0.72 for existing in comparisons):
            continue
        accepted.append(
            OODCase(
                case_id=f"ood-{len(accepted) + 1:03d}",
                category=str(candidate["category"]).strip().lower(),
                style=str(candidate["style"]).strip().lower(),
                prompt=prompt,
                previous_user_prompt=(
                    str(candidate["previous_user_prompt"]).strip()
                    or "(no previous user request)"
                ),
                previous_assistant_summary=(
                    str(candidate["previous_assistant_summary"]).strip()
                    or "(no previous assistant summary)"
                ),
            ),
        )
        if len(accepted) == count:
            break
    if len(accepted) < count:
        raise RuntimeError(f"only {len(accepted)} unique OOD cases remained after deduplication")
    return tuple(accepted)


def judge_case(client: Any, usage: UsageCounter, case: OODCase) -> OODLabel:
    instructions = f"""
You are Terra running at medium reasoning. Produce the frozen reference routing labels for a blind
evaluation case. You cannot see and must not speculate about the router's output.

Use the article below as the governing philosophy. Judge only the latest user intent, using prior
context when the latest request depends on it. Model difficulty is 1=Luna/Sonnet, 2=Terra/Fable,
3=Sol/Opus. Codex thinking grades are 1=None, 2=Low, 3=Medium, 4=High, 5=xHigh,
6=Ultra. Claude grades are 1=Low, 2=Medium, 3=High, 4=xHigh, 5=Max.

Independently assign the final thinking grade for each model tier. Do not use arithmetic offsets.
Use the lowest grade that can finish reliably. Maximum effort is rare but appropriate when the
finish line truly requires scattered-context synthesis with open decisions, formal verification,
or exhaustive high-consequence investigation.

ARTICLE:
{ARTICLE_TEXT}
""".strip()
    response = client.responses.create(
        model=JUDGE_MODEL,
        reasoning={"effort": JUDGE_EFFORT},
        instructions=instructions,
        input=json.dumps({"case": case.to_dict()}, separators=(",", ":")),
        text={
            "format": {
                "type": "json_schema",
                "name": "ood_label",
                "strict": True,
                "schema": LABEL_SCHEMA,
            },
        },
        max_output_tokens=900,
        store=False,
    )
    usage.record(response)
    return OODLabel.from_dict(json.loads(response.output_text))


def label_cases(
    client: Any,
    usage: UsageCounter,
    cases: tuple[OODCase, ...],
) -> dict[str, OODLabel]:
    labels: dict[str, OODLabel] = {}
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(judge_case, client, usage, case): case for case in cases}
        for future in as_completed(futures):
            case = futures[future]
            labels[case.case_id] = future.result()
    return labels


def evaluate_router(cases: tuple[OODCase, ...], app_name: str) -> dict[str, dict[str, Any]]:
    from prompt_optimizer import ModalRoutingSystems

    systems = ModalRoutingSystems(app_name=app_name)
    outputs: dict[str, dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(systems.baseline, case): case for case in cases}
        for future in as_completed(futures):
            case = futures[future]
            outputs[case.case_id] = future.result()
    return outputs


def _mean(values: list[float]) -> float:
    return round(statistics.fmean(values), 4) if values else 0.0


def score(
    cases: tuple[OODCase, ...],
    labels: dict[str, OODLabel],
    outputs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for case in cases:
        label = labels[case.case_id]
        output = outputs[case.case_id]
        difficulty = int(output["gemma_difficulty"])
        client_results: dict[str, Any] = {}
        for client_name, expected_grades, output_key in (
            ("codex", label.codex_tier_grades, "arch_codex_tier_grades"),
            ("claude", label.claude_tier_grades, "arch_claude_tier_grades"),
        ):
            predicted_grades = tuple(
                int(output[output_key][str(tier)])
                for tier in (1, 2, 3)
            )
            expected_selected = expected_grades[label.difficulty - 1]
            predicted_at_expected_tier = predicted_grades[label.difficulty - 1]
            predicted_end_to_end = predicted_grades[difficulty - 1]
            distance = predicted_at_expected_tier - expected_selected
            client_results[client_name] = {
                "expected_tier_grades": list(expected_grades),
                "predicted_tier_grades": list(predicted_grades),
                "expected_selected_grade": expected_selected,
                "predicted_at_expected_tier": predicted_at_expected_tier,
                "predicted_end_to_end_grade": predicted_end_to_end,
                "selected_exact": distance == 0,
                "selected_within_one": abs(distance) <= 1,
                "selected_distance": distance,
                "end_to_end_exact": difficulty == label.difficulty
                and predicted_end_to_end == expected_selected,
                "high_risk_underroute": (
                    expected_selected >= (5 if client_name == "codex" else 4)
                    and predicted_at_expected_tier < expected_selected
                ),
            }
        rows.append(
            {
                "case": case.to_dict(),
                "label": label.to_dict(),
                "router": output,
                "model_exact": difficulty == label.difficulty,
                "clients": client_results,
            },
        )

    client_summaries = {}
    for client in ("codex", "claude"):
        values = [row["clients"][client] for row in rows]
        all_tier_distances = []
        all_tier_exact = []
        for row in rows:
            expected = row["clients"][client]["expected_tier_grades"]
            predicted = row["clients"][client]["predicted_tier_grades"]
            all_tier_distances.extend(abs(left - right) for left, right in zip(expected, predicted))
            all_tier_exact.extend(left == right for left, right in zip(expected, predicted))
        client_summaries[client] = {
            "selected_tier_exact": _mean([value["selected_exact"] for value in values]),
            "selected_tier_within_one": _mean(
                [value["selected_within_one"] for value in values],
            ),
            "end_to_end_exact": _mean([value["end_to_end_exact"] for value in values]),
            "selected_mean_absolute_error": _mean(
                [abs(value["selected_distance"]) for value in values],
            ),
            "all_tier_exact": _mean(all_tier_exact),
            "all_tier_mean_absolute_error": _mean(all_tier_distances),
            "selected_underroute_count": sum(value["selected_distance"] < 0 for value in values),
            "selected_overroute_count": sum(value["selected_distance"] > 0 for value in values),
            "high_risk_underroute_count": sum(value["high_risk_underroute"] for value in values),
        }

    category_summary = {}
    for category in sorted({row["case"]["category"] for row in rows}):
        category_rows = [row for row in rows if row["case"]["category"] == category]
        category_summary[category] = {
            "cases": len(category_rows),
            "model_exact": _mean([row["model_exact"] for row in category_rows]),
            "codex_selected_exact": _mean(
                [row["clients"]["codex"]["selected_exact"] for row in category_rows],
            ),
            "claude_selected_exact": _mean(
                [row["clients"]["claude"]["selected_exact"] for row in category_rows],
            ),
        }

    return {
        "model_tier_exact": _mean([row["model_exact"] for row in rows]),
        "clients": client_summaries,
        "categories": category_summary,
        "rows": rows,
    }


def run_blind_ood_eval(*, count: int, app_name: str) -> dict[str, Any]:
    if count < 12 or count > 60:
        raise ValueError("count must be between 12 and 60")
    api_key = os.environ["OPENAI_API_KEY"]
    try:
        from openai import OpenAI
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Blind OOD generation requires the optional openai dependency. "
            "Install requirements-prompt-optimization.txt before running it."
        ) from exc
    client = OpenAI(api_key=api_key)
    usage = UsageCounter()
    candidates = generate_candidates(client, usage)
    cases = deduplicate_cases(candidates, count)

    # Freeze all independent labels before any router output is requested.
    labels = label_cases(client, usage, cases)
    outputs = evaluate_router(cases, app_name)
    scored = score(cases, labels, outputs)
    return {
        "protocol": {
            "blind": True,
            "prompt_frozen_during_evaluation": True,
            "labels_created_before_router_outputs": True,
            "generator_model": GENERATOR_MODEL,
            "generator_reasoning_effort": GENERATOR_EFFORT,
            "judge_model": JUDGE_MODEL,
            "judge_reasoning_effort": JUDGE_EFFORT,
            "dedupe_jaccard_threshold": 0.72,
            "known_case_count": len(known_prompts()),
            "candidate_count": len(candidates),
            "accepted_case_count": len(cases),
            "production_app": app_name,
            "generated_at": datetime.now(UTC).isoformat(),
        },
        "usage": usage.values,
        "scores": {key: value for key, value in scored.items() if key != "rows"},
        "rows": scored["rows"],
    }
