---
"@promptrail/plugins": minor
---

Add the hosted PromptRail Infinite mode for Codex and Claude Code. Codex can switch to the HTTPS
Responses gateway without a local proxy, portable client state stays inside `CODEX_HOME`, uninstall
preflights a marketplace-capable Codex CLI before changing local state, skips obsolete Codex
binaries earlier on `PATH`, and removes managed router runtime files. Claude Code uses a user-only
key helper that reads `PROMPTRAIL_API_KEY` without storing the key in settings or project files.
