import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveTestDatabasePath(
  path: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  if (path === undefined) return undefined;
  const absolute = resolve(cwd, path);
  if (existsSync(absolute))
    throw new Error("PW_DB_PATH must name a new test database; existing paths are never adopted");
  return absolute;
}
