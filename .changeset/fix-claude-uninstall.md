---
"@promptrail/plugins": patch
---

Fix Codex and Claude Code uninstall so they preserve unrelated configuration changes while removing PromptRail's gateway, plugin, marketplace, service, credential, and install artifacts. Cleanup is now idempotent, removes detached orphan proxies, rejects false-positive proxy startup, and retains recovery state when an uninstall cannot finish.
