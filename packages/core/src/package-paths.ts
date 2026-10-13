import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getPackagesDir(): string {
  return process.env.ORC_PACKAGES_DIR
    ? resolve(process.env.ORC_PACKAGES_DIR)
    : join(homedir(), ".orc", "packages");
}
