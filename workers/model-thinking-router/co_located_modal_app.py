from __future__ import annotations

import json
import os
import statistics
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import modal
from fastapi import Header, HTTPException
from pydantic import BaseModel

from co_located_core import (
    MODEL_FAMILY_OUTPUT_PREFIX,
    MODEL_FAMILY_SYSTEM_PROMPT,
    format_arch_prompts,
    parse_arch_grade,
    render_model_classifier_input,
)
from internal_service_auth import require_router_auth
from router_core import (
    DEFAULT_MODEL_MAP,
    EFFORT_MAP,
    ModelDecision,
    ThinkingDecision,
    build_route,
    parse_difficulty,
    parse_model_list,
    validate_client,
    validate_conversation_context,
    validate_prompt,
)

APP_NAME = "CodexAndClaudePlugin"
ROUTER_REVISION = "ood-winner-v6-hybrid"
KEEP_WARM_CONTAINERS = 0 if os.getenv("PROMPTRAIL_OPTIMIZER_DEPLOYMENT") == "1" else 1
GEMMA_MODEL_ID = "RedHatAI/gemma-3-12b-it-quantized.w4a16"
GEMMA_MODEL_REVISION = "700b3cfd55276c9e404d97680ddd29e4fa18e9f5"
GEMMA_BASE_MODEL_ID = "google/gemma-3-12b-it"
ARCH_MODEL_ID = "katanemo/Arch-Router-1.5B"
GEMMA_MODEL_PATH = "/models/gemma-cache/gemma-3-12b-it-quantized.w4a16"
ARCH_MODEL_PATH = "/models/arch-cache/katanemo/Arch-Router-1.5B"
CORE_SOURCE_PATH = os.getenv(
    "PROMPTRAIL_CORE_SOURCE_PATH",
    "workers/model-thinking-router/co_located_core.py",
)

CODEX_BASELINE_URL = (
    "https://promptrail--promptrail-codex-effort-grader-effortgrader-web.modal.run"
)
CLAUDE_BASELINE_URL = (
    "https://promptrail--promptrail-claude-effort-grader-claudeeffort-f35715.modal.run"
)

app = modal.App(APP_NAME)
arch_model_volume = modal.Volume.from_name("promptrail-archrouter-models")
gemma_model_volume = modal.Volume.from_name(
    "promptrail-gemma-models",
    create_if_missing=True,
)
shared_files = {
    "workers/model-thinking-router/router_core.py": "/root/router_core.py",
    CORE_SOURCE_PATH: "/root/co_located_core.py",
    "workers/model-thinking-router/internal_service_auth.py": "/root/internal_service_auth.py",
}
router_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(
        "accelerate==1.9.0",
        "fastapi[standard]==0.116.1",
        "pymongo",
        "torch==2.7.1",
        "transformers==5.14.1",
    )
)
gemma_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.8.1-devel-ubuntu22.04",
        add_python="3.12",
    )
    .uv_pip_install(
        "huggingface_hub[hf_xet]==0.34.4",
        "vllm==0.10.2",
    )
    .env(
        {
            "HF_HOME": "/models/gemma-cache/huggingface",
            "HF_HUB_CACHE": "/models/gemma-cache/huggingface/hub",
            "HF_XET_HIGH_PERFORMANCE": "1",
            "VLLM_WORKER_MULTIPROC_METHOD": "spawn",
        },
    )
)
for local_path, remote_path in shared_files.items():
    router_image = router_image.add_local_file(local_path, remote_path=remote_path)
    gemma_image = gemma_image.add_local_file(local_path, remote_path=remote_path)
router_image = router_image.add_local_file(
    "workers/model-thinking-router/quality_eval.py",
    remote_path="/root/quality_eval.py",
)

router_secret = modal.Secret.from_name(
    "promptrail-router-service-token",
    required_keys=["PROMPTRAIL_ROUTER_TOKEN"],
)
mongodb_secret = modal.Secret.from_name("lerouter-mongodb", required_keys=["MONGODB_URI"])


class RouteBody(BaseModel):
    client: str
    prompt: str
    current_model: str | None = None
    previous_user_prompt: str
    previous_assistant_summary: str
    execution: str = "parallel"


