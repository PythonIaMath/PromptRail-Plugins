---
"@promptrail/plugins": minor
---

Route Codex and Claude requests through the new parallel Gemma and ArchRouter stack. The router now selects model family and model-specific thinking grade independently, applies the server grade directly without client-side arithmetic or grade coercion, preserves bounded prior-turn context, and includes reproducible prompt-optimization and blind routing-quality evaluation tooling.
