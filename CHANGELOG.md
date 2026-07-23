# Changelog

## 1.4.1

### Patch Changes

- 5beb4eb: Fix Codex and Claude Code uninstall so they preserve unrelated configuration changes while removing PromptRail's gateway, plugin, marketplace, service, credential, and install artifacts. Cleanup is now idempotent, removes detached orphan proxies, rejects false-positive proxy startup, and retains recovery state when an uninstall cannot finish.

## 1.4.0

### Minor Changes

- db27bc1: Route Codex and Claude requests through the new parallel Gemma and ArchRouter stack. The router now selects model family and model-specific thinking grade independently, applies the server grade directly without client-side arithmetic or grade coercion, preserves bounded prior-turn context, and includes reproducible prompt-optimization and blind routing-quality evaluation tooling.

## 1.3.6

### Patch Changes

- 91aaa86: Report skipped or not-installed clients cleanly from `promptrail status both`.

## 1.3.5

### Patch Changes

- 8303b65: Skip Claude cleanly during combined setup when Claude Code is installed but not logged in, and support Node.js 18.19 environments.

## 1.3.4

### Patch Changes

- ab2fc54: Make uninstall idempotent, support Linux containers without systemd, skip unavailable clients during combined setup, and remove the unreliable interactive npm postinstall hook. Use the explicit `npx @promptrail/plugins` setup command instead.

## 1.3.3

### Patch Changes

- 4c9f65b: Prompt for the access token during interactive npm installs and use the combined Codex and Claude setup by default.

## 1.3.2

### Patch Changes

- e506fd3: Update the package description, production routing endpoint, warm-container deployment, and hook output showing the selected model and thinking level.
- Make the combined Codex and Claude installer the default and only top-level install path.
- Reuse one PromptRail token to configure both client integrations.

## 1.3.1

### Patch Changes

- Route every Claude Code inference request through the production LFM2 model-tier and ArchRouter thinking worker. The router now selects and applies the Claude model and effort together, preserves compact prior-turn context, and displays both choices in the submitted-prompt hook.

## 1.3.0

### Minor Changes

- Add contextual model and thinking routing for Codex. Each request is independently routed with the current prompt and the previous user and assistant turn, while preserving the user's native Luna, Terra, and Sol models.
- Add the co-located LFM2 model-tier and ArchRouter reasoning-grade worker, including multi-turn routing benchmarks and regression coverage.

## 1.2.2

### Patch Changes

- 20b7783: Link the installer documentation directly to the PromptRail access-token page.

## 1.2.1

### Patch Changes

- 7233cb6: Add the PromptRail plugins page link to the published Codex and Claude plugin descriptions.

## 1.2.0

### Minor Changes

- 9e5bc09: Improve Codex effort selection by reserving `none` for genuinely trivial prompts and providing ArchRouter with the previous user prompt and assistant reasoning summary when available.

## 1.1.2

### Patch Changes

- 34ebdb2: Keep Claude Code sessions that were already running during installation working by grading their latest user prompt directly when no hook-selected route is cached.

## 1.1.1

### Patch Changes

- Include the Claude Code marketplace manifest in the published npm package.

## 1.1.0

### Minor Changes

- Automate npm releases, package versioning, and changelog updates with Changesets.

All notable changes to PromptRail Plugins are documented here.

## [0.1.0.0] - 2026-07-10

### Added

- Installable PromptRail reasoning-effort router for Codex using ChatGPT subscription authentication.
- Installable PromptRail effort router for Claude Code using claude.ai subscription authentication.
- Public Codex and Claude marketplace catalogs, reversible installers, local services, and status checks.
- Strict subscription-only enforcement, authenticated routing, and regression tests for both clients.
- One-command npm installer for Codex and Claude Code with hidden token entry and production defaults.
- Automatic detection of a Codex CLI that supports plugin installation.
- Direct routing for Codex Desktop background requests that do not invoke the prompt hook, preventing stale 409 errors.
