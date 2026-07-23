---
"@promptrail/plugins": patch
---

Prevent uninstall regression tests from calling the host machine's real launchd or systemd service manager. The test harness now isolates those commands so running the package test suite cannot stop an installed PromptRail router.
