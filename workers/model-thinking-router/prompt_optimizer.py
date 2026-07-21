from __future__ import annotations

import argparse
import getpass
import json
import os
import pathlib
import statistics
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Callable

from co_located_core import ARCH_OPTIMIZATION_PROMPT, MODEL_FAMILY_SYSTEM_PROMPT
from prompt_optimization_cases import OptimizationCase, build_optimization_cases, split_optimization_cases


ROOT = pathlib.Path(__file__).resolve().parent
ARTICLE_PATH = ROOT / "prompt_optimization_article.md"
DEFAULT_JUDGE_MODEL = "gpt-5.6-terra"
DEFAULT_APP_NAME = "PromptRailRouterPromptOptimizer"

JUDGMENT_SCHEMA = {
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
        "gemma_feedback": {"type": "string"},
        "arch_feedback": {"type": "string"},
    },
    "required": [
        "difficulty",
        "codex_tier_grades",
        "claude_tier_grades",
        "confidence",
        "rationale",
        "gemma_feedback",
        "arch_feedback",
    ],
    "additionalProperties": False,
}


def resolve_api_key(
    *,
    api_key: str | None = None,
    keychain_service: str | None = None,
) -> str:
    resolved = (api_key or os.environ.get("OPENAI_API_KEY", "")).strip()
    if resolved:
        return resolved
    service = (keychain_service or os.environ.get("OPENAI_KEYCHAIN_SERVICE", "")).strip()
    if service:
        if sys.platform != "darwin":
            raise RuntimeError("macOS Keychain lookup is available only on Darwin")
        result = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-a",
                getpass.getuser(),
                "-s",
                service,
                "-w",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            raise RuntimeError(f"OpenAI API key was not found in Keychain service {service!r}")
        return result.stdout.strip()
    raise RuntimeError(
        "OPENAI_API_KEY or OPENAI_KEYCHAIN_SERVICE is required; the optimizer never reads a key from the repository.",
    )


@dataclass(frozen=True)
class RoutingJudgment:
    difficulty: int
    codex_tier_grades: tuple[int, int, int]
    claude_tier_grades: tuple[int, int, int]
    confidence: float
    rationale: str
    gemma_feedback: str
    arch_feedback: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RoutingJudgment:
        judgment = cls(
            difficulty=int(payload["difficulty"]),
            codex_tier_grades=tuple(int(value) for value in payload["codex_tier_grades"]),
            claude_tier_grades=tuple(int(value) for value in payload["claude_tier_grades"]),
            confidence=float(payload["confidence"]),
            rationale=str(payload["rationale"]).strip(),
            gemma_feedback=str(payload["gemma_feedback"]).strip(),
            arch_feedback=str(payload["arch_feedback"]).strip(),
        )
        if judgment.difficulty not in {1, 2, 3}:
            raise ValueError("judge difficulty must be 1, 2, or 3")
        if len(judgment.codex_tier_grades) != 3 or any(
            grade not in range(1, 7) for grade in judgment.codex_tier_grades
        ):
            raise ValueError("judge Codex tier grades must contain three values from 1 through 6")
        if len(judgment.claude_tier_grades) != 3 or any(
            grade not in range(1, 6) for grade in judgment.claude_tier_grades
        ):
            raise ValueError("judge Claude tier grades must contain three values from 1 through 5")
        if not 0 <= judgment.confidence <= 1:
            raise ValueError("judge confidence must be between zero and one")
        return judgment


