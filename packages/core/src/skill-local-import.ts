import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ValidationError } from "./errors.js";
import { closestMatch, compareProfiles, type TextProfile } from "./similarity.js";
import {
  findSkillDirs,
  hashSkillBundle,
  readSkillBundle,
  type ScannedSkillDir,
  type SkillBundle,
  scanSkillDir,
  skillBundleProfile,
} from "./skill-bundle.js";
import { encodeSkillFile, validateSkillPath } from "./skill-files.js";
import type {
  LocalSkill,
  LocalSkillAgent,
  LocalSkillAgentListing,
  LocalSkillImportItem,
  LocalSkillImportResult,
  LocalSkillStatus,
  SkillMatch,
} from "./skill-import-types.js";
import { createSkill, listSkills, type SkillMeta } from "./skill-service.js";

export { hashSkillBundle } from "./skill-bundle.js";
export type {
  LocalSkill,
  LocalSkillAgent,
  LocalSkillAgentListing,
  LocalSkillImportItem,
  LocalSkillImportResult,
  LocalSkillStatus,
} from "./skill-import-types.js";

/** Returns a skill's effective SKILL.md (e.g. with ORC instruction edits), or null for the file on disk. */
export type SkillEntryReader = (name: string) => string | null;

const RECORD_DIR = join(homedir(), ".orc", "skill-local-imports");
export const FOLDER_SOURCE_ID = "folder";

export function defaultLocalSkillAgents(home = homedir()): LocalSkillAgent[] {
  return [
    { id: "claude", label: "Claude Code", dir: join(home, ".claude", "skills") },
    { id: "codex", label: "Codex", dir: join(home, ".codex", "skills") },
    { id: "agents", label: "Agents (shared)", dir: join(home, ".agents", "skills") },
    { id: "gemini", label: "Gemini CLI", dir: join(home, ".gemini", "skills") },
    { id: "cursor", label: "Cursor", dir: join(home, ".cursor", "skills") },
    { id: "opencode", label: "OpenCode", dir: join(home, ".config", "opencode", "skills") },
  ];
}

