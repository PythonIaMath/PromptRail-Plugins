from __future__ import annotations

import ast
import importlib.util
import json
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


class CharacterTokenizer:
    def apply_chat_template(
        self,
        messages: list[dict[str, str]],
        *,
        tokenize: bool,
        add_generation_prompt: bool,
    ) -> str:
        assert not tokenize
        assert add_generation_prompt
        return json.dumps(messages, separators=(",", ":")) + "<assistant>"

    def __call__(self, text: str) -> dict[str, list[int]]:
        return {"input_ids": self.encode(text, add_special_tokens=True)}

    def encode(self, text: str, *, add_special_tokens: bool) -> list[int]:
        return [ord(character) for character in text]

    def decode(self, token_ids: list[int], *, skip_special_tokens: bool) -> str:
        return "".join(chr(token_id) for token_id in token_ids)


class CoLocatedCoreTest(unittest.TestCase):
    def test_modal_deployment_uses_pinned_quantized_gemma_model(self) -> None:
        tree = ast.parse((ROOT / "co_located_modal_app.py").read_text())
        constants = {
            node.targets[0].id: ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id
            in {
                "GEMMA_MODEL_ID",
                "GEMMA_MODEL_REVISION",
                "GEMMA_BASE_MODEL_ID",
                "GEMMA_MODEL_PATH",
            }
        }
        self.assertEqual(
            constants,
            {
                "GEMMA_MODEL_ID": "RedHatAI/gemma-3-12b-it-quantized.w4a16",
                "GEMMA_MODEL_REVISION": "700b3cfd55276c9e404d97680ddd29e4fa18e9f5",
                "GEMMA_BASE_MODEL_ID": "google/gemma-3-12b-it",
                "GEMMA_MODEL_PATH": (
                    "/models/gemma-cache/gemma-3-12b-it-quantized.w4a16"
                ),
            },
        )

    def test_modal_deployment_is_split_across_two_l4_gpus(self) -> None:
        source = (ROOT / "co_located_modal_app.py").read_text()
        self.assertIn("class GemmaModelSelector:", source)
        self.assertIn('gpu="L4"', source)
        self.assertIn('execution: str = "parallel"', source)
        self.assertIn('"default_execution": "parallel_split_gpu"', source)
        self.assertIn('"execution": f"{execution}_split_gpu"', source)
        self.assertIn('"gpu": "2xL4"', source)
        self.assertNotIn("LiquidAI/LFM2", source)

    def test_model_classifier_prompt_encodes_model_family_strengths_and_context(self) -> None:
        messages = co_located_core.model_classifier_messages(
            "Implement the approved parser design.",
            "Define the parser contract.",
            "The grammar and acceptance tests are now fixed.",
        )
        system_prompt = messages[0]["content"]
        self.assertIn("Luna for Codex or Sonnet for Claude", system_prompt)
        self.assertIn("Terra for Codex or Fable for Claude", system_prompt)
        self.assertIn("Sol for Codex or Opus for Claude", system_prompt)
        self.assertIn("clear, bounded work", system_prompt)
        self.assertIn("scope is mostly understood", system_prompt)
        self.assertIn("planning from scattered", system_prompt)
        self.assertIn("Do not route by prompt length", system_prompt)
        self.assertIn("Do not choose 3 merely because", system_prompt)
        self.assertIn("Add endpoint pagination", system_prompt)
        self.assertIn("Fix a confirmed race", system_prompt)
        self.assertIn('{"difficulty": 1 | 2 | 3}', system_prompt)
        self.assertEqual(co_located_core.MODEL_FAMILY_OUTPUT_PREFIX, '{"difficulty":')
        self.assertEqual(len(messages), 2)
        self.assertEqual(
            json.loads(messages[1]["content"]),
            {
                "conversation": [
                    {"role": "user", "content": "Define the parser contract."},
                    {
                        "role": "assistant",
                        "content": "The grammar and acceptance tests are now fixed.",
                    },
                    {"role": "user", "content": "Implement the approved parser design."},
                ],
            },
        )

    def test_model_classifier_rendering_preserves_short_input_exactly(self) -> None:
        tokenizer = CharacterTokenizer()
        messages = co_located_core.model_classifier_messages(
            "Implement the approved parser.",
            "Define the parser contract.",
            "The acceptance tests are fixed.",
        )
        expected = (
            tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
            + co_located_core.MODEL_FAMILY_OUTPUT_PREFIX
        )
        self.assertEqual(
            co_located_core.render_model_classifier_input(
                tokenizer=tokenizer,
                prompt="Implement the approved parser.",
                previous_user_prompt="Define the parser contract.",
                previous_assistant_summary="The acceptance tests are fixed.",
                max_length=10_000,
            ),
            expected,
        )

    def test_model_classifier_truncates_prior_context_before_current_request(self) -> None:
        tokenizer = CharacterTokenizer()
        rendered = co_located_core.render_model_classifier_input(
            tokenizer=tokenizer,
            prompt="LATEST_REQUEST_MARKER audit the migration",
            previous_user_prompt="OLD_USER_CONTEXT " * 400,
            previous_assistant_summary="OLD_SUMMARY_CONTEXT " * 200,
            max_length=4_200,
        )
        self.assertLessEqual(len(tokenizer(rendered)["input_ids"]), 4_200)
        self.assertIn("LATEST_REQUEST_MARKER audit the migration", rendered)
        self.assertTrue(rendered.endswith(co_located_core.MODEL_FAMILY_OUTPUT_PREFIX))
        self.assertIn("You extract the minimum model family", rendered)
        self.assertNotIn("OLD_USER_CONTEXT " * 10, rendered)

    def test_model_classifier_preserves_both_ends_of_an_oversized_current_request(self) -> None:
        tokenizer = CharacterTokenizer()
        rendered = co_located_core.render_model_classifier_input(
            tokenizer=tokenizer,
            prompt="CURRENT_START " + ("payload " * 900) + "CURRENT_END",
            previous_user_prompt="Previous request.",
            previous_assistant_summary="Previous result.",
            max_length=4_200,
        )
        self.assertLessEqual(len(tokenizer(rendered)["input_ids"]), 4_200)
        self.assertIn("CURRENT_START", rendered)
        self.assertIn("CURRENT_END", rendered)
        self.assertIn("earlier context truncated", rendered)
        self.assertTrue(rendered.endswith(co_located_core.MODEL_FAMILY_OUTPUT_PREFIX))

    def test_formats_archrouter_prompt_with_client_routes_and_context(self) -> None:
        prompt = co_located_core.format_arch_prompt(
            client="codex",
            model_tier=1,
            prompt="Do it.",
            previous_user_prompt="Fix the race condition.",
            previous_assistant_summary="Found unsafe cache mutation.",
        )
        self.assertIn('"name":"6"', prompt)
        self.assertIn("Fix the race condition.", prompt)
        self.assertIn("Found unsafe cache mutation.", prompt)
        self.assertIn("Do it.", prompt)
        self.assertIn("None: thanks, greetings, acknowledgements", prompt)
        self.assertIn("xHigh: difficult, ambiguous, or high-stakes work", prompt)
        self.assertIn("Ultra/max, used rarely", prompt)
        self.assertIn("There is no arithmetic calibration after your decision", prompt)
        self.assertIn("specifically for model tier 1 (Luna)", prompt)

    def test_default_arch_optimization_template_preserves_the_production_prompt(self) -> None:
        conversation = co_located_core.build_conversation(
            "Do it.",
            "Fix the race condition.",
            "Found unsafe cache mutation.",
        )
        expected_rendering = (
            co_located_core.ARCH_OPTIMIZATION_PROMPT.replace(
                co_located_core.ARCH_ROUTES_MARKER,
                json.dumps(
                    co_located_core.routes_for_client("codex"),
                    separators=(",", ":"),
                ),
            )
            .replace(
                co_located_core.ARCH_CONVERSATION_MARKER,
                json.dumps(conversation, separators=(",", ":")),
            )
            .replace(
                co_located_core.ARCH_GUIDANCE_MARKER,
                co_located_core.effort_guidance_for_tier("codex", 2),
            )
        )
        self.assertEqual(
            co_located_core.format_arch_prompt(
                client="codex",
                model_tier=2,
                prompt="Do it.",
                previous_user_prompt="Fix the race condition.",
                previous_assistant_summary="Found unsafe cache mutation.",
            ),
            expected_rendering,
        )

    def test_arch_routes_are_shared_while_tier_guidance_is_direct(self) -> None:
        routes = co_located_core.routes_for_client("codex")
        self.assertIn("invariant analysis", routes[4]["description"])
        self.assertIn("memory-model correctness", routes[5]["description"])
        self.assertIn("model tier 1 (Luna)", co_located_core.effort_guidance_for_tier("codex", 1))
        self.assertIn("model tier 2 (Terra)", co_located_core.effort_guidance_for_tier("codex", 2))
        self.assertIn("model tier 3 (Sol)", co_located_core.effort_guidance_for_tier("codex", 3))

    def test_arch_batch_contains_one_direct_prompt_per_model_tier(self) -> None:
        prompts = co_located_core.format_arch_prompts(
            client="codex",
            prompt="Implement the bounded change.",
            previous_user_prompt="Approve the implementation plan.",
            previous_assistant_summary="The contract and tests are fixed.",
        )
        self.assertEqual(len(prompts), 3)
        self.assertIn("model tier 1 (Luna)", prompts[0])
        self.assertIn("model tier 2 (Terra)", prompts[1])
        self.assertIn("model tier 3 (Sol)", prompts[2])
        self.assertTrue(all("no later bonus or calibration" in prompt for prompt in prompts))

    def test_arch_optimization_template_protects_dynamic_inputs(self) -> None:
        with self.assertRaisesRegex(
            router_core.RouteValidationError,
            "protected input marker",
        ):
            co_located_core.format_arch_prompt(
                client="codex",
                model_tier=1,
                prompt="Which day are we?",
                previous_user_prompt="Audit a distributed system.",
                previous_assistant_summary="The earlier task remains unresolved.",
                prompt_template="Choose a route without any dynamic input markers.",
            )

        custom = co_located_core.ARCH_OPTIMIZATION_PROMPT.replace(
            "Identify the latest user request and its actual finish line",
            "Prioritize the latest intent and its finish line",
        )
        rendered = co_located_core.format_arch_prompt(
            client="codex",
            model_tier=1,
            prompt="Which day are we?",
            previous_user_prompt="Audit a distributed system.",
            previous_assistant_summary="The earlier task remains unresolved.",
            prompt_template=custom,
        )
        self.assertIn("Prioritize the latest intent", rendered)
        self.assertIn("Which day are we?", rendered)
        self.assertIn("Audit a distributed system.", rendered)
        self.assertNotIn("<<PROMPTRAIL_", rendered)

    def test_gemma_system_prompt_can_be_evaluated_without_changing_the_default(self) -> None:
        custom_system_prompt = (
            co_located_core.MODEL_FAMILY_SYSTEM_PROMPT
            + "\nPrioritize a clear topic switch in the latest user request."
        )
        messages = co_located_core.model_classifier_messages(
            "Which day are we?",
            "Plan a difficult migration.",
            "Several architecture decisions remain unresolved.",
            system_prompt=custom_system_prompt,
        )
        self.assertEqual(messages[0]["content"], custom_system_prompt)
        self.assertNotIn(
            "Which day are we?",
            co_located_core.MODEL_FAMILY_SYSTEM_PROMPT,
        )

    def test_claude_prompt_exposes_only_five_routes(self) -> None:
        prompt = co_located_core.format_arch_prompt(
            client="claude",
            model_tier=3,
            prompt="Review this security design.",
            previous_user_prompt="We are choosing an authentication design.",
            previous_assistant_summary="Compared session and token approaches.",
        )
        self.assertIn('"name":"5"', prompt)
        self.assertNotIn('"name":"6"', prompt)
        self.assertIn("xHigh: difficult, ambiguous, or high-stakes work", prompt)
        self.assertIn("Max, used rarely", prompt)

    def test_parses_archrouter_json_and_plain_grade(self) -> None:
        self.assertEqual(co_located_core.parse_arch_grade('{"route":"4"}', "codex"), 4)
        self.assertEqual(co_located_core.parse_arch_grade("Route 3", "claude"), 3)
        self.assertEqual(co_located_core.parse_arch_grade("{'route': 'Low'}", "codex"), 2)
        self.assertEqual(co_located_core.parse_arch_grade('{"route":"Ultra"}', "codex"), 6)
        self.assertEqual(co_located_core.parse_arch_grade('{"route":"x-high"}', "claude"), 4)

    def test_rejects_grade_outside_client_contract(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            co_located_core.parse_arch_grade('{"route":"6"}', "claude")

    def test_requires_both_previous_turn_fields(self) -> None:
        with self.assertRaises(router_core.RouteValidationError):
            co_located_core.format_arch_prompt(
                client="codex",
                model_tier=1,
                prompt="Do it.",
                previous_user_prompt="Fix the race condition.",
                previous_assistant_summary="",
            )


if __name__ == "__main__":
    unittest.main()
