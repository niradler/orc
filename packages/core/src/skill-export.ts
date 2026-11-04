import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NotFoundError, ValidationError } from "./errors.js";
import { closestMatch, compareProfiles } from "./similarity.js";
import {
  findSkillDirs,
  hashSkillBundle,
  type ScannedSkillDir,
  type SkillBundle,
  scanSkillDir,
  skillBundleProfile,
} from "./skill-bundle.js";
import type {
  LocalSkillAgent,
  SkillExportPlan,
  SkillExportPlanItem,
  SkillExportResult,
  SkillExportTarget,
  SkillMatch,
} from "./skill-import-types.js";
import {
  defaultLocalSkillAgents,
  readOrcSkillBundle,
  type SkillEntryReader,
} from "./skill-local-import.js";
import {
  getBuiltinSkillsDir,
  getUserSkillsDir,
  listSkills,
  type SkillMeta,
} from "./skill-service.js";

export type {
  SkillExportPlan,
  SkillExportPlanItem,
  SkillExportResult,
  SkillExportTarget,
} from "./skill-import-types.js";

const BACKUP_DIR = join(homedir(), ".orc", "skill-export-backups");

type ResolvedTarget = { dir: string; label: string };

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const full = resolve(path);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return normalize(left) === normalize(right);
}

/** An agent's skills folder (the agent must be installed) or any absolute folder outside ORC's own. */
export function resolveExportTarget(
  target: SkillExportTarget,
  agents: LocalSkillAgent[] = defaultLocalSkillAgents(),
): ResolvedTarget {
  let resolved: ResolvedTarget;
  if ("agent" in target) {
    const agent = agents.find((candidate) => candidate.id === target.agent);
    if (!agent) throw new ValidationError(`Unknown agent: ${target.agent}`);
    const root = dirname(agent.dir);
    if (!existsSync(root))
      throw new ValidationError(`${agent.label} is not installed (${root} not found)`);
    resolved = { dir: agent.dir, label: agent.label };
  } else {
    if (!isAbsolute(target.path)) throw new ValidationError("Export path must be absolute");
    const dir = resolve(target.path);
    resolved = { dir, label: dir };
  }
  if (existsSync(resolved.dir) && !statSync(resolved.dir).isDirectory())
    throw new ValidationError(`Not a folder: ${resolved.dir}`);
  for (const own of [getUserSkillsDir(), getBuiltinSkillsDir()])
    if (samePath(resolved.dir, own))
      throw new ValidationError("Choose a folder outside ORC's skills");
  return resolved;
}

type PlannedItem = SkillExportPlanItem & { files?: SkillBundle };

function targetSkills(dir: string): ScannedSkillDir[] {
  return existsSync(dir) ? findSkillDirs(dir).map(scanSkillDir) : [];
}

function matchIn(
  where: string,
  name: string,
  level: string,
  score: number,
): SkillMatch | undefined {
  return level === "different"
    ? undefined
    : { name, level: level as SkillMatch["level"], score, where };
}

