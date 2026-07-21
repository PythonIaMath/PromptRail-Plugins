from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


load_module("prompt_optimization_article", "prompt_optimization_article.py")
load_module("prompt_optimization_cases", "prompt_optimization_cases.py")
load_module("quality_eval", "quality_eval.py")
evaluator = load_module("ood_evaluator", "ood_evaluator.py")


class OODEvaluatorTest(unittest.TestCase):
    def test_deduplicates_candidates_and_normalizes_empty_context(self) -> None:
        candidates = [
            {
                "category": "novel systems",
                "style": "terse",
                "prompt": "Determine the frobnicator phase from these seven telemetry samples.",
                "previous_user_prompt": "",
                "previous_assistant_summary": "",
            },
            {
                "category": "duplicate",
                "style": "terse",
                "prompt": "Determine the frobnicator phase from these seven telemetry samples.",
                "previous_user_prompt": "ignored",
                "previous_assistant_summary": "ignored",
            },
            {
                "category": "novel hardware",
                "style": "formal",
                "prompt": "Prove the quux register remains monotonic during asynchronous resets.",
                "previous_user_prompt": "Inspect the custom controller.",
                "previous_assistant_summary": "No invariant has been established.",
            },
        ]

        cases = evaluator.deduplicate_cases(candidates, 2)

        self.assertEqual([case.case_id for case in cases], ["ood-001", "ood-002"])
        self.assertEqual(cases[0].previous_user_prompt, "(no previous user request)")
        self.assertEqual(cases[0].previous_assistant_summary, "(no previous assistant summary)")

    def test_scores_model_and_selected_thinking_routes(self) -> None:
        case = evaluator.OODCase(
            case_id="ood-001",
            category="implementation",
            style="direct",
            prompt="Implement the fixed change.",
            previous_user_prompt="The contract is approved.",
            previous_assistant_summary="All acceptance tests are specified.",
        )
        label = evaluator.OODLabel(
            difficulty=2,
            codex_tier_grades=(3, 4, 5),
            claude_tier_grades=(2, 3, 4),
            confidence=0.95,
            rationale="Routine implementation with meaningful judgment.",
        )
        output = {
            "gemma_difficulty": 2,
            "arch_codex_tier_grades": {"1": 3, "2": 4, "3": 5},
            "arch_claude_tier_grades": {"1": 2, "2": 3, "3": 4},
        }

        report = evaluator.score((case,), {case.case_id: label}, {case.case_id: output})

        self.assertEqual(report["model_tier_exact"], 1.0)
        for client in ("codex", "claude"):
            self.assertEqual(report["clients"][client]["selected_tier_exact"], 1.0)
            self.assertEqual(report["clients"][client]["end_to_end_exact"], 1.0)
            self.assertEqual(report["clients"][client]["high_risk_underroute_count"], 0)

    def test_counts_only_high_grade_under_routes_as_high_risk(self) -> None:
        case = evaluator.OODCase(
            case_id="ood-002",
            category="formal correctness",
            style="formal",
            prompt="Prove and verify the invariant.",
            previous_user_prompt="The algorithm is safety critical.",
            previous_assistant_summary="The proof remains open.",
        )
        label = evaluator.OODLabel(
            difficulty=3,
            codex_tier_grades=(4, 5, 6),
            claude_tier_grades=(3, 4, 5),
            confidence=0.99,
            rationale="Formal verification requires maximum effort.",
        )
        output = {
            "gemma_difficulty": 3,
            "arch_codex_tier_grades": {"1": 4, "2": 5, "3": 5},
            "arch_claude_tier_grades": {"1": 3, "2": 4, "3": 4},
        }

        report = evaluator.score((case,), {case.case_id: label}, {case.case_id: output})

        self.assertEqual(report["clients"]["codex"]["high_risk_underroute_count"], 1)
        self.assertEqual(report["clients"]["claude"]["high_risk_underroute_count"], 1)


if __name__ == "__main__":
    unittest.main()
