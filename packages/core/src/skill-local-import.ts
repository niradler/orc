import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ValidationError } from "./errors.js";
import {
  encodeSkillFile,
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILES,
  validateSkillPath,
} from "./skill-files.js";
import type {
  LocalSkill,
  LocalSkillAgent,
  LocalSkillAgentListing,
  LocalSkillImportItem,
  LocalSkillImportResult,
  LocalSkillStatus,
} from "./skill-import-types.js";
import { createSkill, listSkills, parseFrontmatter } from "./skill-service.js";

export type {
  LocalSkill,
  LocalSkillAgent,
  LocalSkillAgentListing,
  LocalSkillImportItem,
  LocalSkillImportResult,
  LocalSkillStatus,
} from "./skill-import-types.js";

const RECORD_DIR = join(homedir(), ".orc", "skill-local-imports");
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

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

/** Reads a skill folder into relative path -> bytes, skipping nested symlinks, .git and node_modules. */
function readBundle(skillDir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
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
export function hashSkillBundle(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files.get(name) as Buffer);
    hash.update("\0");
  }
  return hash.digest("hex");
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
  const parsed = LocalImportRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data : null;
}

function saveRecord(name: string, record: LocalImportRecord): void {
  mkdirSync(RECORD_DIR, { recursive: true });
  if (lstatSync(RECORD_DIR).isSymbolicLink())
    throw new ValidationError("Import record directory cannot be a symlink");
  const temporary = join(RECORD_DIR, `${name}-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
  renameSync(temporary, recordPath(name));
}

type ScannedSkill = Omit<LocalSkill, "status" | "also_in"> & {
  files?: Map<string, Buffer>;
};

function scanAgent(agent: LocalSkillAgent): ScannedSkill[] {
  const skills: ScannedSkill[] = [];
  for (const entry of readdirSync(agent.dir)) {
    const linkPath = join(agent.dir, entry);
    let skillDir: string;
    try {
      skillDir = realpathSync(linkPath);
      if (!statSync(skillDir).isDirectory() || !existsSync(join(skillDir, "SKILL.md"))) continue;
    } catch {
      continue;
    }
    try {
      const files = readBundle(skillDir);
      const entryFile = files.get("SKILL.md");
      if (!entryFile) throw new ValidationError("SKILL.md cannot be a symlink");
      const { frontmatter } = parseFrontmatter(entryFile.toString("utf8"));
      skills.push({
        agent: agent.id,
        name: frontmatter.name,
        description: frontmatter.description,
        path: skillDir,
        content_hash: hashSkillBundle(files),
        files,
      });
    } catch (error) {
      skills.push({
        agent: agent.id,
        name: entry,
        description: "",
        path: skillDir,
        content_hash: "",
        error: (error as Error).message,
      });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function installedHashes(): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const skill of listSkills({ reload: true, include_hidden: true })) {
    try {
      hashes.set(skill.name, hashSkillBundle(readBundle(dirname(skill.path))));
    } catch {
      hashes.set(skill.name, "");
    }
  }
  return hashes;
}

function classify(skill: ScannedSkill, installed: Map<string, string>): LocalSkillStatus {
  if (skill.error) return "invalid";
  const orcHash = installed.get(skill.name);
  if (orcHash === undefined) return "new";
  if (orcHash === skill.content_hash) return "installed";
  const record = readRecord(skill.name);
  const untouched = record?.source_path === skill.path && record.content_hash === orcHash;
  return untouched ? "changed" : "conflict";
}

function discover(agents: LocalSkillAgent[]): Array<LocalSkillAgent & { skills: ScannedSkill[] }> {
  return agents
    .filter((agent) => existsSync(agent.dir) && statSync(agent.dir).isDirectory())
    .map((agent) => ({ ...agent, skills: scanAgent(agent) }));
}

/** Lists skills in local agent folders (~/.claude/skills, ~/.codex/skills, ...) with dedup status. */
export function listLocalAgentSkills(
  agents: LocalSkillAgent[] = defaultLocalSkillAgents(),
): LocalSkillAgentListing[] {
  const found = discover(agents);
  const installed = installedHashes();
  const agentsByHash = new Map<string, Set<string>>();
  for (const agent of found) {
    for (const skill of agent.skills) {
      if (!skill.content_hash) continue;
      const owners = agentsByHash.get(skill.content_hash) ?? new Set<string>();
      owners.add(agent.id);
      agentsByHash.set(skill.content_hash, owners);
    }
  }
  return found.map((agent) => ({
    ...agent,
    skills: agent.skills.map(({ files: _files, ...skill }) => ({
      ...skill,
      status: classify(skill, installed),
      also_in: [...(agentsByHash.get(skill.content_hash) ?? [])].filter((id) => id !== agent.id),
    })),
  }));
}

/**
 * Copies selected local agent skills into ~/.orc/skills and records where each came from.
 * Only skills with status "new" are imported; the rest, and a name already taken earlier in this
 * batch (the same skill offered by several agents), are reported as skipped.
 */
export function importLocalAgentSkills(
  items: LocalSkillImportItem[],
  agents: LocalSkillAgent[] = defaultLocalSkillAgents(),
): LocalSkillImportResult {
  if (!items.length || items.length > 200) throw new ValidationError("Select 1-200 skills");
  const found = discover(agents);
  const installed = installedHashes();
  const takenNames = new Set<string>();
  const result: LocalSkillImportResult = { imported: [], skipped: [] };
  for (const item of items) {
    const skill = found
      .find((agent) => agent.id === item.agent)
      ?.skills.find((candidate) => candidate.name === item.name);
    if (!skill?.files) {
      result.skipped.push({ ...item, reason: skill?.error ?? "Skill not found" });
      continue;
    }
    if (takenNames.has(skill.name)) {
      result.skipped.push({ ...item, reason: "Already imported in this batch" });
      continue;
    }
    const status = classify(skill, installed);
    if (status !== "new") {
      result.skipped.push({ ...item, reason: status });
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
    takenNames.add(skill.name);
  }
  return result;
}
