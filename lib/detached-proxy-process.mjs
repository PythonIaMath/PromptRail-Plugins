import { spawnSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";

export function matchingProxyPids(output, pluginName, currentPid = process.pid) {
  const marker = `/${pluginName}/`;
  return String(output || "")
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter(({ pid, command }) => (
      pid !== currentPid
      && command.includes(marker)
      && command.includes("/src/proxy.mjs")
    ))
    .map(({ pid }) => pid);
}

function discoverProxyPids(pluginName) {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  return matchingProxyPids(result.stdout, pluginName);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export async function stopDetachedProxyProcesses(pidFilePath, pluginName) {
  const discovered = discoverProxyPids(pluginName);
  const pids = new Set(discovered || []);
  try {
    const pid = Number((await readFile(pidFilePath, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      if (discovered === null) {
        throw new Error("PromptRail could not inspect the recorded proxy process safely.");
      }
      if (discovered.includes(pid)) {
        pids.add(pid);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  for (let attempt = 0; attempt < 20 && [...pids].some(isRunning); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const remaining = [...pids].filter(isRunning);
  if (remaining.length > 0) {
    throw new Error(`PromptRail proxy processes did not stop: ${remaining.join(", ")}.`);
  }
  try {
    await unlink(pidFilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return pids.size;
}
