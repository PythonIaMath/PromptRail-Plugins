import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function syncVersionMetadata(root = defaultRoot) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const packageLockPath = resolve(root, "package-lock.json");
  const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));

  packageLock.version = packageJson.version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = packageJson.version;
  }

  await writeFile(resolve(root, "VERSION"), `${packageJson.version}\n`);
  await writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncVersionMetadata();
}
