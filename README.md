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
loopback proxy and uses their ChatGPT or claude.ai subscription. It remains available through the
explicit `install plugins` and `switch plugins` commands.

`infinite` is the PromptRail provider mode. The public package provides safe configuration only;
the current usable target is an explicitly deployed private Modal-hosted beta, not a public hosted
production endpoint. It keeps `promptrail/infinite` as the default automatic model and can add
tenant-authorized direct-free aliases to the client model picker. It never starts the existing
Plugins proxy and never writes `PROMPTRAIL_API_KEY` to a project or configuration file.
It is the default mode for new installs. Running the bare package command safely switches existing
managed Plugins installations to Infinite before installing the hosted configuration.

## Plugins

| Client | Levels | Subscription |
| --- | ---: | --- |
| Codex | 6 | ChatGPT |
| Claude Code | 5 | claude.ai |

Both integrations fail visibly when routing, authentication, or protocol validation fails. They
do not silently select a default effort or switch to API billing.

## Quick install or migration

Install Infinite for both clients, or safely migrate an existing managed Plugins installation:

```bash
export PROMPTRAIL_API_KEY="..."
npx --yes @promptrail/plugins@latest
```

Do not use `npm i @promptrail/plugins` as the setup command: it only downloads the package and does
not run PromptRail's safe configuration migration. Use the `npx` command above.

The bare command is equivalent to `npx --yes @promptrail/plugins@latest switch infinite both`.
It restores the package-managed Plugins configuration first, preserves unrelated user settings,
then installs Infinite. The API key remains in the user's environment and is never written to a
project file.

To install the local Plugins mode instead, select it explicitly. The installer asks for its token
without echoing it:

```bash
PROMPTRAIL_ACCESS_TOKEN="..." npx --yes @promptrail/plugins@latest install plugins both
```
Get your access token at [promptrail.ai/plugins](https://www.promptrail.ai/plugins).

Check or remove an installation with `status` or `uninstall`:

```bash
npx --yes @promptrail/plugins@latest status both
npx --yes @promptrail/plugins@latest uninstall both
```

If a machine previously cached an older PromptRail release, force npm to refresh registry metadata before
uninstalling:

```bash
npm exec --yes --prefer-online --package=@promptrail/plugins@latest -- promptrail uninstall plugins codex
```

## Infinite configuration

The equivalent explicit Infinite install command is:

```bash
export PROMPTRAIL_API_KEY="..."
npx --yes @promptrail/plugins@latest install infinite both
```

This configures Codex with `promptrail/infinite` and a PromptRail Responses provider, and Claude
Code with the PromptRail base URL and model. The key is used transiently during Codex installation
to download that tenant's current model catalog; the installer does not store it. Claude Code
receives it through a user-only `apiKeyHelper` that reads the environment variable at runtime.
Installation refuses unrelated Anthropic credential
variables, key helpers, models, or gateways instead of overriding them. Switching modes is explicit
and first restores the other mode's managed settings:

```bash
npx --yes @promptrail/plugins@latest switch plugins
npx --yes @promptrail/plugins@latest switch infinite
```

The explicit Infinite configuration also sends
`X-PromptRail-Diagnostics: executed-model`. The default requested model remains
`promptrail/infinite`, so Codex's model selector and footer keep showing that stable virtual model.
For every completed Codex LLM call, the transcript adds a dim line such as
`Executed by openrouter/cohere/north-mini-code` or `... · subscription reserve` before
the actor's output. Tool-result continuations get their own line because they are separate model
calls. These display-only protocol items are removed before the next provider request. This exposes
no credential ID, reserve level, or internal fallback plan. Plugins mode does not send this header.

### Selecting a free model directly

After Infinite is installed, enter `/model` in Codex or Claude Code. The picker contains:

- `PromptRail Infinite · automatic`, which keeps automatic semantic routing and protected
  subscription continuity;
- one `provider · model` entry for each currently healthy, zero-cost, tool-capable actor
  admitted for that tenant.

Codex reads a user-only catalog downloaded during `install infinite`; rerun the same install command
and restart Codex after the hosted catalog changes. Claude Code enables native gateway model
discovery and reads the current list when its picker refreshes.

A direct-free choice is intentionally strict. PromptRail may retry another credential for the exact
same provider/model, but it cannot substitute another semantic model and cannot use the user's
subscription. If that actor is down, out of quota, or incompatible with the current request's tools,
context, modality, reasoning, or output limit, the call returns a clear error. Select
`PromptRail Infinite · automatic` again when continuity is more important than pinning one actor.

### Modal-hosted beta

Deploy the private Infinite gateway to Modal first. Any supported client machine runs Codex only;
provider execution and routing run inside the Modal service. The private hosted setup helper
validates a bounded cohort of exact zero-priced models, deploys the service, and configures Codex
with the returned HTTPS endpoint. One actor executes at a time. Codex receives only the gateway
key; provider and subscription credentials remain server-side:

```bash
source "${XDG_CONFIG_HOME:-$HOME/.config}/promptrail/infinite/modal-environment.sh"
export PROMPTRAIL_INFINITE_BASE_URL="https://YOUR-MODAL-SERVER.us-west.modal.direct/v1"
export CODEX_HOME="$HOME/.codex-promptrail-infinite-beta"
npx --yes @promptrail/plugins@latest switch infinite codex
npx --yes @promptrail/plugins@latest switch infinite claude
```

The same `/v1` override works for both clients; the Claude installer safely normalizes it to the
Anthropic service root. The override is only for your private Modal beta gateway. The normal default remains
`https://api.promptrail.ai/v1`, and the installer never writes the API key to Codex configuration.
Keep the Codex OAuth file outside repositories with mode 0600 permissions. Claude's key helper is
supported by terminal CLI sessions; Claude Desktop and remote sessions use their own OAuth path.
Treat the Codex OAuth account uploaded to the private Modal beta as dedicated to that deployment;
another client refreshing the same rotating credential can invalidate one copy. Infinite never
dispatches paid API capacity: it uses explicitly admitted zero-cost API models first and the user's
supported subscription capacity for quality-preserving escalation. If every capable free actor is
down, or the request-specific predicted success of the best free actor is below the tenant quality
floor, the gateway selects the subscription directly without first spending a free-provider call.
If protected subscription reserve is unavailable, it continues with free capacity or returns a
clear no-capacity error.
The bare installer migrates existing Plugins users to Infinite. Switching back remains explicit:

```bash
npx --yes @promptrail/plugins@latest switch plugins codex
```

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

Plugins mode and hosted Infinite mode have different data paths. Infinite sends inference requests
through the hosted gateway but does not retain raw prompts or responses by default; it records
sanitized routing and usage receipts. See [PRIVACY.md](PRIVACY.md) for the exact fields and beta
limitations.

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
