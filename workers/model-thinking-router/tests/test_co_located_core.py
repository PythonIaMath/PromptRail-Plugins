from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

ROUTER_SPEC = importlib.util.spec_from_file_location("router_core", ROOT / "router_core.py")
router_core = importlib.util.module_from_spec(ROUTER_SPEC)
assert ROUTER_SPEC.loader
sys.modules[ROUTER_SPEC.name] = router_core
ROUTER_SPEC.loader.exec_module(router_core)

SPEC = importlib.util.spec_from_file_location("co_located_core", ROOT / "co_located_core.py")
co_located_core = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = co_located_core
SPEC.loader.exec_module(co_located_core)


class CoLocatedCoreTest(unittest.TestCase):
    def test_formats_archrouter_prompt_with_client_routes_and_context(self) -> None:
        prompt = co_located_core.format_arch_prompt(
            client="codex",
            prompt="Do it.",
            previous_user_prompt="Fix the race condition.",
            previous_assistant_summary="Found unsafe cache mutation.",
        )
        self.assertIn('"name":"6"', prompt)
        self.assertIn("Fix the race condition.", prompt)
        self.assertIn("Found unsafe cache mutation.", prompt)
        self.assertIn("Do it.", prompt)

    def test_claude_prompt_exposes_only_five_routes(self) -> None:
        prompt = co_located_core.format_arch_prompt(
            client="claude",
            prompt="Review this security design.",
            previous_user_prompt="We are choosing an authentication design.",
            previous_assistant_summary="Compared session and token approaches.",
        )
        self.assertIn('"name":"5"', prompt)
        self.assertNotIn('"name":"6"', prompt)

    def test_parses_archrouter_json_and_plain_grade(self) -> None:
        self.assertEqual(co_located_core.parse_arch_grade('{"route":"4"}', "codex"), 4)
        self.assertEqual(co_located_core.parse_arch_grade("Route 3", "claude"), 3)

    def test_rejects_grade_outside_client_contract(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            co_located_core.parse_arch_grade('{"route":"6"}', "claude")

    def test_requires_both_previous_turn_fields(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            co_located_core.format_arch_prompt(
                client="codex",
                prompt="Do it.",
                previous_user_prompt="Fix the race condition.",
                previous_assistant_summary="",
            )


if __name__ == "__main__":
    unittest.main()
