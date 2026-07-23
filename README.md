# PromptRail Plugins and Infinite

Open-source model and reasoning-effort routing for Codex and Claude Code, using the subscriptions
users already have.

[PromptRail](https://www.promptrail.ai/plugins) classifies each submitted prompt into an effort grade. A
loopback-only proxy applies that grade to the outgoing model request while preserving the user's
existing ChatGPT or claude.ai authentication.

This repository contains the client integrations plus the self-hosted model-and-thinking router,
its prompt-optimization workflow, and reproducible routing-quality evaluations. Customer account
services and production infrastructure remain separate from this repository.

## Product modes

`plugins` is the existing product: it keeps provider inference on the user's machine through a
loopback proxy and uses their ChatGPT or claude.ai subscription. It remains the default mode.

`infinite` is the future hosted PromptRail provider mode. Phase 1 provides only safe local
configuration generation; it does not enable or advertise live Infinite inference. It uses the
single virtual model name `promptrail/infinite`, never starts the existing local proxy, and never
writes `PROMPTRAIL_API_KEY` to a project or configuration file.

## Plugins

| Client | Levels | Subscription |
| --- | ---: | --- |
| Codex | 6 | ChatGPT |
| Claude Code | 5 | claude.ai |

Both integrations fail visibly when routing, authentication, or protocol validation fails. They
do not silently select a default effort or switch to API billing.

## Quick install

Install both integrations with one shared PromptRail token:

```bash
npx @promptrail/plugins
```

Do not use `npm i @promptrail/plugins` as the setup command. npm runs dependency lifecycle scripts
without a reliable interactive terminal, so it cannot safely request the access token. Use the
`npx` command above, which opens the secure token prompt directly.

This is equivalent to `npx @promptrail/plugins install plugins both`. The installer asks for your token
without echoing it. For automated installs:

```bash
PROMPTRAIL_ACCESS_TOKEN="..." npx @promptrail/plugins
```
Get your access token at [promptrail.ai/plugins](https://www.promptrail.ai/plugins).

Check or remove an installation with `status` or `uninstall`:

```bash
npx @promptrail/plugins status both
npx @promptrail/plugins uninstall both
```

## Infinite configuration preview

When Infinite access is available, its separate configuration can be generated explicitly:

```bash
npx @promptrail/plugins install infinite both
```

This configures Codex with `promptrail/infinite` and a PromptRail Responses provider, and Claude
Code with the PromptRail base URL and model. Set `PROMPTRAIL_API_KEY` in your user environment;
the installer does not store it. Switching modes is explicit and first restores the other mode's
managed settings:

```bash
npx @promptrail/plugins switch plugins
npx @promptrail/plugins switch infinite
```

Do not use Infinite for real inference until the hosted service and entitlement are released.

## Before installing

You need:

- Node.js 18.19 or newer.
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
  --grader-url "https://promptrail--codexandclaudeplugin-colocatedrouterv7-route-v7.modal.run" \
  --token "$PROMPTRAIL_ACCESS_TOKEN"
```

Start a new Codex thread after installation.

Check status:

```bash
node bin/promptrail-codex-router.mjs status
```

Uninstall PromptRail and restore its previous Codex values while preserving unrelated changes:

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
  --grader-url "https://promptrail--codexandclaudeplugin-colocatedrouterv7-route-v7.modal.run" \
  --token "$PROMPTRAIL_ACCESS_TOKEN"
```

Start a new Claude Code session after installation.

Check status:

```bash
node bin/promptrail-claude-router.mjs status
```

Uninstall PromptRail and restore its previous Claude values while preserving unrelated changes:

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

Run the model-and-thinking router tests:

```bash
python3 -m pytest workers/model-thinking-router/tests -q
```

See the [router worker guide](workers/model-thinking-router/README.md) for its architecture,
deployment, benchmarks, and prompt-optimization workflow.

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