class TerraJudge:
    def __init__(
        self,
        *,
        model: str = DEFAULT_JUDGE_MODEL,
        api_key: str | None = None,
        client: Any | None = None,
    ) -> None:
        if client is None:
            from openai import OpenAI

            resolved_key = resolve_api_key(api_key=api_key)
            client = OpenAI(api_key=resolved_key)
        self.model = model
        self.client = client
        self.article = ARTICLE_PATH.read_text()
        self._usage_lock = threading.Lock()
        self.usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

    def _record_usage(self, response: Any) -> None:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        values = {
            "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
            "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
            "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
        }
        with self._usage_lock:
            for key, value in values.items():
                self.usage[key] += value

    def probe(self) -> None:
        response = self.client.responses.create(
            model=self.model,
            reasoning={"effort": "medium"},
            input="Return exactly the word READY.",
            max_output_tokens=128,
            store=False,
        )
        self._record_usage(response)
        if response.output_text.strip() != "READY":
            raise RuntimeError(f"judge probe returned an unexpected response: {response.output_text[:80]!r}")

    def judge(self, case: OptimizationCase, baseline: dict[str, Any]) -> RoutingJudgment:
        instructions = f"""
You are Terra running at medium reasoning. Act as the independent routing-quality judge.

Use the supplied article as the governing model-selection philosophy. Judge the latest user intent,
using previous context only when the latest request depends on it. First decide your own correct
labels, then compare them with the system outputs. Do not copy the system merely because it sounds
plausible.

Model difficulty is 1=Luna/Sonnet, 2=Terra/Fable, 3=Sol/Opus.
Codex: 1=None, 2=Low, 3=Medium, 4=High, 5=xHigh, 6=Ultra/max.
Claude: 1=Low, 2=Medium, 3=High, 4=xHigh, 5=Max.

Independently choose the final thinking grade for each of the three Codex model tiers and each of
the three Claude model tiers. The arrays are ordered from tier 1 through tier 3. These grades are
used directly; there is no later arithmetic bonus. Smaller models can need more reasoning for some
tasks, but do not apply a fixed offset. Trivial requests can use the minimum on every tier.

Use the lowest grade that can finish reliably. Ultra/max must be rare. A short standalone status,
date, acknowledgement, or factual question should not inherit a difficult previous task after a
clear topic switch. Provide concise actionable feedback for improving each selector prompt, with
no case-specific hardcoded phrase rules.

ARTICLE:
{self.article}
""".strip()
        payload = {
            "case": case.to_dict(),
            "system_outputs": baseline,
        }
        response = self.client.responses.create(
            model=self.model,
            reasoning={"effort": "medium"},
            instructions=instructions,
            input=json.dumps(payload, separators=(",", ":")),
            text={
                "format": {
                    "type": "json_schema",
                    "name": "routing_judgment",
                    "strict": True,
                    "schema": JUDGMENT_SCHEMA,
                },
            },
            max_output_tokens=1200,
            store=False,
        )
        self._record_usage(response)
        return RoutingJudgment.from_dict(json.loads(response.output_text))

    def reflect(self, gepa_prompt: str) -> str:
        response = self.client.responses.create(
            model=self.model,
            reasoning={"effort": "medium"},
            instructions=(
                "You are Terra Medium improving a routing prompt through GEPA reflection. "
                "Use the article below as the routing philosophy. Generalize from the failures; "
                "never add exact-phrase exceptions, case IDs, or dataset-specific hardcoded rules. "
                "Preserve required output schemas and protected input markers exactly. Return only "
                "the complete revised prompt artifact.\n\n" + self.article
            ),
            input=gepa_prompt,
            max_output_tokens=5000,
            store=False,
        )
        self._record_usage(response)
        return response.output_text.strip()


class ModalRoutingSystems:
    def __init__(self, *, app_name: str = DEFAULT_APP_NAME) -> None:
        import modal

        self.gemma = modal.Cls.from_name(app_name, "GemmaModelSelector")()
        self.arch = modal.Cls.from_name(app_name, "CoLocatedRouterV7")()

    def baseline(self, case: OptimizationCase) -> dict[str, Any]:
        with ThreadPoolExecutor(max_workers=3) as executor:
            gemma_future = executor.submit(
                self.gemma.classify.remote,
                case.prompt,
                case.previous_user_prompt,
                case.previous_assistant_summary,
            )
            codex_future = executor.submit(
                self.arch.classify_thinking_only.remote,
                "codex",
                case.prompt,
                case.previous_user_prompt,
                case.previous_assistant_summary,
            )
            claude_future = executor.submit(
                self.arch.classify_thinking_only.remote,
                "claude",
                case.prompt,
                case.previous_user_prompt,
                case.previous_assistant_summary,
            )
            return {
                "gemma_difficulty": int(gemma_future.result()["difficulty"]),
                "arch_codex_tier_grades": codex_future.result()["tier_grades"],
                "arch_claude_tier_grades": claude_future.result()["tier_grades"],
            }

    def evaluate_gemma(self, prompt: str, example: dict[str, Any]) -> int:
        result = self.gemma.evaluate_system_prompt.remote(
            prompt,
            example["prompt"],
            example["previous_user_prompt"],
            example["previous_assistant_summary"],
        )
        return int(result["difficulty"])

    def evaluate_arch(self, prompt: str, example: dict[str, Any]) -> dict[str, dict[str, int]]:
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {
                client: executor.submit(
                    self.arch.evaluate_thinking_prompt.remote,
                    prompt,
                    client,
                    example["prompt"],
                    example["previous_user_prompt"],
                    example["previous_assistant_summary"],
                )
                for client in ("codex", "claude")
            }
            return {
                client: {
                    str(tier): int(future.result()["tier_grades"][str(tier)])
                    for tier in (1, 2, 3)
                }
                for client, future in futures.items()
            }


