import { renameSync, writeFileSync } from "node:fs";

/** Same-directory replacement keeps the last complete preferences file on a failed write. */
export function writePreviewJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flush: true });
  renameSync(temporary, path);
}
