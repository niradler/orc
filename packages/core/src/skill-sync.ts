import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { listSkillFiles, prepareSkillFiles, readSkillFile } from "./skill-files.js";
import { fetchSkillUpdate, getSkillImportRecord, saveSkillImportRecord } from "./skill-import.js";
import type { SkillSyncInput, SkillSyncResult } from "./skill-import-types.js";
import {
  getUserSkillsDir,
  parseFrontmatter,
  readSkill,
  reloadCache,
  type SkillFull,
} from "./skill-service.js";

export function mergeSkillFiles(
  baseline: Record<string, string>,
  local: Record<string, string>,
  remote: Record<string, string>,
  override = false,
): { files: Record<string, string>; conflicts: string[]; changed: string[] } {
  const files: Record<string, string> = Object.create(null);
  const conflicts: string[] = [];
  const changed: string[] = [];
  for (const path of new Set([
    ...Object.keys(baseline),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    const original = Object.hasOwn(baseline, path) ? baseline[path] : undefined;
    const current = Object.hasOwn(local, path) ? local[path] : undefined;
    const upstream = Object.hasOwn(remote, path) ? remote[path] : undefined;
    const conflict = current !== original && upstream !== original && current !== upstream;
    if (conflict) conflicts.push(path);
    const chosen = current === original || (conflict && override) ? upstream : current;
    if (chosen !== undefined) files[path] = chosen;
    if (chosen !== current) changed.push(path);
  }
  return { files, conflicts: conflicts.sort(), changed: changed.sort() };
}

function revisionOf(files: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}

function assertNoSymlinks(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new ValidationError("Local skill symlinks cannot be synced");
    if (entry.isDirectory()) assertNoSymlinks(join(directory, entry.name));
  }
}

export async function syncImportedSkill(
  name: string,
  input: SkillSyncInput = {},
): Promise<SkillSyncResult> {
  const record = getSkillImportRecord(name);
  if (!record) throw new ValidationError("This skill has no GitHub import origin");
  const skill = readSkill(name) as SkillFull | null;
  if (!skill) throw new NotFoundError("Skill", name);
  const root = join(getUserSkillsDir(), name);
  if (skill.path !== join(root, "SKILL.md") || lstatSync(root).isSymbolicLink())
    throw new ValidationError("Only imported user skill folders can be synced");
  const upstream = await fetchSkillUpdate(record);
  if (upstream.name !== name)
    throw new ValidationError("Upstream renamed the skill; import the new name separately");
  const local: Record<string, string> = Object.create(null);
  assertNoSymlinks(root);
  for (const path of ["SKILL.md", ...listSkillFiles(root).map((file) => file.name)]) {
    const resource = readSkillFile(root, path, false);
    local[path] = Buffer.from(resource.content, resource.encoding).toString("base64");
  }
  const revision = revisionOf(local);
  if (
    input.override &&
    (input.expectedCommit !== upstream.commit || input.expectedRevision !== revision)
  )
    throw new ConflictError(
      "The local or upstream skill changed since review; sync again before overriding",
    );
  const merged = mergeSkillFiles(record.files, local, upstream.files, input.override);
  const result = {
    applied: false,
    commit: upstream.commit,
    conflicts: merged.conflicts,
    changed: merged.changed,
    revision,
  };
  if (merged.conflicts.length && !input.override) return result;
  if (!merged.files["SKILL.md"]) throw new ValidationError("Sync must retain SKILL.md");
  const entry = Buffer.from(merged.files["SKILL.md"], "base64").toString("utf8");
  if (parseFrontmatter(entry).frontmatter.name !== name)
    throw new ValidationError("Merged skill name must stay unchanged");
  prepareSkillFiles(
    Object.entries(merged.files)
      .filter(([path]) => path !== "SKILL.md")
      .map(([path, content]) => ({ path, content, encoding: "base64" })),
    entry,
  );
  if (merged.changed.length) {
    const transactionRoot = join(dirname(getUserSkillsDir()), "skill-sync-backups");
    mkdirSync(transactionRoot, { recursive: true });
    if (lstatSync(transactionRoot).isSymbolicLink())
      throw new ValidationError("Sync backup directory cannot be a symlink");
    const transaction = mkdtempSync(join(transactionRoot, `${name}-`));
    const staged = join(transaction, "updated");
    mkdirSync(staged);
    for (const [path, content] of Object.entries(merged.files)) {
      const target = join(staged, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(content, "base64"), { flag: "wx" });
    }
    const backup = join(transaction, "previous");
    renameSync(root, backup);
    try {
      renameSync(staged, root);
      saveSkillImportRecord(name, { ...record, commit: upstream.commit, files: upstream.files });
    } catch (error) {
      if (existsSync(root)) renameSync(root, staged);
      renameSync(backup, root);
      throw error;
    }
  } else saveSkillImportRecord(name, { ...record, commit: upstream.commit, files: upstream.files });
  reloadCache();
  return { ...result, applied: true };
}
