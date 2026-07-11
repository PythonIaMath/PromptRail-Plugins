---
name: router-status
description: Check whether the PromptRail Codex reasoning router is installed, configured, and healthy.
---

# PromptRail router status

Run:

```bash
node "$PLUGIN_ROOT/scripts/status.mjs"
```

Report the active proxy address, subscription-only enforcement, grader endpoint host,
and number of available grades. Never print the router token, OpenAI authorization
header, ChatGPT account ID, or prompt contents.
