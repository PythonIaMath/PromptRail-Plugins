from __future__ import annotations

import argparse
import json
import os
import ssl
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


CLIENTS = ("codex", "claude")
DIFFICULTY_LABELS = {1: "simple", 2: "standard", 3: "complex"}
MODEL_MAP = {
    "codex": {1: "gpt-5.6-luna", 2: "gpt-5.6-terra", 3: "gpt-5.6-sol"},
    "claude": {1: "claude-sonnet-5", 2: "claude-fable-5", 3: "claude-opus-4-8"},
}
EFFORT_MAP = {
    "codex": {1: "none", 2: "low", 3: "medium", 4: "high", 5: "xhigh", 6: "max"},
    "claude": {1: "low", 2: "medium", 3: "high", 4: "xhigh", 5: "max"},
}


@dataclass(frozen=True)
class QualityCase:
    name: str
    prompt: str
    previous_user_prompt: str
    previous_assistant_summary: str
    expected_difficulty: int
    codex_grade_range: tuple[int, int]
    claude_grade_range: tuple[int, int]

    def grade_range(self, client: str) -> tuple[int, int]:
        return self.codex_grade_range if client == "codex" else self.claude_grade_range


QUALITY_CASES = (
    QualityCase(
        name="acknowledgement",
        prompt="Thanks, that answers my question.",
        previous_user_prompt="What does HTTP 404 mean?",
        previous_assistant_summary="Explained that the requested resource was not found.",
        expected_difficulty=1,
        codex_grade_range=(1, 2),
        claude_grade_range=(1, 1),
    ),
    QualityCase(
        name="structured_extraction",
        prompt=(
            "Extract each invoice number, date, and total from the supplied text and return only "
            "a JSON array matching the provided schema."
        ),
        previous_user_prompt="I will provide ten invoices in plain text.",
        previous_assistant_summary="The output schema and source format are fully specified.",
        expected_difficulty=1,
        codex_grade_range=(2, 2),
        claude_grade_range=(1, 1),
    ),
    QualityCase(
        name="bounded_implementation",
        prompt=(
            "Implement the approved CSV parser in parser.py. The grammar, function signature, "
            "error behavior, and six acceptance tests are already defined. Touch only parser.py."
        ),
        previous_user_prompt="Finalize the parser contract before implementation.",
        previous_assistant_summary="The scope, expected output, boundaries, and finish line are fixed.",
        expected_difficulty=1,
        codex_grade_range=(4, 5),
        claude_grade_range=(2, 3),
    ),
    QualityCase(
        name="everyday_feature",
        prompt=(
            "Add cursor pagination to the user list endpoint, update the repository query, and "
            "cover the happy path and invalid cursor behavior with tests."
        ),
        previous_user_prompt="The API contract and database schema are stable.",
        previous_assistant_summary="Located the endpoint, repository, and existing test fixtures.",
        expected_difficulty=2,
        codex_grade_range=(3, 4),
        claude_grade_range=(2, 3),
    ),
    QualityCase(
        name="well_scoped_multifile_debugging",
        prompt=(
            "Fix the confirmed race between the worker and cache modules, preserve the public "
            "API, and add a deterministic regression test for the lost-write interleaving."
        ),
        previous_user_prompt="Investigate the intermittent lost cache writes.",
        previous_assistant_summary="Confirmed the unsafe shared mutation and identified both files.",
        expected_difficulty=2,
        codex_grade_range=(4, 5),
        claude_grade_range=(3, 4),
    ),
    QualityCase(
        name="ambiguous_hard_debugging",
        prompt=(
            "Find and fix the intermittent production data corruption. Several storage, queue, "
            "and retry paths are plausible; investigate the evidence, prove the root cause, and "
            "verify the repair under failure injection."
        ),
        previous_user_prompt="Customers report rare corrupt records with no reliable reproduction.",
        previous_assistant_summary="Collected logs point to multiple subsystems but no cause yet.",
        expected_difficulty=3,
        codex_grade_range=(4, 5),
        claude_grade_range=(3, 4),
    ),
    QualityCase(
        name="scattered_context_planning",
        prompt=(
            "Synthesize the Slack thread, related issues and pull requests, architecture docs, "
            "code, and git history into a self-contained migration plan. Resolve ambiguities, "
            "identify open decisions and risks, define the finish line, and do not implement yet."
        ),
        previous_user_prompt="We need a plan for the cross-region identity migration.",
        previous_assistant_summary="The relevant context is distributed and the scope is unresolved.",
        expected_difficulty=3,
        codex_grade_range=(6, 6),
        claude_grade_range=(5, 5),
    ),
    QualityCase(
        name="high_stakes_security",
        prompt=(
            "Audit the production token exchange for authorization bypasses, enumerate every "
            "trust boundary and failure mode, propose a safe repair, and design adversarial tests."
        ),
        previous_user_prompt="A suspicious token exchange was observed in production.",
        previous_assistant_summary="The impact could cross tenant boundaries; no exploit is confirmed.",
        expected_difficulty=3,
        codex_grade_range=(5, 6),
        claude_grade_range=(4, 5),
    ),
    QualityCase(
        name="formal_verification",
        prompt=(
            "Prove the lock-free queue is linearizable under the C++ memory model, implement the "
            "verified correction, and add adversarial tests covering every identified execution."
        ),
        previous_user_prompt="The current queue fails under an unknown weak-memory interleaving.",
        previous_assistant_summary="Candidate linearization points remain disputed.",
        expected_difficulty=3,
        codex_grade_range=(6, 6),
        claude_grade_range=(5, 5),
    ),
)

