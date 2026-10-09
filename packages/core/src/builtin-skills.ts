import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateSkillPath } from "./skill-files.js";

/** Materialize compiled assets so ordinary skill reads and package hashing still work. */
export function installEmbeddedSkills(
  assets: Record<string, string>,
  cacheRoot = join(homedir(), ".orc", "bundled-skills"),
): string {
  const entries = Object.entries(assets).sort(([a], [b]) => a.localeCompare(b));
  for (const [path] of entries) validateSkillPath(path);
  const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const directory = join(cacheRoot, hash);
  for (const [path, encoded] of entries) {
    const target = join(directory, path);
    const content = Buffer.from(encoded, "base64");
    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) {
      if (!readFileSync(target).equals(content))
        throw new Error("Bundled skill cache was modified");
    } else writeFileSync(target, content, { flag: "wx" });
  }
  return directory;
}