function planItem(
  name: string,
  skill: SkillMeta | undefined,
  dir: string,
  existing: ScannedSkillDir[],
  readEntry: SkillEntryReader | undefined,
): PlannedItem {
  const path = join(dir, name);
  if (!skill)
    return {
      name,
      description: "",
      status: "blocked",
      path,
      can_overwrite: false,
      reason: "Skill not found",
    };
  const base = { name, description: skill.description, path };
  let files: SkillBundle;
  try {
    files = readOrcSkillBundle(skill, readEntry);
  } catch (error) {
    return { ...base, status: "blocked", can_overwrite: false, reason: (error as Error).message };
  }
  const profile = skillBundleProfile(files, name);
  const hash = hashSkillBundle(files);
  const stat = existsSync(path) || isLink(path) ? lstatSync(path) : null;
  if (!stat) {
    const others = existing
      .filter((other) => other.profile)
      .map((other) => ({
        key: other,
        profile: other.profile as NonNullable<typeof other.profile>,
      }));
    const closest = closestMatch(profile, others);
    const match = closest
      ? matchIn(dir, closest.key.name, closest.level, closest.score)
      : undefined;
    if (closest && closest.level !== "similar")
      return {
        ...base,
        status: "duplicate",
        can_overwrite: true,
        match,
        reason: `${closest.key.name} in the target is the same skill`,
        files,
      };
    return { ...base, status: "new", can_overwrite: false, ...(match ? { match } : {}), files };
  }
  const linked = stat.isSymbolicLink();
  const current = scanSkillDir(linked ? safeRealpath(path) : path);
  if (!linked && !stat.isDirectory())
    return {
      ...base,
      status: "blocked",
      can_overwrite: false,
      reason: "A file with this name exists",
    };
  if (current.content_hash === hash)
    return { ...base, status: "identical", can_overwrite: false, files };
  const result = current.profile
    ? compareProfiles(profile, current.profile)
    : { level: "different" as const, score: 0 };
  const match = matchIn(dir, current.name, result.level, result.score);
  if (result.level === "identical")
    return {
      ...base,
      status: "identical",
      can_overwrite: false,
      ...(match ? { match } : {}),
      files,
    };
  if (linked)
    return {
      ...base,
      status: "blocked",
      can_overwrite: false,
      ...(match ? { match } : {}),
      reason: `Linked to ${safeRealpath(path)}; update the link target instead`,
    };
  return {
    ...base,
    status: result.level === "near" ? "near" : "conflict",
    can_overwrite: true,
    ...(match ? { match } : {}),
    ...(current.error ? { reason: current.error } : {}),
    files,
  };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function buildPlan(
  names: string[] | undefined,
  target: SkillExportTarget,
  readEntry: SkillEntryReader | undefined,
): { target: ResolvedTarget; items: PlannedItem[] } {
  const resolved = resolveExportTarget(target);
  const existing = targetSkills(resolved.dir);
  const all = listSkills({ reload: true, include_hidden: true });
  const byName = new Map(all.map((skill) => [skill.name, skill]));
  const selected = names?.length
    ? [...new Set(names)]
    : all
        .filter((skill) => !skill.discovery_hidden)
        .map((skill) => skill.name)
        .sort();
  return {
    target: resolved,
    items: selected.map((name) =>
      planItem(name, byName.get(name), resolved.dir, existing, readEntry),
    ),
  };
}

/** What exporting ORC skills to a target would do, per skill, without writing anything. */
export function planSkillExport(
  names: string[] | undefined,
  target: SkillExportTarget,
  readEntry?: SkillEntryReader,
): SkillExportPlan {
  const { target: resolved, items } = buildPlan(names, target, readEntry);
  return {
    dir: resolved.dir,
    label: resolved.label,
    skills: items.map(({ files: _files, ...item }) => item),
  };
}

function moveDir(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function writeBundle(dir: string, name: string, files: SkillBundle): void {
  const staging = join(dir, `.${name}.orc-export-${crypto.randomUUID()}`);
  try {
    for (const [path, bytes] of files) {
      const destination = join(staging, ...path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { flag: "wx" });
    }
    renameSync(staging, join(dir, name));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Writes ORC skills (effective SKILL.md plus supporting files) into <target>/<name>. Skills that
 * are identical in the target are left alone; near copies, conflicts and same-content skills under
 * another name are written only when listed in `overwrite`, and a replaced folder is first moved to
 * ~/.orc/skill-export-backups. Symlinked target folders are never replaced.
 */
export function exportSkills(
  input: {
    names?: string[] | undefined;
    target: SkillExportTarget;
    overwrite?: string[] | undefined;
  },
  readEntry?: SkillEntryReader,
): SkillExportResult {
  if (input.names && input.names.length > 500)
    throw new ValidationError("Select at most 500 skills");
  const { target, items } = buildPlan(input.names, input.target, readEntry);
  if (input.names?.length && items.every((item) => item.reason === "Skill not found"))
    throw new NotFoundError("Skill", input.names.join(", "));
  const overwrite = new Set(input.overwrite ?? []);
  const result: SkillExportResult = { dir: target.dir, exported: [], skipped: [] };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const item of items) {
    const allowed = item.status === "new" || (item.can_overwrite && overwrite.has(item.name));
    if (!allowed || !item.files) {
      result.skipped.push({ name: item.name, reason: skipReason(item) });
      continue;
    }
    try {
      mkdirSync(target.dir, { recursive: true });
      let backup: string | undefined;
      if (existsSync(item.path)) {
        backup = join(BACKUP_DIR, stamp, item.name);
        moveDir(item.path, backup);
      }
      try {
        writeBundle(target.dir, item.name, item.files);
      } catch (error) {
        if (backup && !existsSync(item.path)) moveDir(backup, item.path);
        throw error;
      }
      result.exported.push({
        name: item.name,
        path: item.path,
        replaced: Boolean(backup),
        ...(backup ? { backup } : {}),
      });
    } catch (error) {
      result.skipped.push({ name: item.name, reason: (error as Error).message });
    }
  }
  return result;
}

function skipReason(item: PlannedItem): string {
  if (item.status === "identical") return "Already identical in the target";
  if (item.status === "blocked") return item.reason ?? "Cannot be written";
  if (item.status === "duplicate") return `${item.reason}; select overwrite to write it anyway`;
  return `${item.status === "near" ? "A near copy" : "A different skill with this name"} exists; select overwrite to replace it`;
}
