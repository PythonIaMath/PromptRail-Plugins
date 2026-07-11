# Privacy

PromptRail Plugins route reasoning effort without moving provider inference to PromptRail billing.

## Data sent to PromptRail

The `UserPromptSubmit` hook sends the latest user-submitted prompt to PromptRail's hosted routing
service. PromptRail uses it to select an effort grade. Codex routing requests also include the
selected Codex model identifier. Claude routing requests do not send the Claude session ID or
model identifier to the hosted routing service.

The hook also sends a PromptRail access token. Claude Code routing uses the local Claude session ID
only to match a hook decision with local model requests.

## Data kept local

The local proxy forwards provider requests from the user's machine directly to OpenAI or Anthropic.
PromptRail does not receive provider OAuth tokens, provider account identifiers, system prompts,
developer instructions, full transcripts, attachments, tool definitions, or model responses.

The client does not log prompts or provider credentials. Operational logs contain only grade,
effort, and routing latency.

## Local files

Router configuration is stored under `~/.codex/promptrail-router` or
`~/.claude/promptrail-router` with user-only permissions. Uninstall removes the local router
credential and restores the provider configuration when it is safe to do so.

For privacy questions, contact [support@promptrail.ai](mailto:support@promptrail.ai).
