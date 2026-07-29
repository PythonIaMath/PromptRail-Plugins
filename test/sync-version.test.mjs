import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { syncVersionMetadata } from "../scripts/sync-version.mjs";

test("synchronizes VERSION and both npm lockfile version fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "promptrail-sync-version-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
    await writeFile(join(root, "package-lock.json"), JSON.stringify({
      name: "test-package",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "test-package", version: "1.0.0" } },
    }));

    await syncVersionMetadata(root);

    assert.equal(await readFile(join(root, "VERSION"), "utf8"), "9.8.7\n");
    const lockfile = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    assert.equal(lockfile.version, "9.8.7");
    assert.equal(lockfile.packages[""].version, "9.8.7");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
