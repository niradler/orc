import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const MAX_TITLE_LENGTH = 200;

// Directories that should never be indexed/served as a knowledge collection —
// they hold credentials, keys, or kernel/process state.
function sensitiveRoots(): string[] {
  const home = homedir();
  return [
    resolve(home, ".ssh"),
    resolve(home, ".aws"),
    resolve(home, ".gnupg"),
    resolve(home, ".config", "gcloud"),
    "/etc",
    "/proc",
    "/sys",
    "/root",
    "C:\\Windows",
    "C:\\Windows\\System32",
  ].map((p) => resolve(p));
}

export class PathValidationError extends Error {}

// Validates a user-supplied directory path before it is indexed or read.
// Requires an absolute path to an existing directory, outside known-sensitive
// system/credential locations. Returns the resolved (normalized) path.
export function validateCollectionPath(path: string): string {
  if (!path || !isAbsolute(path)) {
    throw new PathValidationError(`Path must be absolute: ${path}`);
  }
  const resolved = resolve(path);
  for (const root of sensitiveRoots()) {
    if (resolved === root || resolved.startsWith(`${root}/`) || resolved.startsWith(`${root}\\`)) {
      throw new PathValidationError(`Refusing to index sensitive directory: ${resolved}`);
    }
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new PathValidationError(`Path is not an existing directory: ${resolved}`);
  }
  return resolved;
}

export function validateTaskTitle(title: string): { valid: boolean; error?: string } {
  const trimmed = title.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Title must not be empty" };
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    return {
      valid: false,
      error: `Title must not exceed ${MAX_TITLE_LENGTH} characters (got ${trimmed.length})`,
    };
  }

  return { valid: true };
}
