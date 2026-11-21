import { rmSync } from "node:fs";

/**
 * Remove a staging tree without ever failing the operation that created it.
 * Bun 1.4.4 ignores rmSync's maxRetries, and Windows can hold a just-closed
 * handle (child cwd, AV scan) on the tree for a moment, so retry EBUSY briefly
 * and then give up: a leaked staging dir is recoverable, but a cleanup throw
 * must not turn a successful install/import into an error or mask the real one.
 */
export function removeTreeBestEffort(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 10) return;
      Bun.sleepSync(50);
    }
  }
}
