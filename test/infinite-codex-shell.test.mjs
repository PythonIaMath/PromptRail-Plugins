import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installInfiniteCodexShellAlias,
  removeInfiniteCodexShellAlias,
} from "../lib/infinite-codex-shell.mjs";

test("installs a managed normal codex command without exposing the token", async () => {
  const home = await mkdtemp(join(tmpdir(), "promptrail-shell-"));
  const profile = join(home, ".zshrc");
  await writeFile(profile, "export KEEP_ME=yes\n");
  try {
    const installed = await installInfiniteCodexShellAlias({
      helperPath: "/private/promptrail/api-key-helper.sh",
      environment: { HOME: home, SHELL: "/bin/zsh" },
    });
    const contents = await readFile(profile, "utf8");
    assert.match(contents, /alias codex='\/private\/promptrail\/api-key-helper\.sh codex'/);
    assert.match(contents, /PromptRail Infinite Codex \(managed\)/);
    await removeInfiniteCodexShellAlias(installed.state);
    assert.equal(await readFile(profile, "utf8"), "export KEEP_ME=yes\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
