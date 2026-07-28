# Privacy

PromptRail Plugins and PromptRail Infinite use different data paths. This disclosure covers the
open-source client configuration and the Modal-hosted Infinite service. Service terms and the
retention schedule remain separate contractual documents.

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

## Infinite hosted mode

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
request or response content. These receipts can appear in PromptRail's private Modal operational
logs; contractual retention and deletion periods are documented separately from this package.

Provider API credentials and supported subscription credentials stay in PromptRail's private Modal
secrets or encrypted control-plane storage and are never returned to the client. Clients receive
only a PromptRail token. During installation the token is accepted through a hidden prompt,
`--token`, or a process environment variable, then stored separately for each selected client in a
mode-0600 user-only file. A mode-0700 helper reads that file and prints the token only to the
client's credential subprocess. The raw token is never written to a project, Codex configuration,
Claude settings, or install state. Safe uninstall deletes unchanged PromptRail-owned token/helper
files and preserves any user-modified artifact instead of deleting it.

By default, the client-facing response exposes `promptrail/infinite`, route ID, policy/catalog
versions, premium-use status, degraded-mode status, and pre-dispatch timing. The separately
activated Infinite client configuration enables the documented `executed-model` diagnostic. In
that mode, the response model, response metadata, and completed stream identify only the provider
and model that actually generated usable output plus its capacity class and whether a fallback was
used. The authenticated model-discovery endpoint exposes only the tenant's selectable public model
aliases, human-readable provider/model names, declared context/output limits, and public capability
flags. It does not expose candidate or connection IDs, credentials, quota or reserve values, ranking
scores, rejected routes, or the internal execution plan. Selecting a direct-free alias disables
semantic and subscription fallback for that request; execution receipts still identify the selected
and executed actor internally without retaining prompt content.

For privacy questions, contact [support@promptrail.ai](mailto:support@promptrail.ai).
