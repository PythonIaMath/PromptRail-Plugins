import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWriteFile(path, contents, mode) {
  const temporary = `${path}.promptrail-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(path);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`Refusing to store PromptRail credentials in a non-regular directory at ${path}.`);
  }
  await chmod(path, 0o700);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function normalizeInfiniteApiKey(value) {
  const token = String(value || "").trim();
  if (!token) {
    throw new Error("PROMPTRAIL_API_KEY or --token is required for PromptRail Infinite.");
  }
  if (token.length > 8_192 || /[\u0000-\u001f\u007f-\u009f]/u.test(token)) {
    throw new Error("PromptRail Infinite API token is invalid.");
  }
  return token;
}

export function infiniteCredentialPaths(statePath) {
  const home = dirname(statePath);
  return {
    tokenPath: join(home, "api-token"),
    helperPath: join(home, "api-key-helper.sh"),
  };
}

export function infiniteCredentialHelper(tokenPath) {
  return [
    "#!/bin/sh",
    "set -eu",
    `token_file=${shellQuote(tokenPath)}`,
    'if [ ! -f "$token_file" ] || [ ! -r "$token_file" ]; then',
    '  echo "PromptRail Infinite token file is unavailable" >&2',
    "  exit 1",
    "fi",
    "token=",
    'IFS= read -r token < "$token_file" || true',
    'if [ -z "$token" ]; then',
    '  echo "PromptRail Infinite token file is empty" >&2',
    "  exit 1",
    "fi",
    'printf \'%s\\n\' "$token"',
    "",
  ].join("\n");
}

async function readRegularArtifact(path, label) {
  try {
    const fileStat = await lstat(path);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Refusing to use a non-regular PromptRail ${label} at ${path}.`);
    }
    return {
      exists: true,
      contents: await readFile(path, "utf8"),
      mode: fileStat.mode & 0o777,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, contents: "", mode: null };
    throw error;
  }
}

function assertOwnedArtifact({ artifact, path, expectedHash, label, existedBefore }) {
  if (existedBefore) {
    if (!artifact.exists) {
      throw new Error(`A pre-existing PromptRail ${label} is missing at ${path}; refusing to recreate it.`);
    }
    if (!expectedHash || sha256(artifact.contents) !== expectedHash) {
      throw new Error(`Refusing to overwrite a modified PromptRail ${label} at ${path}.`);
    }
    throw new Error(`Refusing to replace a pre-existing PromptRail ${label} at ${path}.`);
  }
  if (!expectedHash) {
    if (artifact.exists) {
      throw new Error(`Refusing to overwrite an existing PromptRail ${label} at ${path}.`);
    }
    return;
  }
  if (!artifact.exists) return;
  if (sha256(artifact.contents) !== expectedHash) {
    throw new Error(`Refusing to overwrite a modified PromptRail ${label} at ${path}.`);
  }
}

async function restoreArtifactIfUnchanged(path, installedContents, original) {
  const current = await readRegularArtifact(path, "credential artifact");
  if (!current.exists || sha256(current.contents) !== sha256(installedContents)) return;
  if (original.exists) {
    await atomicWriteFile(path, original.contents, original.mode || 0o600);
    return;
  }
  await unlink(path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function installInfiniteCredentials({
  apiKey,
  statePath,
  previousState = {},
  tokenPath,
  helperPath,
} = {}) {
  const token = normalizeInfiniteApiKey(apiKey);
  const defaults = infiniteCredentialPaths(statePath);
  tokenPath ||= defaults.tokenPath;
  helperPath ||= defaults.helperPath;
  if (previousState.tokenPath && previousState.tokenPath !== tokenPath) {
    throw new Error("Infinite install state belongs to a different token file; refusing to overwrite it.");
  }
  if (previousState.helperPath && previousState.helperPath !== helperPath) {
    throw new Error("Infinite install state belongs to a different key helper; refusing to overwrite it.");
  }

  const [currentToken, currentHelper] = await Promise.all([
    readRegularArtifact(tokenPath, "token file"),
    readRegularArtifact(helperPath, "key helper"),
  ]);
  assertOwnedArtifact({
    artifact: currentToken,
    path: tokenPath,
    expectedHash: previousState.tokenSha256,
    label: "token file",
    existedBefore: previousState.tokenExisted === true,
  });
  assertOwnedArtifact({
    artifact: currentHelper,
    path: helperPath,
    expectedHash: previousState.helperSha256,
    label: "key helper",
    existedBefore: previousState.helperExisted === true,
  });

  const tokenContents = `${token}\n`;
  const helperContents = infiniteCredentialHelper(tokenPath);
  await ensurePrivateDirectory(dirname(tokenPath));
  await ensurePrivateDirectory(dirname(helperPath));
  try {
    await atomicWriteFile(tokenPath, tokenContents, 0o600);
    await atomicWriteFile(helperPath, helperContents, 0o700);
  } catch (error) {
    await restoreArtifactIfUnchanged(tokenPath, tokenContents, currentToken).catch(() => {});
    await restoreArtifactIfUnchanged(helperPath, helperContents, currentHelper).catch(() => {});
    throw error;
  }

  let rolledBack = false;
  return {
    tokenPath,
    helperPath,
    state: {
      tokenPath,
      tokenSha256: sha256(tokenContents),
      tokenExisted: previousState.tokenExisted === true,
      helperPath,
      helperSha256: sha256(helperContents),
      helperExisted: previousState.helperExisted === true,
    },
    async rollback() {
      if (rolledBack) return;
      rolledBack = true;
      await restoreArtifactIfUnchanged(tokenPath, tokenContents, currentToken);
      await restoreArtifactIfUnchanged(helperPath, helperContents, currentHelper);
    },
  };
}

async function removeOwnedArtifact(path, expectedHash, existedBefore) {
  if (!path || !expectedHash || existedBefore) return false;
  try {
    const artifact = await readRegularArtifact(path, "credential artifact");
    if (!artifact.exists || sha256(artifact.contents) !== expectedHash) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function removeInfiniteCredentials(state) {
  const results = await Promise.all([
    removeOwnedArtifact(state.tokenPath, state.tokenSha256, state.tokenExisted),
    removeOwnedArtifact(state.helperPath, state.helperSha256, state.helperExisted),
  ]);
  return results.some(Boolean);
}

export async function infiniteCredentialStatus(state) {
  if (
    typeof state?.tokenPath !== "string"
    || typeof state?.tokenSha256 !== "string"
    || typeof state?.helperPath !== "string"
    || typeof state?.helperSha256 !== "string"
  ) {
    return { configured: false, reason: "credential_state_missing" };
  }
  for (const [path, expectedHash, label, expectedMode] of [
    [state.tokenPath, state.tokenSha256, "token", 0o600],
    [state.helperPath, state.helperSha256, "helper", 0o700],
  ]) {
    const artifact = await readRegularArtifact(path, `${label} file`);
    if (!artifact.exists) return { configured: false, reason: `${label}_missing` };
    if (sha256(artifact.contents) !== expectedHash || artifact.mode !== expectedMode) {
      return { configured: false, reason: `${label}_modified` };
    }
  }
  return { configured: true };
}
