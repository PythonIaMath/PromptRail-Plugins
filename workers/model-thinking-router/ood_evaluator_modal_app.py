from __future__ import annotations

import json
import os
import pathlib
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime

import modal
from openai import OpenAI


APP_NAME = "PromptRailRouterOODEvaluator"
RUNS_VOLUME_NAME = "promptrail-gepa-optimization-runs"
REMOTE_ROOT = pathlib.PurePosixPath("/root/ood-evaluator")

app = modal.App(APP_NAME)
runs_volume = modal.Volume.from_name(RUNS_VOLUME_NAME, create_if_missing=True)
openai_secret = modal.Secret.from_name("openai-api-key", required_keys=["OPENAI_API_KEY"])

image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("modal==1.1.3", "openai==2.16.0")
    .add_local_file(
        "workers/model-thinking-router/ood_evaluator.py",
        remote_path=str(REMOTE_ROOT / "ood_evaluator.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/prompt_optimizer.py",
        remote_path=str(REMOTE_ROOT / "prompt_optimizer.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/prompt_optimization_article.py",
        remote_path=str(REMOTE_ROOT / "prompt_optimization_article.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/prompt_optimization_article.md",
        remote_path=str(REMOTE_ROOT / "prompt_optimization_article.md"),
    )
    .add_local_file(
        "workers/model-thinking-router/prompt_optimization_cases.py",
        remote_path=str(REMOTE_ROOT / "prompt_optimization_cases.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/quality_eval.py",
        remote_path=str(REMOTE_ROOT / "quality_eval.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/co_located_core.py",
        remote_path=str(REMOTE_ROOT / "co_located_core.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/router_core.py",
        remote_path=str(REMOTE_ROOT / "router_core.py"),
    )
)


@app.function(
    image=image,
    secrets=[openai_secret],
    volumes={"/runs": runs_volume},
    timeout=24 * 60 * 60,
    cpu=4,
    memory=8192,
)
def run(
    count: int = 60,
    production_app: str = "CodexAndClaudePlugin",
    run_name: str = "",
) -> str:
    sys.path.insert(0, str(REMOTE_ROOT))
    from ood_evaluator import (
        OODCase,
        OODLabel,
        UsageCounter,
        deduplicate_cases,
        evaluate_router,
        generate_candidates,
        label_cases,
        known_prompts,
        score,
    )

    resolved_name = run_name.strip() or datetime.now(UTC).strftime("ood-v12-%Y%m%dT%H%M%SZ")
    output_dir = pathlib.Path("/runs") / resolved_name
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "report.json"
    if report_path.exists():
        return report_path.read_text()

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    usage = UsageCounter()
    dataset_path = output_dir / "dataset.json"
    if dataset_path.exists():
        dataset_payload = json.loads(dataset_path.read_text())
        cases = tuple(OODCase(**case) for case in dataset_payload["cases"])
        candidate_count = int(dataset_payload["candidate_count"])
    else:
        candidates = generate_candidates(client, usage)
        cases = deduplicate_cases(candidates, count)
        candidate_count = len(candidates)
        dataset_path.write_text(
            json.dumps(
                {
                    "candidate_count": candidate_count,
                    "cases": [case.to_dict() for case in cases],
                },
                indent=2,
            )
            + "\n",
        )
        runs_volume.commit()

    labels_path = output_dir / "labels.json"
    if labels_path.exists():
        labels = {
            case_id: OODLabel.from_dict(label)
            for case_id, label in json.loads(labels_path.read_text())["labels"].items()
        }
    else:
        labels = label_cases(client, usage, cases)
        labels_path.write_text(
            json.dumps(
                {"labels": {key: value.to_dict() for key, value in labels.items()}},
                indent=2,
            )
            + "\n",
        )
        runs_volume.commit()

    outputs = evaluate_router(cases, production_app)
    scored = score(cases, labels, outputs)
    report = {
        "protocol": {
            "blind": True,
            "prompt_frozen_during_evaluation": True,
            "labels_created_before_router_outputs": True,
            "generator_model": "gpt-5.6-luna",
            "generator_reasoning_effort": "high",
            "judge_model": "gpt-5.6-terra",
            "judge_reasoning_effort": "medium",
            "dedupe_jaccard_threshold": 0.72,
            "known_case_count": len(known_prompts()),
            "candidate_count": candidate_count,
            "accepted_case_count": len(cases),
            "production_app": production_app,
            "generated_at": datetime.now(UTC).isoformat(),
        },
        "usage": usage.values,
        "scores": {key: value for key, value in scored.items() if key != "rows"},
        "rows": scored["rows"],
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    runs_volume.commit()
    return json.dumps(
        {
            "run_name": resolved_name,
            "artifact_path": str(report_path),
            "protocol": report["protocol"],
            "usage": report["usage"],
            "scores": report["scores"],
        },
        indent=2,
    )


@app.function(
    image=image,
    volumes={"/runs": runs_volume},
    timeout=24 * 60 * 60,
    cpu=4,
    memory=4096,
)
def compare_version(
    source_run: str,
    version_name: str,
    app_name: str,
    model_reference_version: str = "",
) -> str:
    sys.path.insert(0, str(REMOTE_ROOT))
    from ood_evaluator import OODCase, OODLabel, score

    import modal as modal_client

    source_dir = pathlib.Path("/runs") / source_run
    dataset = json.loads((source_dir / "dataset.json").read_text())
    label_payload = json.loads((source_dir / "labels.json").read_text())
    cases = tuple(OODCase(**case) for case in dataset["cases"])
    labels = {
        case_id: OODLabel.from_dict(label)
        for case_id, label in label_payload["labels"].items()
    }

    comparison_dir = source_dir / "comparisons"
    comparison_dir.mkdir(exist_ok=True)
    result_path = comparison_dir / f"{version_name}.json"
    if result_path.exists():
        existing = json.loads(result_path.read_text())
        return json.dumps(
            {"version": version_name, "app": app_name, "scores": existing["scores"]},
            indent=2,
        )

    if model_reference_version:
        reference_path = comparison_dir / f"{model_reference_version}.json"
        reference = json.loads(reference_path.read_text())
        model_outputs = {
            case_id: int(output["gemma_difficulty"])
            for case_id, output in reference["outputs"].items()
        }
    else:
        gemma = modal_client.Cls.from_name(app_name, "GemmaModelSelector")()
        model_outputs = {}
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {
                executor.submit(
                    gemma.classify.remote,
                    case.prompt,
                    case.previous_user_prompt,
                    case.previous_assistant_summary,
                ): case
                for case in cases
            }
            for future in as_completed(futures):
                case = futures[future]
                model_outputs[case.case_id] = int(future.result()["difficulty"])

    arch = modal_client.Cls.from_name(app_name, "CoLocatedRouterV7")()
    arch_outputs: dict[str, dict[str, dict[str, int]]] = {
        case.case_id: {} for case in cases
    }
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(
                arch.classify_thinking_only.remote,
                client,
                case.prompt,
                case.previous_user_prompt,
                case.previous_assistant_summary,
            ): (case, client)
            for case in cases
            for client in ("codex", "claude")
        }
        for future in as_completed(futures):
            case, client = futures[future]
            result = future.result()
            arch_outputs[case.case_id][client] = {
                str(tier): int(result["tier_grades"][str(tier)])
                for tier in (1, 2, 3)
            }

    outputs = {
        case.case_id: {
            "gemma_difficulty": model_outputs[case.case_id],
            "arch_codex_tier_grades": arch_outputs[case.case_id]["codex"],
            "arch_claude_tier_grades": arch_outputs[case.case_id]["claude"],
        }
        for case in cases
    }
    scored = score(cases, labels, outputs)
    payload = {
        "version": version_name,
        "app": app_name,
        "model_reference_version": model_reference_version or version_name,
        "evaluated_at": datetime.now(UTC).isoformat(),
        "scores": {key: value for key, value in scored.items() if key != "rows"},
        "outputs": outputs,
        "rows": scored["rows"],
    }
    result_path.write_text(json.dumps(payload, indent=2) + "\n")
    runs_volume.commit()
    return json.dumps(
        {"version": version_name, "app": app_name, "scores": payload["scores"]},
        indent=2,
    )