def configured_model_map() -> dict[str, dict[int, str]]:
    return {
        "codex": parse_model_list(
            os.getenv("PROMPTRAIL_CODEX_MODELS"),
            DEFAULT_MODEL_MAP["codex"],
        ),
        "claude": parse_model_list(
            os.getenv("PROMPTRAIL_CLAUDE_MODELS"),
            DEFAULT_MODEL_MAP["claude"],
        ),
    }


@app.function(
    image=gemma_image,
    volumes={"/models/gemma-cache": gemma_model_volume},
    timeout=60 * 60,
)
def download_gemma_model() -> str:
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=GEMMA_MODEL_ID,
        revision=GEMMA_MODEL_REVISION,
        local_dir=GEMMA_MODEL_PATH,
    )
    gemma_model_volume.commit()
    return GEMMA_MODEL_PATH


@app.cls(
    image=gemma_image,
    gpu="L4",
    volumes={"/models/gemma-cache": gemma_model_volume},
    min_containers=KEEP_WARM_CONTAINERS,
    scaledown_window=600,
    timeout=10 * 60,
)
@modal.concurrent(max_inputs=1)
class GemmaModelSelector:
    @modal.enter()
    def load_model(self) -> None:
        from transformers import AutoTokenizer
        from vllm import LLM, SamplingParams

        self.tokenizer = AutoTokenizer.from_pretrained(
            GEMMA_MODEL_PATH,
            local_files_only=True,
        )
        self.model = LLM(
            model=GEMMA_MODEL_PATH,
            tokenizer=GEMMA_MODEL_PATH,
            dtype="bfloat16",
            max_model_len=4608,
            gpu_memory_utilization=0.90,
            limit_mm_per_prompt={"image": 0},
            enforce_eager=True,
            disable_log_stats=True,
        )
        self.sampling_params = SamplingParams(
            temperature=0.0,
            max_tokens=16,
        )

    def generate_text(self, rendered: str) -> str:
        outputs = self.model.generate(
            [rendered],
            self.sampling_params,
            use_tqdm=False,
        )
        return outputs[0].outputs[0].text.strip()

    def generate_texts(self, rendered: list[str]) -> list[str]:
        outputs = self.model.generate(
            rendered,
            self.sampling_params,
            use_tqdm=False,
        )
        return [output.outputs[0].text.strip() for output in outputs]

    def classify_with_prompt(
        self,
        system_prompt: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        rendered = render_model_classifier_input(
            tokenizer=self.tokenizer,
            prompt=prompt,
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
            system_prompt=system_prompt,
        )
        generated = self.generate_text(rendered)
        difficulty = parse_difficulty(generated)
        return {
            "difficulty": difficulty,
            "raw_output": f"{MODEL_FAMILY_OUTPUT_PREFIX}{generated}",
            "latency_ms": (time.perf_counter() - started) * 1000,
        }

    @modal.method()
    def classify(
        self,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> dict[str, Any]:
        return self.classify_with_prompt(
            MODEL_FAMILY_SYSTEM_PROMPT,
            prompt=prompt,
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
        )

    @modal.method()
    def evaluate_system_prompt(
        self,
        system_prompt: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> dict[str, Any]:
        return self.classify_with_prompt(
            system_prompt,
            prompt,
            previous_user_prompt,
            previous_assistant_summary,
        )

    @modal.method()
    def classify_thinking(
        self,
        client: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        normalized_client = validate_client(client)
        route_prompts = format_arch_prompts(
            client=normalized_client,
            prompt=prompt,
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
        )
        rendered = [
            self.tokenizer.apply_chat_template(
                [{"role": "user", "content": route_prompt}],
                tokenize=False,
                add_generation_prompt=True,
            )
            for route_prompt in route_prompts
        ]
        raw_outputs = self.generate_texts(rendered)
        tier_grades = tuple(
            parse_arch_grade(raw_output, normalized_client)
            for raw_output in raw_outputs
        )
        return {
            "tier_grades": {str(tier): tier_grades[tier - 1] for tier in (1, 2, 3)},
            "tier_efforts": {
                str(tier): EFFORT_MAP[normalized_client][tier_grades[tier - 1]]
                for tier in (1, 2, 3)
            },
            "raw_outputs": raw_outputs,
            "latency_ms": (time.perf_counter() - started) * 1000,
        }


@app.function(image=router_image, timeout=10 * 60)
def smoke_gemma_selector() -> str:
    result = GemmaModelSelector().classify.remote(
        "Add cursor pagination to the user endpoint and cover it with tests.",
        "The API contract and database schema are stable.",
        "Located the endpoint, repository, and existing test fixtures.",
    )
    return json.dumps(result, indent=2)


@app.function(
    image=router_image,
    secrets=[router_secret],
    timeout=15 * 60,
)
def evaluate_routing(endpoint_url: str, execution: str = "parallel") -> str:
    from quality_eval import run_quality_eval

    report = run_quality_eval(
        url=endpoint_url,
        token=os.environ["PROMPTRAIL_ROUTER_TOKEN"],
        execution=execution,
    )
    return json.dumps(report, indent=2)


@app.cls(
    image=router_image,
    gpu="L4",
    volumes={"/models/arch-cache": arch_model_volume},
    secrets=[router_secret, mongodb_secret],
    min_containers=KEEP_WARM_CONTAINERS,
    scaledown_window=600,
    timeout=15 * 60,
)
@modal.concurrent(max_inputs=1)
class CoLocatedRouterV7:
    @modal.enter()
    def load_models(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.arch_tokenizer = AutoTokenizer.from_pretrained(
            ARCH_MODEL_PATH,
            local_files_only=True,
        )
        self.arch_model = AutoModelForCausalLM.from_pretrained(
            ARCH_MODEL_PATH,
            local_files_only=True,
            dtype=torch.float16,
        ).to("cuda")
        self.arch_model.eval()
        if self.arch_tokenizer.pad_token_id is None:
            self.arch_tokenizer.pad_token = self.arch_tokenizer.eos_token
        self.arch_tokenizer.padding_side = "left"
        self.arch_stream = torch.cuda.Stream()
        self.gemma_selector = GemmaModelSelector()
        self.executor = ThreadPoolExecutor(max_workers=2)
        torch.cuda.synchronize()

    @modal.exit()
    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)

    def authorize(self, authorization: str | None) -> None:
        require_router_auth(authorization)

    def classify_model(
        self,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> ModelDecision:
        started = time.perf_counter()
        result = self.gemma_selector.classify.remote(
            prompt,
            previous_user_prompt,
            previous_assistant_summary,
        )
        return ModelDecision(
            difficulty=int(result["difficulty"]),
            raw_output=str(result["raw_output"]),
            latency_ms=(time.perf_counter() - started) * 1000,
        )

    def classify_thinking(
        self,
        *,
        client: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
        prompt_template: str | None = None,
    ) -> ThinkingDecision:
        torch = self.torch
        started = time.perf_counter()
        format_options: dict[str, Any] = {}
        if prompt_template is not None:
            format_options["prompt_template"] = prompt_template
        route_prompts = format_arch_prompts(
            client=client,
            prompt=prompt,
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
            **format_options,
        )
        conversations = [
            [{"role": "user", "content": route_prompt}]
            for route_prompt in route_prompts
        ]
        inputs = self.arch_tokenizer.apply_chat_template(
            conversations,
            add_generation_prompt=True,
            tokenize=True,
            padding=True,
            return_tensors="pt",
            return_dict=True,
        ).to("cuda")
        with torch.cuda.stream(self.arch_stream), torch.inference_mode():
            output_ids = self.arch_model.generate(
                **inputs,
                do_sample=False,
                max_new_tokens=16,
                pad_token_id=self.arch_tokenizer.eos_token_id,
            )
        self.arch_stream.synchronize()
        generated = output_ids[:, inputs.input_ids.shape[1] :]
        raw_outputs = self.arch_tokenizer.batch_decode(
            generated,
            skip_special_tokens=True,
        )
        tier_grades = tuple(
            parse_arch_grade(raw_output.strip(), client)
            for raw_output in raw_outputs
        )
        return ThinkingDecision(
            tier_grades=tier_grades,
            latency_ms=(time.perf_counter() - started) * 1000,
        )

    @modal.method()
    def classify_thinking_only(
        self,
        client: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> dict[str, Any]:
        decision = self.classify_thinking(
            client=validate_client(client),
            prompt=validate_prompt(prompt),
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
        )
        return {
            "tier_grades": {
                str(tier): decision.tier_grades[tier - 1]
                for tier in (1, 2, 3)
            },
            "tier_efforts": {
                str(tier): EFFORT_MAP[client][decision.tier_grades[tier - 1]]
                for tier in (1, 2, 3)
            },
            "latency_ms": decision.latency_ms,
        }

    @modal.method()
    def evaluate_thinking_prompt(
        self,
        prompt_template: str,
        client: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> dict[str, Any]:
        decision = self.classify_thinking(
            client=validate_client(client),
            prompt=validate_prompt(prompt),
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
            prompt_template=prompt_template,
        )
        return {
            "tier_grades": {
                str(tier): decision.tier_grades[tier - 1]
                for tier in (1, 2, 3)
            },
            "tier_efforts": {
                str(tier): EFFORT_MAP[client][decision.tier_grades[tier - 1]]
                for tier in (1, 2, 3)
            },
            "latency_ms": decision.latency_ms,
        }

    def route_payload(self, payload: RouteBody) -> dict[str, Any]:
        client = validate_client(payload.client)
        prompt = validate_prompt(payload.prompt)
        previous_user_prompt, previous_assistant_summary = validate_conversation_context(
            payload.previous_user_prompt,
            payload.previous_assistant_summary,
        )
        execution = payload.execution.strip().lower()
        if execution not in {"parallel", "sequential"}:
            raise ValueError("execution must be either 'parallel' or 'sequential'.")
        started = time.perf_counter()
        if execution == "parallel":
            model_future = self.executor.submit(
                self.classify_model,
                prompt,
                previous_user_prompt,
                previous_assistant_summary,
            )
            thinking_future = self.executor.submit(
                self.classify_thinking,
                client=client,
                prompt=prompt,
                previous_user_prompt=previous_user_prompt,
                previous_assistant_summary=previous_assistant_summary,
            )
            model_decision = model_future.result()
            thinking_decision = thinking_future.result()
        else:
            model_decision = self.classify_model(
                prompt,
                previous_user_prompt,
                previous_assistant_summary,
            )
            thinking_decision = self.classify_thinking(
                client=client,
                prompt=prompt,
                previous_user_prompt=previous_user_prompt,
                previous_assistant_summary=previous_assistant_summary,
            )
        result = build_route(
            client=client,
            prompt=prompt,
            model_decision=model_decision,
            thinking_decision=thinking_decision,
            model_map=configured_model_map(),
            total_latency_ms=(time.perf_counter() - started) * 1000,
        )
        result["router"] = {
            "revision": ROUTER_REVISION,
            "model": GEMMA_BASE_MODEL_ID,
            "model_checkpoint": GEMMA_MODEL_ID,
            "model_revision": GEMMA_MODEL_REVISION,
            "model_quantization": "INT4 weights / BF16 compute",
            "thinking": ARCH_MODEL_ID,
            "execution": f"{execution}_split_gpu",
            "gpu": "2xL4",
        }
        return result

    @modal.fastapi_endpoint(method="POST", docs=True)
    def route_v7(
        self,
        payload: RouteBody,
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        self.authorize(authorization)
        try:
            return self.route_payload(payload)
        except HTTPException:
            raise
        except Exception as error:
            traceback.print_exc()
            detail = str(error).strip() or repr(error)
            raise HTTPException(
                status_code=422,
                detail=f"{type(error).__name__}: {detail}",
            ) from error

    @modal.fastapi_endpoint(method="GET", docs=True)
    def health_v7(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "app": APP_NAME,
            "revision": ROUTER_REVISION,
            "independent": True,
            "co_located": False,
            "default_execution": "parallel_split_gpu",
            "model_router": GEMMA_BASE_MODEL_ID,
            "model_checkpoint": GEMMA_MODEL_ID,
            "model_revision": GEMMA_MODEL_REVISION,
            "model_quantization": "INT4 weights / BF16 compute",
            "thinking_router": ARCH_MODEL_ID,
        }


@app.function(image=router_image, timeout=30 * 60)
def compare_thinking_routers(suite: str = "article") -> str:
    from quality_eval import BOUNDARY_CASES, QUALITY_CASES

    normalized_suite = suite.strip().lower()
    if normalized_suite not in {"article", "boundary"}:
        raise ValueError("suite must be either 'article' or 'boundary'.")
    cases = QUALITY_CASES if normalized_suite == "article" else BOUNDARY_CASES
    arch_router = CoLocatedRouterV7()
    gemma_router = GemmaModelSelector()
    results: list[dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=2) as executor:
        for client in ("codex", "claude"):
            for case in cases:
                wall_started = time.perf_counter()
                arch_future = executor.submit(
                    arch_router.classify_thinking_only.remote,
                    client,
                    case.prompt,
                    case.previous_user_prompt,
                    case.previous_assistant_summary,
                )
                gemma_future = executor.submit(
                    gemma_router.classify_thinking.remote,
                    client,
                    case.prompt,
                    case.previous_user_prompt,
                    case.previous_assistant_summary,
                )
                arch_result = arch_future.result()
                gemma_result = gemma_future.result()
                minimum, maximum = case.grade_range(client)

                def scored(name: str, result: dict[str, Any]) -> dict[str, Any]:
                    tier_grades = {
                        str(tier): int(result["tier_grades"][str(tier)])
                        for tier in (1, 2, 3)
                    }
                    selected_grade = tier_grades[str(case.expected_difficulty)]
                    if selected_grade < minimum:
                        distance = minimum - selected_grade
                    elif selected_grade > maximum:
                        distance = selected_grade - maximum
                    else:
                        distance = 0
                    return {
                        "router": name,
                        "tier_grades": tier_grades,
                        "selected_grade": selected_grade,
                        "effort": EFFORT_MAP[client][selected_grade],
                        "accepted": distance == 0,
                        "distance_from_expected": distance,
                        "latency_ms": round(float(result["latency_ms"]), 3),
                    }

                arch_score = scored("archrouter", arch_result)
                gemma_score = scored("gemma-3-12b-it-int4", gemma_result)
                results.append(
                    {
                        "client": client,
                        "case": case.name,
                        "difficulty_for_calibration": case.expected_difficulty,
                        "expected_grade_range": [minimum, maximum],
                        "archrouter": arch_score,
                        "gemma": gemma_score,
                        "selected_grade_agreement": (
                            arch_score["selected_grade"]
                            == gemma_score["selected_grade"]
                        ),
                        "comparison_wall_ms": round(
                            (time.perf_counter() - wall_started) * 1000,
                            3,
                        ),
                    },
                )

    def summary_for(key: str) -> dict[str, Any]:
        scores = [result[key] for result in results]
        return {
            "accepted": sum(score["accepted"] for score in scores),
            "total": len(scores),
            "acceptance": round(
                sum(score["accepted"] for score in scores) / len(scores),
                4,
            ),
            "mean_distance_from_expected": round(
                statistics.fmean(score["distance_from_expected"] for score in scores),
                4,
            ),
            "latency": summarize([score["latency_ms"] for score in scores]),
        }

    report = {
        "suite": normalized_suite,
        "cases": len(results),
        "calibration": "none; each router directly grades all three model tiers",
        "summary": {
            "archrouter": summary_for("archrouter"),
            "gemma": summary_for("gemma"),
            "selected_grade_agreement": round(
                sum(result["selected_grade_agreement"] for result in results)
                / len(results),
                4,
            ),
        },
        "results": results,
    }
    return json.dumps(report, indent=2)


BENCHMARK_CASES = [
    ("simple", "Thanks!"),
    ("simple_definition", "What does HTTP 404 mean?"),
    ("mechanical", "Rename the variable userData to userProfile in this function."),
    ("explanation", "Explain why this unit test assertion fails."),
    ("standard", "Add pagination to the user list and cover it with tests."),
    ("implementation", "Implement input validation for the account creation endpoint."),
    ("debugging", "Debug an intermittent race condition across the worker and cache modules."),
    ("refactor", "Refactor authentication across the API, service, and persistence layers."),
    ("security", "Review this cryptographic token flow for security vulnerabilities."),
    ("architecture", "Design a multi-region authorization service and define its failure modes."),
    (
        "migration",
        "Migrate all sessions to a new identity protocol without downtime and verify the invariants.",
    ),
    (
        "maximum",
        "Prove the lock-free queue is linearizable under the C++ memory model and produce a "
        "tested implementation.",
    ),
]

BENCHMARK_CONTEXT = {
    "previous_user_prompt": "Route the next standalone engineering request.",
    "previous_assistant_summary": "No implementation has started; classify the next request.",
}


def request_json(url: str, token: str, payload: dict[str, Any]) -> tuple[dict[str, Any], float]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "accept": "application/json",
        },
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"{url} returned HTTP {error.code}: {detail}") from None
    return body, (time.perf_counter() - started) * 1000


def summarize(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)

    def percentile(quantile: float) -> float:
        position = (len(ordered) - 1) * quantile
        lower = int(position)
        upper = min(lower + 1, len(ordered) - 1)
        weight = position - lower
        return ordered[lower] * (1 - weight) + ordered[upper] * weight

    return {
        "count": len(values),
        "min_ms": round(min(values), 3),
        "mean_ms": round(statistics.fmean(values), 3),
        "p50_ms": round(percentile(0.50), 3),
        "p95_ms": round(percentile(0.95), 3),
        "max_ms": round(max(values), 3),
    }


@app.function(
    image=router_image,
    secrets=[router_secret, mongodb_secret],
    timeout=900,
)
def benchmark(
    endpoint_url: str,
    runs: int = 3,
    execution: str = "parallel",
) -> str:
    token = os.environ["PROMPTRAIL_ROUTER_TOKEN"]
    report: dict[str, Any] = {
        "endpoint": endpoint_url,
        "runs_per_latency_case": runs,
        "execution": execution,
        "clients": {},
    }
    for client, baseline_url in (
        ("codex", CODEX_BASELINE_URL),
        ("claude", CLAUDE_BASELINE_URL),
    ):
        agreements = []
        cases = []
        for name, prompt in BENCHMARK_CASES:
            baseline_payload: dict[str, Any] = {"prompt": prompt}
            if client == "codex":
                baseline_payload["model"] = DEFAULT_MODEL_MAP["codex"][3]
            baseline, _ = request_json(baseline_url, token, baseline_payload)
            colocated, _ = request_json(
                endpoint_url,
                token,
                {
                    "client": client,
                    "prompt": prompt,
                    "execution": execution,
                    **BENCHMARK_CONTEXT,
                },
            )
            exact = baseline["grade"] == colocated["thinking_grade"]
            agreements.append(exact)
            cases.append(
                {
                    "case": name,
                    "baseline_grade": baseline["grade"],
                    "colocated_grade": colocated["thinking_grade"],
                    "exact": exact,
                    "difficulty": colocated["difficulty"],
                    "model": colocated["model"],
                },
            )

        wall_latency = []
        model_latency = []
        thinking_latency = []
        worker_latency = []
        for _, prompt in (BENCHMARK_CASES[0], BENCHMARK_CASES[4], BENCHMARK_CASES[-1]):
            request_json(
                endpoint_url,
                token,
                {
                    "client": client,
                    "prompt": prompt,
                    "execution": execution,
                    **BENCHMARK_CONTEXT,
                },
            )
            for _ in range(runs):
                payload, wall_ms = request_json(
                    endpoint_url,
                    token,
                    {
                        "client": client,
                        "prompt": prompt,
                        "execution": execution,
                        **BENCHMARK_CONTEXT,
                    },
                )
                wall_latency.append(wall_ms)
                model_latency.append(payload["latency_ms"]["model"])
                thinking_latency.append(payload["latency_ms"]["thinking"])
                worker_latency.append(payload["latency_ms"]["total"])

        report["clients"][client] = {
            "exact_agreement": round(sum(agreements) / len(agreements), 4),
            "cases": cases,
            "latency": {
                "wall": summarize(wall_latency),
                "worker": summarize(worker_latency),
                "model": summarize(model_latency),
                "thinking": summarize(thinking_latency),
            },
        }
    return json.dumps(report, indent=2)
