#!/usr/bin/env node

import { runCli } from "../lib/installer-cli.mjs";

if (!process.stdin.isTTY) {
  process.stdout.write(
    "PromptRail was downloaded. Configure both clients with `npx @promptrail/plugins` and provide your access token.\n",
  );
  process.exit(0);
}

runCli({ argv: ["install", "both"] }).catch((error) => {
  process.stderr.write(`PromptRail setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
