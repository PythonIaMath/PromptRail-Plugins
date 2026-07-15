# Changelog

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
