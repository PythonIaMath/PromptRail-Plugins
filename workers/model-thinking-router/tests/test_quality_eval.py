from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("quality_eval", ROOT / "quality_eval.py")
quality_eval = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = quality_eval
SPEC.loader.exec_module(quality_eval)


class QualityEvalTest(unittest.TestCase):
    def test_case_matrix_covers_every_model_tier_for_both_clients(self) -> None:
        self.assertEqual(len(quality_eval.QUALITY_CASES), 9)
        self.assertEqual(
            {case.expected_difficulty for case in quality_eval.QUALITY_CASES},
            {1, 2, 3},
        )
        self.assertEqual(
            len({case.name for case in quality_eval.QUALITY_CASES}),
            len(quality_eval.QUALITY_CASES),
        )
        for case in quality_eval.QUALITY_CASES:
            for client in quality_eval.CLIENTS:
                minimum, maximum = case.grade_range(client)
                self.assertLessEqual(minimum, maximum)
                self.assertIn(minimum, quality_eval.EFFORT_MAP[client])
                self.assertIn(maximum, quality_eval.EFFORT_MAP[client])

    def test_evaluate_case_accepts_matching_route_and_contract(self) -> None:
        case = next(
            case for case in quality_eval.QUALITY_CASES if case.name == "everyday_feature"
        )
        result = quality_eval.evaluate_case(
            "codex",
            case,
            {
                "difficulty": 2,
                "difficulty_label": "standard",
                "model": "gpt-5.6-terra",
                "thinking_grade": 4,
                "effort": "high",
                "latency_ms": {"model": 10.0, "thinking": 20.0, "total": 30.0},
            },
        )
        self.assertTrue(result["passed"])
        self.assertTrue(result["contract_pass"])

    def test_boundary_matrix_covers_semantic_traps_and_every_tier(self) -> None:
        cases = quality_eval.BOUNDARY_CASES
        self.assertEqual(len(cases), 12)
        self.assertEqual({case.expected_difficulty for case in cases}, {1, 2, 3})
        by_name = {case.name: case for case in cases}
        self.assertEqual(by_name["architecture_document_extraction_trap"].expected_difficulty, 1)
        self.assertEqual(by_name["short_high_stakes_corruption"].expected_difficulty, 3)

    def test_evaluate_case_distinguishes_quality_failure_from_contract_failure(self) -> None:
        case = next(
            case for case in quality_eval.QUALITY_CASES if case.name == "formal_verification"
        )
        quality_failure = quality_eval.evaluate_case(
            "claude",
            case,
            {
                "difficulty": 2,
                "difficulty_label": "standard",
                "model": "claude-fable-5",
                "thinking_grade": 3,
                "effort": "high",
                "latency_ms": {"model": 10.0, "thinking": 20.0, "total": 30.0},
            },
        )
        self.assertFalse(quality_failure["passed"])
        self.assertTrue(quality_failure["contract_pass"])

        contract_failure = quality_eval.evaluate_case(
            "claude",
            case,
            {
                "difficulty": 3,
                "difficulty_label": "simple",
                "model": "claude-sonnet-5",
                "thinking_grade": 5,
                "effort": "low",
                "latency_ms": {},
            },
        )
        self.assertFalse(contract_failure["contract_pass"])
        self.assertGreaterEqual(len(contract_failure["errors"]), 3)

    def test_latency_summary_reports_distribution(self) -> None:
        self.assertEqual(
            quality_eval.summarize_latencies([10.0, 20.0, 30.0]),
            {
                "count": 3,
                "min_ms": 10.0,
                "mean_ms": 20.0,
                "p50_ms": 20.0,
                "p95_ms": 30.0,
                "max_ms": 30.0,
            },
        )

    def test_live_report_separates_worker_time_from_request_overhead(self) -> None:
        case = quality_eval.QUALITY_CASES[0]
        payload = {
            "difficulty": 1,
            "difficulty_label": "simple",
            "model": "gpt-5.6-luna",
            "thinking_grade": 3,
            "effort": "medium",
            "latency_ms": {"model": 10.0, "thinking": 20.0, "total": 30.0},
        }

        original_cases = quality_eval.QUALITY_CASES
        original_request = quality_eval.route_request
        quality_eval.QUALITY_CASES = (case,)
        quality_eval.route_request = lambda **kwargs: (payload, 50.0)
        try:
            report = quality_eval.run_quality_eval(
                url="https://router.example",
                token="test-token",
                execution="sequential",
                clients=("codex",),
            )
        finally:
            quality_eval.QUALITY_CASES = original_cases
            quality_eval.route_request = original_request

        self.assertEqual(report["latency"]["worker"]["mean_ms"], 30.0)
        self.assertEqual(report["latency"]["network_and_auth"]["mean_ms"], 20.0)


if __name__ == "__main__":
    unittest.main()
