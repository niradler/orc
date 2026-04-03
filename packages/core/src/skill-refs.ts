import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * List available reference files in a skill directory (everything beside SKILL.md).
 */
export function listSkillReferenceFiles(skillDir: string, baseDir: string): string[] {
  const abs = resolve(baseDir, skillDir);
  try {
    return readdirSync(abs).filter((f) => f !== "SKILL.md" && statSync(join(abs, f)).isFile());
  } catch {
    return [];
  }
}
