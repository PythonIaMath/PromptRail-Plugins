from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from collections import Counter
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cases_module = load_module("prompt_optimization_cases", "prompt_optimization_cases.py")
optimizer = load_module("prompt_optimizer", "prompt_optimizer.py")


class FakeUsage:
    input_tokens = 100
    output_tokens = 20
    total_tokens = 120


class FakeResponses:
    def __init__(self) -> None:
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        payload = {
            "difficulty": 1,
            "codex_tier_grades": [1, 1, 1],
            "claude_tier_grades": [1, 1, 1],
            "confidence": 0.98,
            "rationale": "The latest request is a standalone factual question.",
            "gemma_feedback": "Prioritize the current intent after a topic switch.",
            "arch_feedback": "Do not inherit prior complexity after a topic switch.",
        }
        return types.SimpleNamespace(output_text=json.dumps(payload), usage=FakeUsage())


class FakeOpenAIClient:
    def __init__(self) -> None:
        self.responses = FakeResponses()


class PromptOptimizationCasesTest(unittest.TestCase):
    def test_builds_two_hundred_balanced_cases(self) -> None:
        cases = cases_module.build_optimization_cases()
        self.assertEqual(len(cases), 200)
        self.assertEqual(len({case.case_id for case in cases}), 200)
        self.assertEqual(set(Counter(case.category for case in cases).values()), {10})
        self.assertEqual(len({case.category for case in cases}), 20)

    def test_split_is_category_balanced_and_keeps_a_true_holdout(self) -> None:
        splits = cases_module.split_optimization_cases()
        self.assertEqual({name: len(values) for name, values in splits.items()}, {
            "train": 120,
            "validation": 40,
            "test": 40,
        })
        for values in splits.values():
            counts = Counter(case.category for case in values)
            self.assertEqual(len(counts), 20)
        identifiers = [case.case_id for values in splits.values() for case in values]
        self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_dataset_contains_the_observed_context_shift_failure(self) -> None:
        cases = cases_module.build_optimization_cases()
        date_cases = [case for case in cases if case.category == "context_shift_date"]
        self.assertEqual(len(date_cases), 10)
        for case in date_cases:
            self.assertEqual(case.prompt, "Which day are we?")
            self.assertIn("prior task remains difficult", case.previous_assistant_summary)


class PromptOptimizerTest(unittest.TestCase):
    def test_resolves_api_key_from_keychain_without_logging_it(self) -> None:
        completed = types.SimpleNamespace(returncode=0, stdout="secret-from-keychain\n")
        with (
            patch.object(optimizer.sys, "platform", "darwin"),
            patch.object(optimizer.subprocess, "run", return_value=completed) as run,
        ):
            resolved = optimizer.resolve_api_key(keychain_service="promptrail-gepa-openai")
        self.assertEqual(resolved, "secret-from-keychain")
        command = run.call_args.args[0]
        self.assertNotIn("secret-from-keychain", command)
        self.assertEqual(command[-1], "-w")

    def test_terra_judge_receives_article_and_uses_medium_reasoning(self) -> None:
        fake_client = FakeOpenAIClient()
        with patch("openai.OpenAI", return_value=fake_client):
            judge = optimizer.TerraJudge(model="gpt-5.6-terra", api_key="test-key")
            case = cases_module.build_optimization_cases()[0]
            judgment = judge.judge(
                case,
                {
                    "gemma_difficulty": 1,
                    "arch_codex_tier_grades": {"1": 3, "2": 2, "3": 1},
                    "arch_claude_tier_grades": {"1": 2, "2": 1, "3": 1},
                },
            )

        self.assertEqual(judgment.codex_tier_grades, (1, 1, 1))
        call = fake_client.responses.calls[0]
        self.assertEqual(call["model"], "gpt-5.6-terra")
        self.assertEqual(call["reasoning"], {"effort": "medium"})
        self.assertFalse(call["store"])
        self.assertIn("Codex for moonshots", call["instructions"])
        self.assertIn("latest user intent", call["instructions"])
        self.assertIn("there is no later arithmetic bonus", call["instructions"])
        self.assertEqual(call["text"]["format"]["schema"], optimizer.JUDGMENT_SCHEMA)

    def test_proximity_score_rewards_exact_and_adjacent_routes(self) -> None:
        self.assertEqual(optimizer.proximity_score(3, 3), 1.0)
        self.assertEqual(optimizer.proximity_score(2, 3), 0.5)
        self.assertEqual(optimizer.proximity_score(1, 3), 0.0)

    def test_label_cache_is_atomic_and_never_contains_an_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "labels.json"
            optimizer.write_json(path, {"cases": {}, "metadata": {"judge": "terra"}})
            self.assertEqual(json.loads(path.read_text())["metadata"]["judge"], "terra")
            self.assertNotIn("OPENAI_API_KEY", path.read_text())
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_modal_candidate_methods_are_private_rpc_methods_not_http_endpoints(self) -> None:
        source = (ROOT / "co_located_modal_app.py").read_text()
        self.assertIn("def evaluate_system_prompt(", source)
        self.assertIn("def evaluate_thinking_prompt(", source)
        self.assertNotIn("class PromptOptimizationBody", source)


if __name__ == "__main__":
    unittest.main()
