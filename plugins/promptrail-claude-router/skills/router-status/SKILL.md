---
name: router-status
description: Check whether the PromptRail Claude effort router is installed, configured, and healthy.
disable-model-invocation: true
---

# PromptRail Claude Router Status

Run the plugin status script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

Report the proxy address, subscription-only mode, five-grade contract, grader host, and health.
Never print the router token, Claude authorization headers, prompts, or responses.
