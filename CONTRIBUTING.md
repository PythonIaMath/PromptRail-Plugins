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

### npm publishing

Publishing is automated through the existing `NPM_TOKEN` GitHub Actions secret. After a changeset
is merged to `main`, the release workflow creates the release pull request; merging that release
pull request publishes the package to npm.

After that, merge the Changesets release pull request on `main`. The release workflow uses GitHub
OIDC to publish without storing an npm token in GitHub Secrets.

Keep pull requests scoped to the client integrations. Do not add hosted classifier code, model
identifiers, routing prompts, evaluation data, credentials, or private infrastructure details.

Bug fixes should include a regression test. Never add real provider credentials or PromptRail
access tokens to fixtures.
