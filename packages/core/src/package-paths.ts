import { homedir } from "node:os";
import { join } from "node:path";

export function getPackagesDir(): string {
  return join(homedir(), ".orc", "packages");
}
