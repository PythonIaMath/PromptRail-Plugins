import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.promptrail-${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "w" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function profilePath(environment) {
  const shell = String(environment.SHELL || "");
  const home = String(environment.HOME || homedir());
  if (shell.endsWith("/zsh")) return join(home, ".zshrc");
  if (shell.endsWith("/bash")) return join(home, ".bashrc");
  return null;
}

export async function installInfiniteCodexShellAlias({ helperPath, previousState = {}, environment = process.env } = {}) {
  const path = profilePath(environment);
  if (!path) return { state: {}, rollback: async () => {} };
  const line = `alias codex=${shellQuote(`${helperPath} codex`)}`;
  const managed = `# PromptRail Infinite Codex (managed)\n${line}\n`;
  let original = "";
  let existed = true;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to update non-regular shell profile at ${path}.`);
    original = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
  }
  if (original.includes("# PromptRail Infinite Codex (managed)") && !original.endsWith(managed)) {
    throw new Error(`PromptRail-managed Codex shell alias changed at ${path}; refusing to overwrite it.`);
  }
  if (!original.endsWith(managed)) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, `${original}${original && !original.endsWith("\n") ? "\n" : ""}${managed}`);
  }
  const state = {
    shellAliasPath: path,
    shellAliasContents: managed,
    shellAliasOriginal: original,
    shellAliasExisted: existed,
  };
  return {
    state,
    async rollback() {
      const current = await readFile(path, "utf8").catch(() => null);
      if (current !== null && current.endsWith(managed)) {
        if (existed) await atomicWrite(path, original);
        else await unlink(path);
      }
    },
  };
}

export async function removeInfiniteCodexShellAlias(state) {
  if (!state.shellAliasPath || !state.shellAliasContents) return false;
  const current = await readFile(state.shellAliasPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (current === null || !current.endsWith(state.shellAliasContents)) return false;
  if (state.shellAliasExisted) await atomicWrite(state.shellAliasPath, state.shellAliasOriginal || "");
  else await unlink(state.shellAliasPath);
  return true;
}
