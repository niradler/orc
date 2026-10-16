import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Copies a native library embedded in the compiled binary to a real file, since SQLite can only
 * load extensions from disk. The cache directory is named by content hash, so an upgrade writes a
 * new copy and a modified copy is refused instead of loaded.
 */
export function extractNativeAsset(
  asset: { path: string; name: string },
  cacheRoot = join(homedir(), ".orc", "native"),
): string | null {
  const bytes = readFileSync(asset.path);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const target = join(cacheRoot, hash, asset.name);
  if (existsSync(target)) {
    if (readFileSync(target).equals(bytes)) return target;
    console.error(
      `Refusing to load ${target}: it differs from the bundled copy. Delete it to restore.`,
    );
    return null;
  }
  mkdirSync(join(cacheRoot, hash), { recursive: true });
  const staging = `${target}.${process.pid}.tmp`;
  writeFileSync(staging, bytes);
  try {
    renameSync(staging, target);
  } catch (e) {
    // Another process extracted it first (Windows refuses to rename over an existing file).
    rmSync(staging, { force: true });
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) throw e;
  }
  return target;
}
