# Changelog

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
