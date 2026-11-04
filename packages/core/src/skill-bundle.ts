import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "./errors.js";
import { type TextProfile, textProfile } from "./similarity.js";
import { MAX_SKILL_BUNDLE_BYTES, MAX_SKILL_FILES, validateSkillPath } from "./skill-files.js";
import { parseFrontmatter } from "./skill-service.js";

const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const MAX_COMPARED_FILE_BYTES = 256 * 1024;
const MAX_SCAN_DEPTH = 3;
const MAX_SCANNED_DIRS = 2000;

export type SkillBundle = Map<string, Buffer>;

/** Reads a skill folder into relative path -> bytes, skipping nested symlinks, .git and node_modules. */
export function readSkillBundle(skillDir: string): SkillBundle {
  const files: SkillBundle = new Map();
  let total = 0;
  function walk(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIPPED_DIRS.has(entry.name)) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, name);
      else if (entry.isFile()) {
        validateSkillPath(name);
        const bytes = readFileSync(path);
        total += bytes.length;
        files.set(name, bytes);
        if (files.size > MAX_SKILL_FILES) throw new ValidationError("Too many skill files");
        if (total > MAX_SKILL_BUNDLE_BYTES)
          throw new ValidationError("Skill bundle exceeds 16 MiB");
      }
    }
  }
  walk(skillDir, "");
  return files;
}

/** sha256 over sorted relative paths and file bytes, so identical folders hash the same anywhere. */
export function hashSkillBundle(files: SkillBundle): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files.get(name) as Buffer);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function isText(bytes: Buffer): boolean {
  return bytes.length <= MAX_COMPARED_FILE_BYTES && !bytes.includes(0);
}

/**
 * SKILL.md then each other file by path; binary or large files contribute only their hash. The
 * skill's own name is masked so a renamed copy still compares as the same skill.
 */
export function skillBundleProfile(files: SkillBundle, skillName?: string): TextProfile {
  const parts = [(files.get("SKILL.md") ?? Buffer.alloc(0)).toString("utf8")];
  for (const name of [...files.keys()].filter((path) => path !== "SKILL.md").sort()) {
    const bytes = files.get(name) as Buffer;
    parts.push(
      isText(bytes)
        ? `--- ${name}\n${bytes.toString("utf8")}`
        : `--- ${name} sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
  }
  const text = parts.join("\n\n");
  return textProfile(
    skillName && skillName.length >= 4 ? text.replaceAll(skillName, "{skill}") : text,
  );
}

/** Folders holding a SKILL.md: direct children of `dir`, or (recursive) any folder up to 3 levels down. */
export function findSkillDirs(dir: string, recursive = false): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let visited = 0;
  function visit(path: string, depth: number): void {
    let real: string;
    try {
      real = realpathSync(path);
      if (seen.has(real) || !statSync(real).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(real);
    if (++visited > MAX_SCANNED_DIRS) return;
    if ((depth > 0 || recursive) && existsSync(join(real, "SKILL.md"))) {
      found.push(real);
      return;
    }
    if (depth >= (recursive ? MAX_SCAN_DEPTH : 1)) return;
    let entries: string[];
    try {
      entries = readdirSync(real).filter((name) => !SKIPPED_DIRS.has(name));
    } catch {
      return;
    }
    for (const name of entries.sort()) visit(join(real, name), depth + 1);
  }
  visit(dir, 0);
  return found;
}

export type ScannedSkillDir = {
  name: string;
  description: string;
  path: string;
  content_hash: string;
  extra_fields: string[];
  files?: SkillBundle;
  profile?: TextProfile;
  error?: string;
};

/** Reads and validates one skill folder; a broken one is returned with `error` instead of throwing. */
export function scanSkillDir(path: string): ScannedSkillDir {
  try {
    const files = readSkillBundle(path);
    const entry = files.get("SKILL.md");
    if (!entry) throw new ValidationError("SKILL.md cannot be a symlink");
    const { frontmatter, extra_fields } = parseFrontmatter(entry.toString("utf8"));
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      path,
      content_hash: hashSkillBundle(files),
      extra_fields,
      files,
      profile: skillBundleProfile(files, frontmatter.name),
    };
  } catch (error) {
    return {
      name: path.split(/[\\/]/).pop() ?? path,
      description: "",
      path,
      content_hash: "",
      extra_fields: [],
      error: (error as Error).message,
    };
  }
}