/** Any folder as a skill source: a skill folder itself, or skills up to 3 levels below it. */
export function folderSkillSource(path: string): LocalSkillAgent {
  if (!isAbsolute(path)) throw new ValidationError("Folder path must be absolute");
  const dir = resolve(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new ValidationError(`Folder not found: ${dir}`);
  return { id: FOLDER_SOURCE_ID, label: dir, dir, recursive: true };
}

const LocalImportRecordSchema = z.object({
  agent: z.string(),
  source_path: z.string(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  imported_at: z.string(),
});
type LocalImportRecord = z.infer<typeof LocalImportRecordSchema>;

function recordPath(name: string): string {
  validateSkillPath(name);
  if (name.includes("/")) throw new ValidationError("Invalid skill name");
  return join(RECORD_DIR, `${name}.json`);
}

function readRecord(name: string): LocalImportRecord | null {
  const path = recordPath(name);
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
  try {
    const parsed = LocalImportRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function saveRecord(name: string, record: LocalImportRecord): void {
  mkdirSync(RECORD_DIR, { recursive: true });
  if (lstatSync(RECORD_DIR).isSymbolicLink())
    throw new ValidationError("Import record directory cannot be a symlink");
  const temporary = join(RECORD_DIR, `${name}-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(temporary, recordPath(name));
}

export type OrcSkillEntry = { name: string; hash: string; profile: TextProfile };

/** An ORC skill's files with SKILL.md replaced by its effective content when `readEntry` has one. */
export function readOrcSkillBundle(skill: SkillMeta, readEntry?: SkillEntryReader): SkillBundle {
  const files = readSkillBundle(dirname(skill.path));
  const entry = readEntry?.(skill.name);
  if (entry != null) files.set("SKILL.md", Buffer.from(entry, "utf8"));
  return files;
}

/** Hash and comparison profile of every ORC skill, hidden ones included. */
export function orcSkillIndex(readEntry?: SkillEntryReader): Map<string, OrcSkillEntry> {
  const index = new Map<string, OrcSkillEntry>();
  for (const skill of listSkills({ reload: true, include_hidden: true })) {
    try {
      const files = readOrcSkillBundle(skill, readEntry);
      index.set(skill.name, {
        name: skill.name,
        hash: hashSkillBundle(files),
        profile: skillBundleProfile(files, skill.name),
      });
    } catch {}
  }
  return index;
}

function asMatch(
  name: string,
  level: string,
  score: number,
  where: string,
): SkillMatch | undefined {
  return level === "different"
    ? undefined
    : { name, level: level as SkillMatch["level"], score, where };
}

type Classified = { status: LocalSkillStatus; match?: SkillMatch | undefined };

function classify(skill: ScannedSkillDir, orc: Map<string, OrcSkillEntry>): Classified {
  if (skill.error || !skill.profile) return { status: "invalid" };
  const same = orc.get(skill.name);
  if (same) {
    if (same.hash === skill.content_hash) return { status: "installed" };
    const result = compareProfiles(skill.profile, same.profile);
    const match = asMatch(same.name, result.level, result.score, "orc");
    if (result.level === "identical") return { status: "installed", match };
    const record = readRecord(skill.name);
    if (record?.source_path === skill.path && record.content_hash === same.hash)
      return { status: "changed", match };
    return { status: result.level === "near" ? "duplicate" : "conflict", match };
  }
  const closest = closestMatch(
    skill.profile,
    [...orc.values()].map((entry) => ({ key: entry.name, profile: entry.profile })),
  );
  if (!closest) return { status: "new" };
  const match = asMatch(closest.key, closest.level, closest.score, "orc");
  return { status: closest.level === "similar" ? "new" : "duplicate", match };
}

type Source = LocalSkillAgent & { skills: ScannedSkillDir[] };

function discover(agents: LocalSkillAgent[]): Source[] {
  return agents
    .filter((agent) => existsSync(agent.dir) && statSync(agent.dir).isDirectory())
    .map((agent) => ({
      ...agent,
      skills: findSkillDirs(agent.dir, agent.recursive)
        .map(scanSkillDir)
        .sort((left, right) => left.name.localeCompare(right.name)),
    }));
}

function sameSkill(left: ScannedSkillDir, right: ScannedSkillDir): boolean {
  if (left.content_hash && left.content_hash === right.content_hash) return true;
  if (!left.profile || !right.profile) return false;
  const level = compareProfiles(left.profile, right.profile).level;
  return level === "identical" || level === "near";
}

/**
 * Lists skills in local agent folders (~/.claude/skills, ~/.codex/skills, ...) or a chosen folder,
 * each classified against ORC with near-duplicate detection.
 */
export function listLocalAgentSkills(
  agents: LocalSkillAgent[] = defaultLocalSkillAgents(),
  readEntry?: SkillEntryReader,
): LocalSkillAgentListing[] {
  const found = discover(agents);
  const orc = orcSkillIndex(readEntry);
  return found.map((agent) => ({
    id: agent.id,
    label: agent.label,
    dir: agent.dir,
    ...(agent.recursive ? { recursive: true } : {}),
    skills: agent.skills.map((skill): LocalSkill => {
      const { files: _files, profile: _profile, ...fields } = skill;
      const classified = classify(skill, orc);
      return {
        ...fields,
        agent: agent.id,
        status: classified.status,
        also_in: found
          .filter((other) => other.id !== agent.id)
          .filter((other) => other.skills.some((candidate) => sameSkill(skill, candidate)))
          .map((other) => other.id),
        ...(classified.match ? { match: classified.match } : {}),
      };
    }),
  }));
}

/**
 * Copies selected local skills into ~/.orc/skills and records where each came from. Only skills
 * classified "new" are imported (a "similar" match is allowed); a skill that is the same as, or a
 * near copy of, one imported earlier in this batch is skipped, so one skill offered by several
 * agents is imported once.
 */
export function importLocalAgentSkills(
  items: LocalSkillImportItem[],
  agents: LocalSkillAgent[] = defaultLocalSkillAgents(),
  readEntry?: SkillEntryReader,
): LocalSkillImportResult {
  if (!items.length || items.length > 200) throw new ValidationError("Select 1-200 skills");
  const found = discover(agents);
  const orc = orcSkillIndex(readEntry);
  const imported: ScannedSkillDir[] = [];
  const result: LocalSkillImportResult = { imported: [], skipped: [] };
  for (const item of items) {
    const skill = found
      .find((agent) => agent.id === item.agent)
      ?.skills.find(
        (candidate) => candidate.name === item.name && (!item.path || candidate.path === item.path),
      );
    if (!skill?.files || !skill.profile) {
      result.skipped.push({ ...item, reason: skill?.error ?? "Skill not found" });
      continue;
    }
    const earlier = imported.find((other) => other.name === skill.name || sameSkill(skill, other));
    if (earlier) {
      result.skipped.push({ ...item, reason: `Same as ${earlier.name}, imported in this batch` });
      continue;
    }
    const { status, match } = classify(skill, orc);
    if (status !== "new") {
      const near =
        match && match.level !== "similar" ? ` (${match.level} copy of ${match.name})` : "";
      result.skipped.push({ ...item, reason: `${status}${near}` });
      continue;
    }
    const entry = (skill.files.get("SKILL.md") as Buffer).toString("utf8");
    const files = [...skill.files.entries()]
      .filter(([path]) => path !== "SKILL.md")
      .map(([path, bytes]) => ({ path, ...encodeSkillFile(bytes) }));
    try {
      const created = createSkill(skill.name, entry, files);
      result.imported.push({
        name: created.name,
        description: created.description,
        path: created.path,
      });
    } catch (error) {
      result.skipped.push({ ...item, reason: (error as Error).message });
      continue;
    }
    saveRecord(skill.name, {
      agent: item.agent,
      source_path: skill.path,
      content_hash: skill.content_hash,
      imported_at: new Date().toISOString(),
    });
    imported.push(skill);
    orc.set(skill.name, { name: skill.name, hash: skill.content_hash, profile: skill.profile });
  }
  return result;
}
