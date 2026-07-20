---
"@promptrail/plugins": patch
---

Make uninstall idempotent, support Linux containers without systemd, skip unavailable clients during combined setup, and remove the unreliable interactive npm postinstall hook. Use the explicit `npx @promptrail/plugins` setup command instead.
