from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from collections import defaultdict
from typing import Any

CASES = [
    ("simple", "Thanks!"),
    ("standard", "Add pagination to the user list and cover it with tests."),
    (
        "complex",
        "Design a multi-region authorization service, define failure modes, migrate existing "
        "sessions without downtime, and verify the security invariants.",
    ),
]


def percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def call_route(url: str, token: str, client: str, prompt: str) -> tuple[dict[str, Any], float]:
    body = json.dumps(
        {
            "client": client,
            "prompt": prompt,
            "previous_user_prompt": "Route the next standalone engineering request.",
            "previous_assistant_summary": (
                "No implementation has started; classify the next request."
            ),
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
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"route returned HTTP {error.code}: {detail}") from error
    return payload, (time.perf_counter() - started) * 1000


def summarize(values: list[float]) -> dict[str, float]:
    return {
        "count": len(values),
        "min_ms": round(min(values), 3),
        "mean_ms": round(statistics.fmean(values), 3),
        "p50_ms": round(percentile(values, 0.50), 3),
        "p95_ms": round(percentile(values, 0.95), 3),
        "max_ms": round(max(values), 3),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=2)
    args = parser.parse_args()
    if args.runs < 1 or args.warmup < 0:
        parser.error("--runs must be positive and --warmup must be non-negative")

    measurements: dict[str, list[float]] = defaultdict(list)
    component_measurements: dict[str, list[float]] = defaultdict(list)
    selections: list[dict[str, Any]] = []

    for client in ("codex", "claude"):
        for case_name, prompt in CASES:
            for iteration in range(args.warmup + args.runs):
                payload, wall_ms = call_route(args.url, args.token, client, prompt)
                if iteration < args.warmup:
                    continue
                key = f"{client}:{case_name}"
                measurements[key].append(wall_ms)
                component_measurements[f"{key}:model"].append(payload["latency_ms"]["model"])
                component_measurements[f"{key}:thinking"].append(payload["latency_ms"]["thinking"])
                component_measurements[f"{key}:worker"].append(payload["latency_ms"]["total"])
                selections.append(
                    {
                        "case": key,
                        "model": payload["model"],
                        "difficulty": payload["difficulty"],
                        "effort": payload["effort"],
                    },
                )

    report = {
        "endpoint": args.url,
        "runs_per_case": args.runs,
        "wall_latency": {key: summarize(values) for key, values in measurements.items()},
        "component_latency": {
            key: summarize(values)
            for key, values in component_measurements.items()
        },
        "selections": selections,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
