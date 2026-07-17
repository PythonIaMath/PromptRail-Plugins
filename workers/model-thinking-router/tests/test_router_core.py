from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("router_core", ROOT / "router_core.py")
router_core = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = router_core
SPEC.loader.exec_module(router_core)


class RouterCoreTest(unittest.TestCase):
    def test_parses_strict_and_json_difficulty_outputs(self) -> None:
        self.assertEqual(router_core.parse_difficulty("1"), 1)
        self.assertEqual(router_core.parse_difficulty('{"difficulty": 2}'), 2)
        self.assertEqual(router_core.parse_difficulty("Difficulty: 3"), 3)

    def test_rejects_invalid_difficulty(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            router_core.parse_difficulty("4")

    def test_conversation_messages_require_and_preserve_last_turn(self) -> None:
        messages = router_core.conversation_messages(
            "Do it.",
            "Fix the race condition.",
            "Found unsafe cache mutation.",
        )
        self.assertEqual(
            messages,
            [
                {"role": "user", "content": "Fix the race condition."},
                {"role": "assistant", "content": "Found unsafe cache mutation."},
                {"role": "user", "content": "Do it."},
            ],
        )
        with self.assertRaises(router_core.RouteValidationError):
            router_core.conversation_messages("Do it.", "", "Summary.")

    def test_parses_constrained_lfm_routes(self) -> None:
        self.assertEqual(router_core.parse_lfm_route("<m2t4>", "codex"), (2, 4))
        self.assertEqual(router_core.parse_lfm_route("<m3t5>", "claude"), (3, 5))

    def test_rejects_invalid_constrained_lfm_route(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            router_core.parse_lfm_route("<m2t6>", "claude")

    def test_route_codes_match_each_client_contract(self) -> None:
        self.assertEqual(len(router_core.route_codes("codex")), 18)
        self.assertEqual(len(router_core.route_codes("claude")), 15)

    def test_default_model_mapping_covers_both_clients(self) -> None:
        self.assertEqual(
            [router_core.DEFAULT_MODEL_MAP["codex"][grade] for grade in (1, 2, 3)],
            ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
        )
        self.assertEqual(
            [router_core.DEFAULT_MODEL_MAP["claude"][grade] for grade in (1, 2, 3)],
            ["claude-sonnet-5", "claude-fable-5", "claude-opus-4-8"],
        )

    def test_model_override_requires_exactly_three_ids(self) -> None:
        self.assertEqual(
            router_core.parse_model_list(
                "small,medium,large",
                router_core.DEFAULT_MODEL_MAP["codex"],
            ),
            {1: "small", 2: "medium", 3: "large"},
        )
        with self.assertRaises(router_core.RouteValidationError):
            router_core.parse_model_list("small,large", router_core.DEFAULT_MODEL_MAP["codex"])

    def test_build_route_combines_independent_layers(self) -> None:
        result = router_core.build_route(
            client="codex",
            prompt="Implement a distributed scheduler.",
            model_decision=router_core.ModelDecision(
                difficulty=3,
                raw_output="3",
                latency_ms=8.4,
            ),
            thinking_decision=router_core.ThinkingDecision(
                grade=5,
                effort="xhigh",
                latency_ms=11.2,
            ),
            model_map=router_core.DEFAULT_MODEL_MAP,
            total_latency_ms=12.1,
        )
        self.assertEqual(result["model"], "gpt-5.6-sol")
        self.assertEqual(result["difficulty_label"], "complex")
        self.assertEqual(result["effort"], "xhigh")
        self.assertEqual(result["router"]["execution"], "parallel")

    def test_claude_effort_contract_has_five_levels(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            router_core.validate_thinking_grade("claude", 6)
        self.assertEqual(router_core.validate_thinking_grade("claude", 5), 5)


if __name__ == "__main__":
    unittest.main()
