from __future__ import annotations

import argparse
import json
import ssl
import urllib.request
from typing import Any

import certifi


CONTRASTS = [
    {
        "name": "do_it",
        "prompt": "Do it.",
        "low": {
            "previous_user_prompt": "Rename the local variable from data to profile.",
            "previous_assistant_summary": "Located the single variable occurrence; only the rename remains.",
        },
        "high": {
            "previous_user_prompt": "Fix the intermittent race that loses cache writes across workers.",
            "previous_assistant_summary": "Found unsafe shared mutation across worker and cache modules; implement and verify the synchronization fix.",
        },
    },
    {
        "name": "continue",
        "prompt": "Continue.",
        "low": {
            "previous_user_prompt": "Move the three animated dots two pixels lower.",
            "previous_assistant_summary": "Adjusted the CSS offset; only a visual check remains.",
        },
        "high": {
            "previous_user_prompt": "Prove this lock-free queue is linearizable under the C++ memory model.",
            "previous_assistant_summary": "Outlined candidate linearization points; the proof and adversarial implementation tests remain.",
        },
    },
    {
        "name": "fix_it",
        "prompt": "Fix it.",
        "low": {
            "previous_user_prompt": "Correct the typo in the signup button label.",
            "previous_assistant_summary": "Found the label in one component; replace the misspelled word.",
        },
        "high": {
            "previous_user_prompt": "Repair the authorization bypass in the production token exchange.",
            "previous_assistant_summary": "Confirmed an attacker can exchange an unscoped token; patch all validation paths and add security regression tests.",
        },
    },
]


def call_route(endpoint: str, token: str, prompt: str, context: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps({"client": "codex", "prompt": prompt, **context}).encode(),
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "accept": "application/json",
        },
    )
    with urllib.request.urlopen(
        request,
        timeout=180,
        context=ssl.create_default_context(cafile=certifi.where()),
    ) as response:
        return json.loads(response.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    results = []
    model_sensitive = 0
    thinking_sensitive = 0
    ordered = 0
    for contrast in CONTRASTS:
        low = call_route(args.url, args.token, contrast["prompt"], contrast["low"])
        high = call_route(args.url, args.token, contrast["prompt"], contrast["high"])
        model_changed = low["difficulty"] != high["difficulty"]
        thinking_changed = low["thinking_grade"] != high["thinking_grade"]
        correctly_ordered = (
            high["difficulty"] >= low["difficulty"]
            and high["thinking_grade"] > low["thinking_grade"]
        )
        model_sensitive += model_changed
        thinking_sensitive += thinking_changed
        ordered += correctly_ordered
        results.append(
            {
                "contrast": contrast["name"],
                "prompt": contrast["prompt"],
                "low_context": {
                    "model_tier": low["difficulty"],
                    "thinking_grade": low["thinking_grade"],
                },
                "high_context": {
                    "model_tier": high["difficulty"],
                    "thinking_grade": high["thinking_grade"],
                },
                "model_changed": model_changed,
                "thinking_changed": thinking_changed,
                "correctly_ordered": correctly_ordered,
            }
        )

    print(
        json.dumps(
            {
                "contrasts": len(CONTRASTS),
                "model_context_sensitive": model_sensitive,
                "thinking_context_sensitive": thinking_sensitive,
                "correctly_ordered": ordered,
                "results": results,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
