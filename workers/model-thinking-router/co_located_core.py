from __future__ import annotations

import json
import re
from typing import Any

from router_core import RouteValidationError, conversation_messages, validate_client

ARCH_TASK_INSTRUCTION = """
You are a helpful assistant designed to find the best suited route.
You are provided with route descriptions within <routes></routes> XML tags:
<routes>

{routes}

</routes>

<conversation>

{conversation}

</conversation>
"""

ARCH_FORMAT_PROMPT = """
Your task is to decide which route best suits the latest user intent in the
<conversation></conversation> XML tags. Follow these instructions:
1. Analyze every route description and choose the closest required effort.
2. Prefer the lower route only when it can complete the task reliably.
3. Respond with only the exact route name in JSON: {"route": "route_name"}.
"""

CODEX_ROUTES = [
    {
        "name": "1",
        "description": (
            "Thanks, greetings, acknowledgements, direct status, or short factual definitions. "
            "No engineering work."
        ),
    },
    {
        "name": "2",
        "description": (
            "One obvious mechanical local edit, such as rename, formatting, or copy update."
        ),
    },
    {
        "name": "3",
        "description": (
            "Ordinary explanation, contained implementation, input validation, feature, tests, "
            "or one unit-test failure."
        ),
    },
    {
        "name": "4",
        "description": (
            "Multi-file debugging or refactoring, races, concurrency, or substantial analysis. "
            "Example: refactor authentication across API, service, and persistence."
        ),
    },
    {
        "name": "5",
        "description": (
            "Architecture, security or cryptographic review, distributed systems, migration, "
            "failure modes, or invariant analysis."
        ),
    },
    {
        "name": "6",
        "description": (
            "Only extreme formal proof or memory-model correctness plus verified implementation. "
            "Never use for an ordinary security review."
        ),
    },
]

CLAUDE_ROUTES = [
    {
        "name": "1",
        "description": (
            "Thanks, greetings, short definitions, or one mechanical local edit such as rename."
        ),
    },
    {
        "name": "2",
        "description": (
            "Explain an ordinary failure, implement a normal feature, add tests, or make a "
            "contained engineering change."
        ),
    },
    {
        "name": "3",
        "description": (
            "Multi-file debugging or refactoring, architecture, distributed systems, migrations, "
            "failure modes, or broad correctness analysis. Cross-layer refactors belong here."
        ),
    },
    {
        "name": "4",
        "description": (
            "Security or cryptographic review, high-stakes vulnerabilities, or unusually deep "
            "analysis with serious consequences."
        ),
    },
    {
        "name": "5",
        "description": (
            "Only extreme formal proof or memory-model reasoning plus verified implementation."
        ),
    },
]

_GRADE_PATTERN = re.compile(r"(?:^|\D)([1-6])(?:\D|$)")


def routes_for_client(client: Any) -> list[dict[str, str]]:
    normalized = validate_client(client)
    return CODEX_ROUTES if normalized == "codex" else CLAUDE_ROUTES


def build_conversation(
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
) -> list[dict[str, str]]:
    return conversation_messages(
        prompt,
        previous_user_prompt,
        previous_assistant_summary,
    )


def format_arch_prompt(
    *,
    client: Any,
    prompt: Any,
    previous_user_prompt: Any,
    previous_assistant_summary: Any,
) -> str:
    routes = routes_for_client(client)
    conversation = build_conversation(
        prompt,
        previous_user_prompt,
        previous_assistant_summary,
    )
    return (
        ARCH_TASK_INSTRUCTION.format(
            routes=json.dumps(routes, separators=(",", ":")),
            conversation=json.dumps(conversation, separators=(",", ":")),
        )
        + ARCH_FORMAT_PROMPT
    )


def parse_arch_grade(raw_output: Any, client: Any) -> int:
    normalized_client = validate_client(client)
    maximum = 6 if normalized_client == "codex" else 5
    text = str(raw_output or "").strip()
    if not text:
        raise RouteValidationError("ArchRouter returned an empty route.")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        route = payload.get("route")
        if isinstance(route, int):
            grade = route
        elif isinstance(route, str) and route.strip().isdigit():
            grade = int(route.strip())
        else:
            grade = 0
        if 1 <= grade <= maximum:
            return grade

    match = _GRADE_PATTERN.search(text)
    if match:
        grade = int(match.group(1))
        if 1 <= grade <= maximum:
            return grade
    raise RouteValidationError(
        f"ArchRouter returned an invalid {normalized_client} route: {text[:120]!r}",
    )
