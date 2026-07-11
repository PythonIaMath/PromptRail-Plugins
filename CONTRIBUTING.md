# Contributing

Thank you for improving PromptRail's open-source client integrations.

## Setup

Requirements:

- Node.js 20 or newer
- Python 3 for Codex manifest validation
- Claude Code for Claude plugin validation

Run tests before opening a pull request:

```bash
npm test
```

Keep pull requests scoped to the client integrations. Do not add hosted classifier code, model
identifiers, routing prompts, evaluation data, credentials, or private infrastructure details.

Bug fixes should include a regression test. Never add real provider credentials or PromptRail
access tokens to fixtures.
