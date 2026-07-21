from __future__ import annotations

import json
import os
import pathlib
import sys
from datetime import UTC, datetime
from typing import Any

import modal


APP_NAME = "PromptRailRouterPromptOptimizerRunner"
RUNS_VOLUME_NAME = "promptrail-gepa-optimization-runs"
REMOTE_ROOT = pathlib.PurePosixPath("/root/prompt-optimizer")

app = modal.App(APP_NAME)
runs_volume = modal.Volume.from_name(RUNS_VOLUME_NAME, create_if_missing=True)
openai_secret = modal.Secret.from_name(
    "openai-api-key",
    required_keys=["OPENAI_API_KEY"],
)

optimizer_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(
        "gepa==0.1.4",
        "modal==1.1.3",
        "openai==2.16.0",
    )
    .add_local_file(
        "workers/model-thinking-router/co_located_core.py",
        remote_path=str(REMOTE_ROOT / "co_located_core.py"),
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
        "workers/model-thinking-router/prompt_optimizer.py",
        remote_path=str(REMOTE_ROOT / "prompt_optimizer.py"),
    )
    .add_local_file(
        "workers/model-thinking-router/router_core.py",
        remote_path=str(REMOTE_ROOT / "router_core.py"),
    )
)


def _load_optimizer() -> Any:
    sys.path.insert(0, str(REMOTE_ROOT))
    import prompt_optimizer

    return prompt_optimizer


@app.function(
    image=optimizer_image,
    secrets=[openai_secret],
    timeout=24 * 60 * 60,
    cpu=2,
    memory=4096,
)
def preflight(
    judge_model: str = "gpt-5.6-terra",
    evaluator_app: str = "PromptRailRouterPromptOptimizer",
) -> str:
    optimizer = _load_optimizer()
    judge = optimizer.TerraJudge(model=judge_model, api_key=os.environ["OPENAI_API_KEY"])
    judge.probe()
    systems = optimizer.ModalRoutingSystems(app_name=evaluator_app)
    case = optimizer.build_optimization_cases()[0]
    return json.dumps({
        "judge": "ready",
        "judge_model": judge_model,
        "judge_reasoning_effort": "medium",
        "judge_usage": judge.usage,
        "evaluator_app": evaluator_app,
        "sample_case_id": case.case_id,
        "sample_baseline": systems.baseline(case),
    })


@app.function(
    image=optimizer_image,
    secrets=[openai_secret],
    volumes={"/runs": runs_volume},
    timeout=24 * 60 * 60,
    cpu=2,
    memory=4096,
)
def optimize(
    target: str = "both",
    judge_model: str = "gpt-5.6-terra",
    evaluator_app: str = "PromptRailRouterPromptOptimizer",
    max_metric_calls: int = 200,
    max_candidate_proposals: int = 8,
    seed: int = 56,
    run_name: str = "",
) -> str:
    if target not in {"gemma", "arch", "both"}:
        raise ValueError("target must be gemma, arch, or both")
    resolved_run_name = run_name.strip() or datetime.now(UTC).strftime("gepa-%Y%m%dT%H%M%SZ")
    output_dir = pathlib.Path("/runs") / resolved_run_name
    if output_dir.exists():
        unexpected = {
            path.name
            for path in output_dir.iterdir()
            if path.name not in {"dataset.json", "labels.json"}
        }
        if unexpected:
            raise FileExistsError(
                f"run directory already contains non-resumable artifacts: {sorted(unexpected)}",
            )

    optimizer = _load_optimizer()
    previous_argv = sys.argv
    try:
        sys.argv = [
            "prompt_optimizer.py",
            "--mode",
            "all",
            "--target",
            target,
            "--judge-model",
            judge_model,
            "--app-name",
            evaluator_app,
            "--output-dir",
            str(output_dir),
            "--max-metric-calls",
            str(max_metric_calls),
            "--max-candidate-proposals",
            str(max_candidate_proposals),
            "--seed",
            str(seed),
        ]
        optimizer.main()
    finally:
        sys.argv = previous_argv
        runs_volume.commit()

    summary_path = output_dir / "summary.json"
    if not summary_path.exists():
        raise RuntimeError("optimizer completed without writing summary.json")
    return json.dumps({
        "run_name": resolved_run_name,
        "volume": RUNS_VOLUME_NAME,
        "artifact_path": str(output_dir),
        "summary": json.loads(summary_path.read_text()),
    })
