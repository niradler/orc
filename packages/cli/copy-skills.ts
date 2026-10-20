import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Keep packaging exact while retaining obsolete build files outside the published allowlist. */
export function copyBuiltinSkills(source: string, destination: string): void {
  const archive = join(dirname(destination), `.retired-skills-${crypto.randomUUID()}`);
  function archiveObsolete(current: string, output: string): void {
    if (!existsSync(output)) return;
    for (const entry of readdirSync(output, { withFileTypes: true })) {
      const from = join(output, entry.name);
      const original = join(current, entry.name);
      if (!existsSync(original)) {
        const target = join(archive, relative(destination, from));
        mkdirSync(dirname(target), { recursive: true });
        renameSync(from, target);
      } else if (entry.isDirectory()) archiveObsolete(original, from);
    }
  }
  archiveObsolete(source, destination);
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}

if (import.meta.main) {
  const destination = join(import.meta.dir, "dist", "skills");
  copyBuiltinSkills(join(import.meta.dir, "../../skills"), destination);
  console.log(`Copied built-in skills to ${destination}`);
}