BOUNDARY_CASES = (
    QualityCase(
        "csv_extraction",
        "Extract columns id, email, and status from this CSV into the given JSON schema.",
        "The CSV and exact output schema are attached.",
        "No interpretation is required; preserve source values exactly.",
        1,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "bounded_copy_change",
        "Replace the approved empty-state sentence in account.html. Touch no other text.",
        "Legal approved the replacement sentence.",
        "The target file and exact replacement are fixed.",
        1,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "mechanical_config",
        "Change TIMEOUT from 30 to 45 in config.py and update the one matching assertion.",
        "The timeout increase has been approved.",
        "Located the constant and its single assertion.",
        1,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "retry_implementation",
        "Implement capped exponential retry for the HTTP client and test success, exhaustion, "
        "and non-retryable responses.",
        "Use the existing client abstraction and test fixtures.",
        "The behavior is clear but implementation details remain.",
        2,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "scoped_integration_bug",
        "Fix the webhook integration that drops the signature header during redirects and add "
        "a regression test.",
        "The failing redirect path and missing header are confirmed.",
        "The bug is localized to the webhook HTTP adapter.",
        2,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "approved_two_module_refactor",
        "Apply the approved interface split across parser.py and validator.py, preserve the "
        "public API, and update their tests.",
        "The refactor design was approved in review.",
        "The two modules and compatibility boundary are known.",
        2,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "fixed_plan",
        "Write the implementation checklist for the approved endpoint using the fixed contract, "
        "listed files, agreed sequence, and acceptance tests.",
        "Architecture and product approved the endpoint design.",
        "All decisions are closed; the remaining work is a multi-step plan.",
        2,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "unknown_production_data_loss",
        "Investigate rare production data loss across ingestion, queueing, storage, and retries; "
        "establish the root cause and verify the repair under faults.",
        "Customers are losing records without a reliable reproduction.",
        "Several systems are implicated and no cause is established.",
        3,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "multi_tenant_security",
        "Audit the tenant authorization boundary for cross-tenant access, prove the invariants, "
        "and design adversarial verification before proposing a repair.",
        "A possible tenant isolation failure was reported.",
        "The trust boundaries and exploitability are unresolved.",
        3,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "scattered_architecture",
        "Derive the target event architecture from Slack, issues, old design docs, code, and git "
        "history; resolve contradictions and identify open decisions.",
        "No authoritative architecture document exists.",
        "The relevant evidence is scattered and inconsistent.",
        3,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "architecture_document_extraction_trap",
        "From the architecture document, extract every service name and owner into the provided "
        "two-column table. Do not analyze the design.",
        "The architecture document is complete and authoritative.",
        "This is literal extraction into a fixed table schema.",
        1,
        (1, 6),
        (1, 5),
    ),
    QualityCase(
        "short_high_stakes_corruption",
        "Find why production balances are being corrupted and prove the fix is safe.",
        "The incident is active and the cause is unknown.",
        "Financial correctness is at risk; several write paths are plausible.",
        3,
        (1, 6),
        (1, 5),
    ),
)


def route_request(
    *,
    url: str,
    token: str,
    client: str,
    case: QualityCase,
    execution: str,
) -> tuple[dict[str, Any], float]:
    body = json.dumps(
        {
            "client": client,
            "prompt": case.prompt,
            "previous_user_prompt": case.previous_user_prompt,
            "previous_assistant_summary": case.previous_assistant_summary,
            "execution": execution,
        },
    ).encode()
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "accept": "application/json",
        },
    )
    started = time.perf_counter()
    ssl_context = ssl.create_default_context()
    try:
        import certifi

        ssl_context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    try:
        with urllib.request.urlopen(request, timeout=15 * 60, context=ssl_context) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"route returned HTTP {error.code}: {detail}") from None
    return payload, (time.perf_counter() - started) * 1000


