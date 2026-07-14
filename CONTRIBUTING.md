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

Add a changeset for every user-facing change:

```bash
npm run changeset
```

Choose whether the change is a `patch`, `minor`, or `major` release and enter
a concise summary. The release workflow uses that entry to update the package
version and `CHANGELOG.md`, then publishes the release to npm.

Keep pull requests scoped to the client integrations. Do not add hosted classifier code, model
identifiers, routing prompts, evaluation data, credentials, or private infrastructure details.

Bug fixes should include a regression test. Never add real provider credentials or PromptRail
access tokens to fixtures.
