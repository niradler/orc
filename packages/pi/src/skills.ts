import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { OrcApiClient, OrcSkillListItem } from "./api.js";
import type { SkillMode } from "./config.js";

export type SyncReport = {
  dir: string;
  written: string[];
  removed: string[];
  skipped: string[];
  errors: string[];
};

/** Only directories carrying this marker are ever pruned, so a shared skill folder is safe. */
export const MANAGED_MARKER = ".porc-managed";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Skills shipped in this package, which Pi loads from the package manifest. */
export const BUNDLED_SKILLS = ["orc-platform", "orc-sdlc"] as const;

/** Resolve a skill-relative path, rejecting traversal and absolute paths. */
export function skillFilePath(root: string, relative: string): string | undefined {
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  const base = resolve(root);
  const target = resolve(base, normalized);
  return target === base || target.startsWith(`${base}${sep}`) ? target : undefined;
}

function scopeFor(skill: OrcSkillListItem, projectId: string | undefined) {
  if (!skill.project_ids.length) return { global: true as const };
  if (projectId && skill.project_ids.includes(projectId)) return { projectId };
  return undefined;
}

/** Materialize the ORC skills visible to a project into Pi's managed skill directory. */
export async function syncOrcSkills(
  api: OrcApiClient,
  syncDir: string,
  options: { mode?: SkillMode; names?: string[]; projectId?: string } = {},
): Promise<SyncReport> {
  const report: SyncReport = { dir: syncDir, written: [], removed: [], skipped: [], errors: [] };
  const mode = options.mode ?? "all";
  if (mode === "search") {
    pruneManaged(syncDir, new Set(), report);
    return report;
  }
  const listed = await api.listSkills();
  const wanted = mode === "pinned" ? new Set(options.names ?? []) : undefined;
  const bundled = new Set<string>(BUNDLED_SKILLS);
  const selected = listed.filter((skill) => {
    if (bundled.has(skill.name)) return false;
    if (wanted && !wanted.has(skill.name)) return false;
    return scopeFor(skill, options.projectId) !== undefined;
  });
  if (wanted) {
    for (const name of wanted) {
      if (!listed.some((skill) => skill.name === name))
        report.skipped.push(`${name} (not available for this project)`);
      else if (bundled.has(name)) report.skipped.push(`${name} (bundled with porc)`);
    }
  }
  for (const item of selected) {
    const scope = scopeFor(item, options.projectId);
    if (!scope) continue;
    const dir = skillFilePath(syncDir, item.name);
    if (!dir || !SAFE_NAME.test(item.name)) {
      report.errors.push(`${item.name}: unsafe skill name`);
      continue;
    }
    try {
      const skill = await api.readSkill(item.name, scope);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "SKILL.md"), skill.content, "utf8");
      writeFileSync(resolve(dir, MANAGED_MARKER), "written by porc; safe to delete\n", "utf8");
      for (const file of skill.files ?? []) {
        if (file.path === "SKILL.md" || file.path === "./SKILL.md") continue;
        const target = skillFilePath(dir, file.path);
        if (!target) {
          report.skipped.push(`${item.name}/${file.path} (unsafe path)`);
          continue;
        }
        const content = await api.readSkillFile(item.name, file.path, scope);
        if (content.encoding !== "utf8") {
          report.skipped.push(`${item.name}/${file.path} (binary)`);
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content.content, "utf8");
      }
      report.written.push(item.name);
    } catch (err) {
      report.errors.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  pruneManaged(
    syncDir,
    new Set([...selected.map((skill) => skill.name), ...report.written]),
    report,
  );
  return report;
}

function pruneManaged(syncDir: string, keep: Set<string>, report: SyncReport): void {
  const bundled = new Set<string>(BUNDLED_SKILLS);
  for (const name of readManagedSkillNames(syncDir)) {
    if (keep.has(name) || bundled.has(name)) continue;
    rmSync(resolve(syncDir, name), { recursive: true, force: true });
    report.removed.push(name);
  }
}

/** Directory names in the managed skill dir that look like skills porc wrote. */
export function readManagedSkillNames(syncDir: string): string[] {
  try {
    return readdirSync(syncDir).filter((name) => {
      if (!SAFE_NAME.test(name)) return false;
      try {
        const dir = resolve(syncDir, name);
        return statSync(dir).isDirectory() && statSync(resolve(dir, MANAGED_MARKER)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export async function listOrcSkills(api: OrcApiClient): Promise<OrcSkillListItem[]> {
  return api.listSkills();
}
