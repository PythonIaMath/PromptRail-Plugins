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

## Quick install

Install the Codex router with one command:

```bash
npx @promptrail/plugins install codex
```

The installer asks for the PromptRail access token without echoing it. Get your access token at
[promptrail.ai/plugins](https://www.promptrail.ai/plugins). For automated installs, provide the
token through the environment:

```bash
PROMPTRAIL_ACCESS_TOKEN="..." npx @promptrail/plugins install codex
```

Claude Code uses the same command shape:

```bash
npx @promptrail/plugins install claude
```

Check or remove an installation with `status` or `uninstall`:

```bash
npx @promptrail/plugins status codex
npx @promptrail/plugins uninstall codex
```

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

The quick installer above is recommended. To install from a source checkout instead:

```bash
git clone https://github.com/PythonIaMath/PromptRail-Plugins.git
cd PromptRail-Plugins

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

The quick installer above is recommended. To install from a source checkout instead:

```bash
git clone https://github.com/PythonIaMath/PromptRail-Plugins.git
cd PromptRail-Plugins

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

## Privacy 

PromptRail does not store or sell any of your data.

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
