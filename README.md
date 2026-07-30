# PromptRail Infinite

PromptRail Infinite adds an optional hosted routing profile for Codex and Claude Code. It preserves the user's normal Codex model catalog, provider, and model access.

## Install

```bash
npx --yes @promptrail/plugins@latest switch infinite both
```

## Codex

```bash
codex                            # normal Codex, unchanged models
infinite                         # PromptRail Infinite profile
codex resume --last -p infinite  # continue the latest chat in Infinite
```

Infinite is a native Codex profile, not a fake `/model` entry. Codex chooses providers at launch, so `/model` remains the user's normal catalog.

## Claude Code

The same installer configures Claude Code for Infinite. Credentials are stored only in user-private files.

## Commands

```bash
npx --yes @promptrail/plugins@latest status both
npx --yes @promptrail/plugins@latest uninstall both
```

Requirements: Node.js 18.19+, Codex and/or Claude Code, an active PromptRail Infinite account, and a browser for device authorization.
