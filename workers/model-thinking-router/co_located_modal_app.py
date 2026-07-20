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

from co_located_core import format_arch_prompt, parse_arch_grade
from internal_service_auth import require_router_auth
from router_core import (
    DEFAULT_MODEL_MAP,
    EFFORT_MAP,
    ModelDecision,
    ThinkingDecision,
    build_route,
    conversation_messages,
    difficulty_token_ids,
    parse_model_list,
    select_difficulty_from_logits,
    validate_client,
    validate_conversation_context,
    validate_prompt,
)

APP_NAME = "CodexAndClaudePlugin"
LFM_MODEL_ID = "LiquidAI/LFM2.5-350M"
ARCH_MODEL_ID = "katanemo/Arch-Router-1.5B"
LFM_MODEL_PATH = "/models/lfm2"
ARCH_MODEL_PATH = "/models/arch-cache/katanemo/Arch-Router-1.5B"

CODEX_BASELINE_URL = (
    "https://promptrail--promptrail-codex-effort-grader-effortgrader-web.modal.run"
)
CLAUDE_BASELINE_URL = (
    "https://promptrail--promptrail-claude-effort-grader-claudeeffort-f35715.modal.run"
)

app = modal.App(APP_NAME)
arch_model_volume = modal.Volume.from_name("promptrail-archrouter-models")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(
        "accelerate==1.9.0",
        "fastapi[standard]==0.116.1",
        "pymongo",
        "torch==2.7.1",
        "transformers==5.14.1",
    )
    .run_commands(
        "python -c \"from huggingface_hub import snapshot_download; "
        f"snapshot_download('{LFM_MODEL_ID}', local_dir='{LFM_MODEL_PATH}')\"",
    )
    .add_local_file(
        "workers/model-thinking-router/router_core.py",
        remote_path="/root/router_core.py",
    )
    .add_local_file(
        "workers/model-thinking-router/co_located_core.py",
        remote_path="/root/co_located_core.py",
    )
    .add_local_file(
        "workers/model-thinking-router/internal_service_auth.py",
        remote_path="/root/internal_service_auth.py",
    )
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
    execution: str = "sequential"


def classifier_messages(
    prompt: str,
    previous_user_prompt: str,
    previous_assistant_summary: str,
) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You are a conservative task-difficulty router. Classify the minimum model "
                "capability needed and return exactly one digit: 1, 2, or 3. "
                "Use 1 only for trivial conversation, lookup, formatting, or a single obvious "
                "mechanical edit. Use 2 for ordinary engineering that requires implementation "
                "plus tests, debugging across files, or several dependent steps. Use 3 for "
                "architecture, distributed systems, migrations, security or correctness "
                "invariants, broad ambiguity, research, or high-impact decisions. Examples: "
                "\"Thanks!\" => 1. \"Add pagination and tests\" => 2. "
                "\"Design a multi-region authorization migration and prove its invariants\" "
                "=> 3. When uncertain, choose the higher tier. Do not solve the task."
            ),
        },
        *conversation_messages(
            prompt,
            previous_user_prompt,
            previous_assistant_summary,
        ),
    ]


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


@app.cls(
    image=image,
    gpu="L4",
    volumes={"/models/arch-cache": arch_model_volume},
    secrets=[router_secret, mongodb_secret],
    min_containers=1,
    scaledown_window=600,
    timeout=180,
)
@modal.concurrent(max_inputs=1)
class CoLocatedRouterV7:
    @modal.enter()
    def load_models(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.lfm_tokenizer = AutoTokenizer.from_pretrained(
            LFM_MODEL_PATH,
            local_files_only=True,
        )
        self.lfm_model = AutoModelForCausalLM.from_pretrained(
            LFM_MODEL_PATH,
            local_files_only=True,
            dtype=torch.bfloat16,
        ).to("cuda")
        self.arch_tokenizer = AutoTokenizer.from_pretrained(
            ARCH_MODEL_PATH,
            local_files_only=True,
        )
        self.arch_model = AutoModelForCausalLM.from_pretrained(
            ARCH_MODEL_PATH,
            local_files_only=True,
            dtype=torch.float16,
        ).to("cuda")
        self.lfm_model.eval()
        self.arch_model.eval()
        self.lfm_difficulty_token_ids = difficulty_token_ids(self.lfm_tokenizer)
        self.lfm_stream = torch.cuda.Stream()
        self.arch_stream = torch.cuda.Stream()
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
        torch = self.torch
        started = time.perf_counter()
        rendered = self.lfm_tokenizer.apply_chat_template(
            classifier_messages(
                prompt,
                previous_user_prompt,
                previous_assistant_summary,
            ),
            tokenize=False,
            add_generation_prompt=True,
        )
        inputs = self.lfm_tokenizer(
            rendered,
            return_tensors="pt",
            truncation=True,
            max_length=4096,
        ).to("cuda")
        with torch.cuda.stream(self.lfm_stream), torch.inference_mode():
            outputs = self.lfm_model(
                **inputs,
                use_cache=False,
            )
        self.lfm_stream.synchronize()
        final_input_positions = inputs.attention_mask.sum(dim=1) - 1
        batch_indices = torch.arange(
            inputs.input_ids.shape[0],
            device=inputs.input_ids.device,
        )
        next_token_logits = outputs.logits[batch_indices, final_input_positions]
        candidate_logits = next_token_logits[
            0,
            list(self.lfm_difficulty_token_ids),
        ].float().tolist()
        lfm_difficulty = select_difficulty_from_logits(candidate_logits)
        return ModelDecision(
            difficulty=lfm_difficulty,
            raw_output=str(lfm_difficulty),
            latency_ms=(time.perf_counter() - started) * 1000,
        )

    def classify_thinking(
        self,
        *,
        client: str,
        prompt: str,
        previous_user_prompt: str,
        previous_assistant_summary: str,
    ) -> ThinkingDecision:
        torch = self.torch
        started = time.perf_counter()
        route_prompt = format_arch_prompt(
            client=client,
            prompt=prompt,
            previous_user_prompt=previous_user_prompt,
            previous_assistant_summary=previous_assistant_summary,
        )
        inputs = self.arch_tokenizer.apply_chat_template(
            [{"role": "user", "content": route_prompt}],
            add_generation_prompt=True,
            tokenize=True,
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
        raw_output = self.arch_tokenizer.batch_decode(
            generated,
            skip_special_tokens=True,
        )[0].strip()
        grade = parse_arch_grade(raw_output, client)
        return ThinkingDecision(
            grade=grade,
            effort=EFFORT_MAP[client][grade],
            latency_ms=(time.perf_counter() - started) * 1000,
        )

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
            "model": LFM_MODEL_ID,
            "thinking": ARCH_MODEL_ID,
            "execution": f"{execution}_same_container",
            "gpu": "L4",
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
            "independent": True,
            "co_located": True,
            "default_execution": "sequential_same_container",
            "model_router": LFM_MODEL_ID,
            "thinking_router": ARCH_MODEL_ID,
        }


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
    image=image,
    secrets=[router_secret, mongodb_secret],
    timeout=900,
)
def benchmark(
    endpoint_url: str,
    runs: int = 3,
    execution: str = "sequential",
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