def write_json(path: pathlib.Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n")
    temporary.replace(path)


def load_label_cache(path: pathlib.Path) -> dict[str, Any]:
    if not path.exists():
        return {"metadata": {}, "cases": {}}
    payload = json.loads(path.read_text())
    if not isinstance(payload.get("cases"), dict):
        raise ValueError("label cache must contain a cases object")
    return payload


def label_cases(
    *,
    cases: tuple[OptimizationCase, ...],
    systems: ModalRoutingSystems,
    judge: TerraJudge,
    cache_path: pathlib.Path,
) -> dict[str, Any]:
    cache = load_label_cache(cache_path)
    cache["metadata"] = {
        "judge_model": judge.model,
        "judge_reasoning_effort": "medium",
        "article_source": "https://x.com/pvncher/status/2077708372363624894",
        "case_count": len(cases),
        "updated_at": datetime.now(UTC).isoformat(),
    }
    for index, case in enumerate(cases, start=1):
        cached = cache["cases"].get(case.case_id, {})
        baseline = cached.get("baseline")
        if not baseline:
            baseline = systems.baseline(case)
            cache["cases"][case.case_id] = {
                "case": case.to_dict(),
                "baseline": baseline,
            }
            write_json(cache_path, cache)
        judgment_payload = cached.get("judgment")
        if judgment_payload:
            RoutingJudgment.from_dict(judgment_payload)
        else:
            judgment_payload = asdict(judge.judge(case, baseline))
        cache["cases"][case.case_id] = {
            "case": case.to_dict(),
            "baseline": baseline,
            "judgment": judgment_payload,
        }
        cache["metadata"]["completed"] = index
        cache["metadata"]["judge_usage"] = dict(judge.usage)
        write_json(cache_path, cache)
    return cache


def labeled_examples(
    labels: dict[str, Any],
    cases: tuple[OptimizationCase, ...],
) -> list[dict[str, Any]]:
    examples = []
    for case in cases:
        entry = labels["cases"].get(case.case_id)
        if not entry:
            raise ValueError(f"missing judge label for {case.case_id}")
        judgment = RoutingJudgment.from_dict(entry["judgment"])
        examples.append({**case.to_dict(), "judgment": asdict(judgment)})
    return examples


def proximity_score(actual: int, expected: int) -> float:
    distance = abs(actual - expected)
    return 1.0 if distance == 0 else 0.5 if distance == 1 else 0.0


def build_evaluator(
    *, target: str,
    systems: ModalRoutingSystems,
) -> Callable[[dict[str, str], dict[str, Any]], float]:
    import gepa.optimize_anything as oa

    def evaluator(candidate: dict[str, str], example: dict[str, Any]) -> float:
        prompt = str(candidate.get("prompt", ""))
        judgment = example["judgment"]
        try:
            if target == "gemma":
                actual = systems.evaluate_gemma(prompt, example)
                expected = int(judgment["difficulty"])
                score = proximity_score(actual, expected)
                oa.log(
                    f"Case {example['case_id']} ({example['category']}): Gemma returned {actual}; "
                    f"Terra expected {expected}. Rationale: {judgment['rationale']} "
                    f"Prompt feedback: {judgment['gemma_feedback']}",
                )
                return score

            actual = systems.evaluate_arch(prompt, example)
            expected = {
                "codex": judgment["codex_tier_grades"],
                "claude": judgment["claude_tier_grades"],
            }
            score = statistics.fmean(
                proximity_score(actual[client][str(tier)], int(expected[client][tier - 1]))
                for client in ("codex", "claude")
                for tier in (1, 2, 3)
            )
            oa.log(
                f"Case {example['case_id']} ({example['category']}): ArchRouter returned "
                f"Codex={actual['codex']} and Claude={actual['claude']}; Terra expected {expected}. "
                f"Rationale: {judgment['rationale']} Prompt feedback: {judgment['arch_feedback']}",
            )
            return score
        except Exception as error:
            oa.log(f"Candidate failed safely for {example['case_id']}: {type(error).__name__}: {error}")
            return 0.0

    return evaluator


def evaluate_candidate(
    *,
    target: str,
    prompt: str,
    examples: list[dict[str, Any]],
    systems: ModalRoutingSystems,
) -> dict[str, Any]:
    results = []
    for example in examples:
        judgment = example["judgment"]
        if target == "gemma":
            actual: Any = systems.evaluate_gemma(prompt, example)
            expected: Any = int(judgment["difficulty"])
            exact = actual == expected
            distance = abs(actual - expected)
        else:
            actual = systems.evaluate_arch(prompt, example)
            expected = {
                "codex": {
                    str(tier): int(judgment["codex_tier_grades"][tier - 1])
                    for tier in (1, 2, 3)
                },
                "claude": {
                    str(tier): int(judgment["claude_tier_grades"][tier - 1])
                    for tier in (1, 2, 3)
                },
            }
            distances = [
                abs(actual[client][str(tier)] - expected[client][str(tier)])
                for client in ("codex", "claude")
                for tier in (1, 2, 3)
            ]
            exact = all(distance == 0 for distance in distances)
            distance = statistics.fmean(distances)
        selected_distances = []
        if target == "arch":
            selected_tier = int(judgment["difficulty"])
            selected_distances = [
                abs(
                    actual[client][str(selected_tier)]
                    - expected[client][str(selected_tier)]
                )
                for client in ("codex", "claude")
            ]
        results.append(
            {
                "case_id": example["case_id"],
                "category": example["category"],
                "actual": actual,
                "expected": expected,
                "exact": exact,
                "distance": distance,
                "grade_exact_count": sum(item == 0 for item in distances) if target == "arch" else int(exact),
                "grade_count": len(distances) if target == "arch" else 1,
                "selected_exact": all(item == 0 for item in selected_distances) if target == "arch" else exact,
            },
        )
    report = {
        "target": target,
        "cases": len(results),
        "exact_accuracy": sum(result["exact"] for result in results) / len(results),
        "mean_absolute_distance": statistics.fmean(result["distance"] for result in results),
        "results": results,
    }
    if target == "arch":
        report["grade_accuracy"] = sum(result["grade_exact_count"] for result in results) / sum(
            result["grade_count"] for result in results
        )
        report["selected_exact_accuracy"] = sum(
            result["selected_exact"] for result in results
        ) / len(results)
        high_categories = {
            "ambiguous_debugging",
            "open_architecture",
            "security_audit",
            "scattered_planning",
            "formal_verification",
        }
        report["high_risk_underroute_count"] = sum(
            actual_grade < result["expected"][client][str(tier)]
            for result in results
            if result["category"] in high_categories
            for client in ("codex", "claude")
            for tier, actual_grade in (
                (tier, result["actual"][client][str(tier)]) for tier in (1, 2, 3)
            )
        )
        report["selected_high_risk_underroute_count"] = sum(
            result["actual"][client][str(int(example["judgment"]["difficulty"]))]
            < result["expected"][client][str(int(example["judgment"]["difficulty"]))]
            for result, example in zip(results, examples, strict=True)
            if result["category"] in high_categories
            for client in ("codex", "claude")
        )
    return report


def optimize_target(
    *,
    target: str,
    labels: dict[str, Any],
    systems: ModalRoutingSystems,
    judge: TerraJudge,
    output_dir: pathlib.Path,
    max_metric_calls: int,
    max_candidate_proposals: int,
    seed: int,
) -> dict[str, Any]:
    from gepa.optimize_anything import (
        EngineConfig,
        GEPAConfig,
        ReflectionConfig,
        optimize_anything,
    )

    splits = split_optimization_cases()
    train = labeled_examples(labels, splits["train"])
    validation = labeled_examples(labels, splits["validation"])
    test = labeled_examples(labels, splits["test"])
    seed_prompt = MODEL_FAMILY_SYSTEM_PROMPT if target == "gemma" else ARCH_OPTIMIZATION_PROMPT
    evaluator = build_evaluator(target=target, systems=systems)
    target_dir = output_dir / target
    target_dir.mkdir(parents=True, exist_ok=True)

    baseline_validation = evaluate_candidate(
        target=target,
        prompt=seed_prompt,
        examples=validation,
        systems=systems,
    )
    baseline_test = evaluate_candidate(
        target=target,
        prompt=seed_prompt,
        examples=test,
        systems=systems,
    )
    result = optimize_anything(
        seed_candidate={"prompt": seed_prompt},
        evaluator=evaluator,
        dataset=train,
        valset=validation,
        objective=(
            "Improve routing agreement with independent Terra Medium judgments across task levels. "
            "Prioritize the latest user intent, resist difficult-context carryover after topic "
            "switches, directly choose the lowest sufficient final grade for each model tier with "
            "no fixed arithmetic offsets, keep maximum effort rare, preserve schemas and protected "
            "markers, and never hardcode benchmark phrases."
        ),
        config=GEPAConfig(
            engine=EngineConfig(
                run_dir=str(target_dir / "gepa"),
                seed=seed,
                display_progress_bar=True,
                use_cloudpickle=False,
                max_metric_calls=max_metric_calls,
                max_candidate_proposals=max_candidate_proposals,
                parallel=False,
                cache_evaluation=True,
            ),
            reflection=ReflectionConfig(
                reflection_lm=judge.reflect,
                reflection_minibatch_size=8,
                module_selector="all",
            ),
        ),
    )
    best_prompt = str(result.best_candidate["prompt"])
    optimized_validation = evaluate_candidate(
        target=target,
        prompt=best_prompt,
        examples=validation,
        systems=systems,
    )
    optimized_test = evaluate_candidate(
        target=target,
        prompt=best_prompt,
        examples=test,
        systems=systems,
    )
    accepted = (
        (
            optimized_validation["grade_accuracy"] > baseline_validation["grade_accuracy"]
            if target == "arch"
            else optimized_validation["exact_accuracy"] > baseline_validation["exact_accuracy"]
        )
        and (
            optimized_test["grade_accuracy"] >= baseline_test["grade_accuracy"]
            if target == "arch"
            else optimized_test["exact_accuracy"] >= baseline_test["exact_accuracy"]
        )
        and optimized_test["mean_absolute_distance"] <= baseline_test["mean_absolute_distance"]
        and (
            optimized_test["selected_exact_accuracy"] >= baseline_test["selected_exact_accuracy"]
            and optimized_test["selected_high_risk_underroute_count"]
            <= baseline_test["selected_high_risk_underroute_count"]
            if target == "arch"
            else True
        )
    )
    (target_dir / "best_prompt.txt").write_text(best_prompt + "\n")
    report = {
        "target": target,
        "accepted_for_review": accepted,
        "acceptance_rule": (
            "validation accuracy must improve; held-out test accuracy and selected-route accuracy "
            "must not regress; held-out mean distance and selected high-risk under-routing must not increase"
        ),
        "baseline": {"validation": baseline_validation, "test": baseline_test},
        "optimized": {"validation": optimized_validation, "test": optimized_test},
    }
    write_json(target_dir / "report.json", report)
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Optimize PromptRail routing prompts with GEPA.")
    parser.add_argument("--mode", choices=("dataset", "label", "optimize", "all"), default="all")
    parser.add_argument("--target", choices=("gemma", "arch", "both"), default="both")
    parser.add_argument("--judge-model", default=os.environ.get("OPENAI_JUDGE_MODEL", DEFAULT_JUDGE_MODEL))
    parser.add_argument("--keychain-service", default=os.environ.get("OPENAI_KEYCHAIN_SERVICE", ""))
    parser.add_argument("--app-name", default=DEFAULT_APP_NAME)
    parser.add_argument("--output-dir", type=pathlib.Path, default=ROOT / "optimization_runs" / "latest")
    parser.add_argument("--max-metric-calls", type=int, default=200)
    parser.add_argument("--max-candidate-proposals", type=int, default=8)
    parser.add_argument("--seed", type=int, default=56)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cases = build_optimization_cases()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_json(args.output_dir / "dataset.json", [case.to_dict() for case in cases])
    if args.mode == "dataset":
        print(json.dumps({"cases": len(cases), "output": str(args.output_dir / "dataset.json")}))
        return

    systems = ModalRoutingSystems(app_name=args.app_name)
    judge = TerraJudge(
        model=args.judge_model,
        api_key=resolve_api_key(keychain_service=args.keychain_service),
    )
    judge.probe()
    labels_path = args.output_dir / "labels.json"
    labels = label_cases(cases=cases, systems=systems, judge=judge, cache_path=labels_path)
    if args.mode == "label":
        print(json.dumps({"cases": len(labels["cases"]), "judge_usage": judge.usage}, indent=2))
        return

    targets = ("gemma", "arch") if args.target == "both" else (args.target,)
    reports = {
        target: optimize_target(
            target=target,
            labels=labels,
            systems=systems,
            judge=judge,
            output_dir=args.output_dir,
            max_metric_calls=args.max_metric_calls,
            max_candidate_proposals=args.max_candidate_proposals,
            seed=args.seed,
        )
        for target in targets
    }
    summary = {
        "judge_model": judge.model,
        "judge_reasoning_effort": "medium",
        "judge_usage": judge.usage,
        "reports": {
            target: {
                "accepted_for_review": report["accepted_for_review"],
                "baseline_test_accuracy": report["baseline"]["test"]["exact_accuracy"],
                "optimized_test_accuracy": report["optimized"]["test"]["exact_accuracy"],
            }
            for target, report in reports.items()
        },
    }
    write_json(args.output_dir / "summary.json", summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
