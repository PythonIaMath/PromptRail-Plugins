from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class OptimizationCase:
    case_id: str
    category: str
    prompt: str
    previous_user_prompt: str
    previous_assistant_summary: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


DOMAINS = (
    "payments API",
    "identity service",
    "mobile checkout",
    "analytics pipeline",
    "notification worker",
    "document parser",
    "search indexer",
    "billing dashboard",
    "deployment controller",
    "customer support tool",
)


SCENARIOS = (
    (
        "context_shift_date",
        "Which day are we?",
        "Review the unresolved security and routing failures in the {domain}.",
        "The prior task remains difficult and open-ended, but the new request may change topics.",
    ),
    (
        "context_shift_acknowledgement",
        "Thanks, that answers my question.",
        "Design a multi-region recovery architecture for the {domain}.",
        "Completed a deep architecture analysis with several unresolved tradeoffs.",
    ),
    (
        "context_shift_definition",
        "What does HTTP 404 mean?",
        "Prove the concurrency invariants for the {domain}.",
        "The earlier proof required extensive investigation and formal reasoning.",
    ),
    (
        "context_shift_status",
        "Is the installation currently healthy?",
        "Diagnose intermittent data corruption in the {domain}.",
        "The earlier debugging task had several plausible causes and scattered evidence.",
    ),
    (
        "classification",
        "Classify these ten support messages into the supplied five labels and return JSON only.",
        "Prepare a fixed label taxonomy for the {domain}.",
        "The labels, JSON schema, and examples are complete and unambiguous.",
    ),
    (
        "structured_extraction",
        "Extract the IDs, dates, and totals into the supplied JSON schema. Do not infer missing values.",
        "Process records exported from the {domain}.",
        "The source format and output schema are fully specified.",
    ),
    (
        "mechanical_rename",
        "Rename `legacyResult` to `parsedResult` in the identified function and change nothing else.",
        "Clean up one local variable in the {domain}.",
        "The exact file, function, old name, and new name were identified.",
    ),
    (
        "copy_edit",
        "Change the empty-state text to `No results yet` and update the matching snapshot.",
        "Polish one screen in the {domain}.",
        "The component and expected copy are known.",
    ),
    (
        "data_transformation",
        "Convert the supplied CSV rows to the documented JSON shape and preserve their order.",
        "Transform an export from the {domain}.",
        "The mapping is one-to-one and all fields are documented.",
    ),
    (
        "fixed_implementation",
        "Implement the approved parser. Its grammar, API, error behavior, and acceptance tests are fixed.",
        "Finalize the parser contract for the {domain}.",
        "All design decisions and the finish line are settled.",
    ),
    (
        "everyday_feature",
        "Add cursor pagination to the list endpoint and cover valid and invalid cursors with tests.",
        "Improve list performance in the {domain}.",
        "The API contract, repository layer, and existing fixtures are understood.",
    ),
    (
        "test_implementation",
        "Add unit tests for the documented validation branches, including the two named edge cases.",
        "Increase coverage for the {domain}.",
        "The target function and expected behavior are already known.",
    ),
    (
        "ordinary_explanation",
        "Explain why this assertion fails and show the smallest correct fix.",
        "Investigate one failing test in the {domain}.",
        "The failure output and relevant function have been isolated.",
    ),
    (
        "confirmed_bug",
        "Fix the confirmed stale-cache write in the two identified modules and add a deterministic regression test.",
        "Investigate lost updates in the {domain}.",
        "The root cause and affected modules are confirmed.",
    ),
    (
        "scoped_refactor",
        "Refactor the three named adapters behind the existing interface, preserve behavior, and update tests.",
        "Reduce duplication in the {domain}.",
        "The boundary, interface, and acceptance suite are established.",
    ),
    (
        "ambiguous_debugging",
        "Find and fix the intermittent corruption. Storage, retries, and queue ordering are all plausible causes.",
        "Customers report rare failures in the {domain}.",
        "Evidence spans several subsystems and no root cause has been established.",
    ),
    (
        "open_architecture",
        "Design a multi-region authorization architecture, resolve consistency tradeoffs, and define failure modes.",
        "The {domain} must expand globally.",
        "Requirements conflict and the architecture is not yet chosen.",
    ),
    (
        "security_audit",
        "Audit the production token exchange, establish exploitability, and propose a verified remediation plan.",
        "A suspicious authorization path was found in the {domain}.",
        "Trust boundaries and the severity of the issue remain unresolved.",
    ),
    (
        "scattered_planning",
        "Synthesize the Slack thread, issues, PRs, docs, code, and git history into a migration plan with open decisions.",
        "Plan a major migration for the {domain}.",
        "The relevant context is scattered and contains contradictions.",
    ),
    (
        "formal_verification",
        "Prove the lock-free algorithm linearizable under the memory model, implement it, and verify adversarial interleavings.",
        "Replace the critical queue in the {domain}.",
        "Correctness is high-stakes and requires proof plus tested implementation.",
    ),
)


def build_optimization_cases() -> tuple[OptimizationCase, ...]:
    cases = []
    for scenario_index, (category, prompt, previous_user, previous_summary) in enumerate(SCENARIOS):
        for domain_index, domain in enumerate(DOMAINS):
            cases.append(
                OptimizationCase(
                    case_id=f"{scenario_index + 1:02d}-{domain_index + 1:02d}-{category}",
                    category=category,
                    prompt=prompt.format(domain=domain),
                    previous_user_prompt=previous_user.format(domain=domain),
                    previous_assistant_summary=previous_summary.format(domain=domain),
                ),
            )
    return tuple(cases)


def split_optimization_cases(
    cases: tuple[OptimizationCase, ...] | None = None,
) -> dict[str, tuple[OptimizationCase, ...]]:
    selected = build_optimization_cases() if cases is None else cases
    by_category: dict[str, list[OptimizationCase]] = {}
    for case in selected:
        by_category.setdefault(case.category, []).append(case)
    if any(len(category_cases) != 10 for category_cases in by_category.values()):
        raise ValueError("each optimization category must contain exactly ten cases")
    return {
        "train": tuple(case for values in by_category.values() for case in values[:6]),
        "validation": tuple(case for values in by_category.values() for case in values[6:8]),
        "test": tuple(case for values in by_category.values() for case in values[8:]),
    }
