# Privacy

PromptRail Plugins and PromptRail Infinite use different data paths. This disclosure covers the
open-source client configuration and the private Modal-hosted Infinite beta. It is not a substitute
for the final public service terms and retention schedule, which must be published before a public
subscriber beta is enabled.

## Plugins mode

Plugins routes reasoning effort without moving provider inference through PromptRail.

### Data sent to PromptRail

The `UserPromptSubmit` hook sends the latest user-submitted prompt to PromptRail's hosted routing
service. PromptRail uses it to select a model and effort grade. Codex and Claude proxy routing also
send the immediately previous user prompt, up to 2,000 characters of the previous assistant summary
or text response, and the current model identifier when those values are available. They do not
send the complete assistant response. Claude routing requests do not send the Claude session ID to
the hosted routing service.

The hook also sends a PromptRail access token. Claude Code routing uses the local Claude session ID
only to match a hook decision with local model requests.

### Data kept local

The local proxy forwards provider requests from the user's machine directly to OpenAI or Anthropic.
PromptRail does not receive provider OAuth tokens, provider account identifiers, system prompts,
developer instructions, full transcripts, attachments, tool definitions, or complete model
responses beyond the bounded previous-assistant context described above.

The client does not log prompts or provider credentials. Operational logs contain only grade,
effort, and routing latency.

### Local files

Router configuration is stored under `~/.codex/promptrail-router` or
`~/.claude/promptrail-router` with user-only permissions. Uninstall removes the local router
credential and PromptRail-owned client settings while preserving unrelated configuration changes.

## Infinite hosted beta

Infinite sends the request through the PromptRail gateway because PromptRail performs provider
execution server-side. The request can include system instructions, messages, tool definitions,
tool results, structured-output settings, reasoning controls, and attachments supplied by the
coding harness. PromptRail forwards only the protocol data needed by the selected declared route.

Raw prompts, full responses, attachments, authorization headers, provider credentials, and full
tool arguments are not written to PromptRail logs or retained by PromptRail by default. They are
processed transiently in the gateway and by the selected upstream provider. Modal and that provider
also process request and network metadata under their own terms.

The gateway records sanitized execution receipts containing the route and tenant IDs; policy and
catalog versions; selected and executed internal model IDs; capacity class; whether premium or
degraded free-only capacity was used; hashed connection IDs; attempt results and latency; token
counts; estimated cost; and decision, pre-dispatch, and total latency. Receipts do not contain raw
request or response content. During the private beta these receipts can appear in the operator's
private Modal logs; production retention and deletion periods are not yet promised.

The private beta stores the user's OpenRouter key and Codex OAuth bundle in that user's own Modal
workspace secrets. Clients receive only a PromptRail gateway key. The public installer never writes
that key into a project, Codex configuration, or Claude settings. Codex reads
`PROMPTRAIL_API_KEY` directly. Claude Code uses a user-only executable helper that reads the same
environment variable and prints it only to Claude Code's credential subprocess. Modified helpers
are preserved during uninstall.

The client-facing response exposes `promptrail/infinite`, route ID, policy/catalog versions,
premium-use status, degraded-mode status, and pre-dispatch timing. Underlying route details are not
returned to the coding harness unless a future diagnostic mode is explicitly documented and
enabled.

For privacy questions, contact [support@promptrail.ai](mailto:support@promptrail.ai).
