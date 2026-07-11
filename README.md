# PromptRail Plugins

Open-source reasoning-effort routing for Codex and Claude Code, using the subscriptions users
already have.

[PromptRail](https://promptrail.ai) classifies each submitted prompt into an effort grade. A
loopback-only proxy applies that grade to the outgoing model request while preserving the user's
existing ChatGPT or claude.ai authentication.

This repository contains only the client integrations. PromptRail's hosted routing service,
classification technology, evaluation data, and infrastructure are not part of this repository.

## Plugins

| Client | Levels | Subscription |
| --- | ---: | --- |
| Codex | 6 | ChatGPT |
| Claude Code | 5 | claude.ai |

Both integrations fail visibly when routing, authentication, or protocol validation fails. They
do not silently select a default effort or switch to API billing.

## Before installing

You need:

- Node.js 20 or newer.
- A current Codex or Claude Code installation.
- A PromptRail beta access token. Request access at
  [support@promptrail.ai](mailto:support@promptrail.ai).

Never commit your PromptRail access token to a repository or shell script.

## Codex

Codex must be authenticated with ChatGPT:

```bash
codex login status
```

Install from this checkout:

```bash
git clone https://github.com/PythonIaMath/PrompRails-Plugins.git
cd PrompRails-Plugins

node bin/promptrail-codex-router.mjs install \
  --grader-url "https://promptrail--promptrail-codex-effort-grader-effortgrader-web.modal.run" \
  --token "$PROMPTRAIL_ACCESS_TOKEN"
```

Start a new Codex thread after installation.

Check status:

```bash
node bin/promptrail-codex-router.mjs status
```

Uninstall and restore the previous Codex configuration:

```bash
node bin/promptrail-codex-router.mjs uninstall
```

## Claude Code

Claude Code must be using a first-party claude.ai subscription. API credentials and existing
third-party gateways are rejected.

```bash
claude auth status --json
```

Install from this checkout:

```bash
git clone https://github.com/PythonIaMath/PrompRails-Plugins.git
cd PrompRails-Plugins

node bin/promptrail-claude-router.mjs install \
  --grader-url "https://promptrail--promptrail-claude-effort-grader-claudeeffort-f35715.modal.run" \
  --token "$PROMPTRAIL_ACCESS_TOKEN"
```

Start a new Claude Code session after installation.

Check status:

```bash
node bin/promptrail-claude-router.mjs status
```

Uninstall and restore the previous Claude settings:

```bash
node bin/promptrail-claude-router.mjs uninstall
```

## Privacy and trust boundary

The local proxies necessarily see the provider bearer token in memory while forwarding a request.
They never send provider credentials to PromptRail.

PromptRail receives:

- the latest user prompt;
- the selected Codex model identifier for Codex routing requests;
- the PromptRail access token.

PromptRail does not receive:

- ChatGPT or Claude OAuth credentials;
- account identifiers;
- developer or system instructions;
- complete conversation history;
- model responses.

The proxies bind only to `127.0.0.1`, restrict forwarded paths, avoid prompt and credential logs,
and store local configuration with user-only permissions.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before installing.

## Development

Run every client test:

```bash
npm test
```

Validate the Codex plugin:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py \
  plugins/promptrail-codex-router
```

Validate the Claude plugin and marketplace:

```bash
claude plugin validate plugins/promptrail-claude-router
claude plugin validate .
```

## Contributing

Issues and pull requests for the client integrations are welcome. The hosted routing service is
maintained separately and is outside the scope of this repository.

See [CONTRIBUTING.md](CONTRIBUTING.md).
