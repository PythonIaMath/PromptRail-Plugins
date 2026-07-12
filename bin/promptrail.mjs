#!/usr/bin/env node

import { runCli } from "../lib/installer-cli.mjs";

runCli().then(
  (status) => {
    process.exitCode = status;
  },
  (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  },
);