def evaluate_case(client: str, case: QualityCase, payload: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    difficulty = payload.get("difficulty")
    grade = payload.get("thinking_grade")
    tier_pass = difficulty == case.expected_difficulty
    minimum_grade, maximum_grade = case.grade_range(client)
    effort_pass = (
        isinstance(grade, int)
        and not isinstance(grade, bool)
        and minimum_grade <= grade <= maximum_grade
    )

    if not tier_pass:
        errors.append(
            f"expected model tier {case.expected_difficulty}, received {difficulty!r}",
        )
    if not effort_pass:
        errors.append(
            f"expected grade {minimum_grade}..{maximum_grade}, received {grade!r}",
        )
    if difficulty in DIFFICULTY_LABELS:
        if payload.get("difficulty_label") != DIFFICULTY_LABELS[difficulty]:
            errors.append("difficulty_label does not match difficulty")
        if payload.get("model") != MODEL_MAP[client][difficulty]:
            errors.append("model does not match the selected default tier")
    else:
        errors.append("difficulty is outside the supported contract")
    if grade in EFFORT_MAP[client]:
        if payload.get("effort") != EFFORT_MAP[client][grade]:
            errors.append("effort does not match thinking_grade")
    else:
        errors.append("thinking_grade is outside the client contract")
    latency = payload.get("latency_ms")
    if not isinstance(latency, dict) or not all(
        isinstance(latency.get(key), (int, float)) for key in ("model", "thinking", "total")
    ):
        errors.append("latency_ms is incomplete")

    return {
        "client": client,
        "case": case.name,
        "expected_difficulty": case.expected_difficulty,
        "actual_difficulty": difficulty,
        "expected_grade_range": [minimum_grade, maximum_grade],
        "actual_grade": grade,
        "model": payload.get("model"),
        "effort": payload.get("effort"),
        "tier_pass": tier_pass,
        "effort_pass": effort_pass,
        "contract_pass": not any(
            error
            for error in errors
            if not error.startswith("expected model tier")
            and not error.startswith("expected grade")
        ),
        "passed": not errors,
        "errors": errors,
    }


def summarize_latencies(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    p95_index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * 0.95)))
    return {
        "count": len(values),
        "min_ms": round(min(values), 3),
        "mean_ms": round(statistics.fmean(values), 3),
        "p50_ms": round(statistics.median(values), 3),
        "p95_ms": round(ordered[p95_index], 3),
        "max_ms": round(max(values), 3),
    }


def run_quality_eval(
    *,
    url: str,
    token: str,
    execution: str,
    clients: tuple[str, ...] = CLIENTS,
    cases: tuple[QualityCase, ...] | None = None,
) -> dict[str, Any]:
    selected_cases = QUALITY_CASES if cases is None else cases
    results = []
    wall_latencies = []
    model_latencies = []
    thinking_latencies = []
    worker_latencies = []
    overhead_latencies = []
    for client in clients:
        for case in selected_cases:
            payload, wall_ms = route_request(
                url=url,
                token=token,
                client=client,
                case=case,
                execution=execution,
            )
            result = evaluate_case(client, case, payload)
            result["wall_latency_ms"] = round(wall_ms, 3)
            component_latency = payload.get("latency_ms", {})
            model_ms = float(component_latency["model"])
            thinking_ms = float(component_latency["thinking"])
            worker_ms = float(component_latency["total"])
            result["component_latency_ms"] = {
                "model": round(model_ms, 3),
                "thinking": round(thinking_ms, 3),
                "worker": round(worker_ms, 3),
                "network_and_auth": round(wall_ms - worker_ms, 3),
            }
            results.append(result)
            wall_latencies.append(wall_ms)
            model_latencies.append(model_ms)
            thinking_latencies.append(thinking_ms)
            worker_latencies.append(worker_ms)
            overhead_latencies.append(wall_ms - worker_ms)

    total = len(results)
    tier_passes = sum(result["tier_pass"] for result in results)
    effort_passes = sum(result["effort_pass"] for result in results)
    contract_passes = sum(result["contract_pass"] for result in results)
    overall_passes = sum(result["passed"] for result in results)
    return {
        "endpoint": url,
        "execution": execution,
        "cases": total,
        "scores": {
            "model_tier_accuracy": round(tier_passes / total, 4),
            "effort_acceptance": round(effort_passes / total, 4),
            "contract_validity": round(contract_passes / total, 4),
            "overall": round(overall_passes / total, 4),
        },
        "latency": {
            "wall": summarize_latencies(wall_latencies),
            "model": summarize_latencies(model_latencies),
            "thinking": summarize_latencies(thinking_latencies),
            "worker": summarize_latencies(worker_latencies),
            "network_and_auth": summarize_latencies(overhead_latencies),
        },
        "passed": overall_passes == total,
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate live PromptRail routing quality.")
    parser.add_argument("--url", required=True)
    parser.add_argument("--execution", choices=("sequential", "parallel"), default="sequential")
    parser.add_argument("--client", choices=("all", *CLIENTS), default="all")
    parser.add_argument("--suite", choices=("article", "boundary"), default="article")
    args = parser.parse_args()
    token = (
        os.environ.get("PROMPTRAIL_ACCESS_TOKEN", "").strip()
        or os.environ.get("PROMPTRAIL_ROUTER_TOKEN", "").strip()
    )
    if not token:
        parser.error("PROMPTRAIL_ACCESS_TOKEN is required")
    clients = CLIENTS if args.client == "all" else (args.client,)
    report = run_quality_eval(
        url=args.url,
        token=token,
        execution=args.execution,
        clients=clients,
        cases=QUALITY_CASES if args.suite == "article" else BOUNDARY_CASES,
    )
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
