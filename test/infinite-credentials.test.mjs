import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installInfiniteCredentials,
} from "../lib/infinite-credentials.mjs";

test("credential rollback preserves a concurrent user modification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-credential-race-"));
  const statePath = join(directory, "install-state.json");
  const installed = await installInfiniteCredentials({
    apiKey: "pr_original",
    statePath,
  });

  await writeFile(installed.tokenPath, "user-replaced-token\n", { mode: 0o600 });
  await installed.rollback();

  assert.equal(await readFile(installed.tokenPath, "utf8"), "user-replaced-token\n");
});

test("credential upgrade never recreates a missing pre-existing artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-credential-owner-"));
  const statePath = join(directory, "install-state.json");

  await assert.rejects(
    installInfiniteCredentials({
      apiKey: "pr_new",
      statePath,
      previousState: {
        tokenPath: join(directory, "api-token"),
        tokenSha256: "a".repeat(64),
        tokenExisted: true,
      },
    }),
    /pre-existing PromptRail token file is missing/,
  );
});

test("credential installation repairs the private directory mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "promptrail-infinite-credential-mode-"));
  const statePath = join(directory, "install-state.json");
  await chmod(directory, 0o755);

  await installInfiniteCredentials({ apiKey: "private-token", statePath });

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});
