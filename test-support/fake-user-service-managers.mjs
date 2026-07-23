import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function fakeUserServiceManagers(directory, currentPath = "") {
  const logPath = join(directory, "user-service-manager.log");
  const script = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { basename } = require("node:path");

appendFileSync(
  process.env.FAKE_USER_SERVICE_MANAGER_LOG,
  JSON.stringify({ command: basename(process.argv[1]), args: process.argv.slice(2) }) + "\\n",
);
`;
  for (const command of ["launchctl", "systemctl"]) {
    const path = join(directory, command);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  return {
    logPath,
    path: currentPath ? `${directory}${delimiter}${currentPath}` : directory,
  };
}
