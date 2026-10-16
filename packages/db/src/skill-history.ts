import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  type ListSkillsOpts,
  listSkills,
  parseFrontmatter,
  readSkill,
  type SkillFull,
  type SkillMeta,
  type SkillRefContent,
  validateAuthoredSkillDescription,
} from "@orc/core/skill-service";
import { type SkillUpdate, SkillUpdateSchema } from "@orc/core/wiki";
import { AuditLog } from "./audit.js";
import {
  addReads,
  compareByReads,
  compareByRecent,
  emptyReadUsage,
  type ListSort,
  type ReadSource,
  type ReadsBySource,
  type ReadUsage,
  rankItems,
} from "./read-usage.js";
import { WikiStore } from "./wiki.js";

export function installSkillHistory(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS skill_changes (
    id TEXT PRIMARY KEY, project_key TEXT NOT NULL, project_id TEXT, skill_name TEXT NOT NULL,
    raw TEXT NOT NULL, previous_raw TEXT NOT NULL, reason TEXT NOT NULL, author TEXT NOT NULL,
    session_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS skill_changes_scope_idx ON skill_changes(project_key, skill_name, created_at DESC);
  CREATE TABLE IF NOT EXISTS skill_instructions (
    project_key TEXT NOT NULL, skill_name TEXT NOT NULL, change_id TEXT NOT NULL REFERENCES skill_changes(id),
    PRIMARY KEY(project_key, skill_name)
  );
  CREATE TABLE IF NOT EXISTS skill_usage (
    project_key TEXT NOT NULL, skill_name TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL, read_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER NOT NULL,
    PRIMARY KEY(project_key, skill_name, ref, source)
  );`);
}
export type SkillChange = {
  id: string;
  project_id: string | null;
  skill_name: string;
  raw: string;
  previous_raw: string;
  reason: string;
  author: string;
  session_id: string | null;
  action: string;
  created_at: number;
};
export type SkillMutation = {
  id: string;
  project_id: string | null;
  updated_at: number;
  author: string;
};
export type EffectiveSkill = SkillFull & { mutation?: SkillMutation };
export type SkillListSort = ListSort;
export type SkillListOptions = ListSkillsOpts & { sort?: SkillListSort | undefined };
/** Where a skill read came from; `ui` is a person browsing the web app, the rest are agents. */
export type SkillReadSource = ReadSource;
export type SkillReadsBySource = ReadsBySource;
export type SkillUsage = ReadUsage & {
  /** Supporting-file reads from any source. */
  ref_read_count: number;
};
type SkillUsageRow = {
  skill_name: string;
  source: SkillReadSource;
  main_reads: number;
  ref_reads: number;
  last_main_read_at: number | null;
};
export type SkillListItem = SkillMeta &
  SkillUsage & {
    mutation?: SkillMutation;
    activity_at: number;
  };
function key(projectId: string | null): string {
  return projectId === null ? "global:" : `project:${projectId}`;
}
function fileCreatedAt(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  const created = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  return Math.floor(created / 1000);
}
function emptyUsage(): SkillUsage {
  return { ...emptyReadUsage(), ref_read_count: 0 };
}

export class SkillHistory {
  constructor(private readonly sqlite: Database) {}
  list(projectId: string | null, opts?: SkillListOptions): SkillListItem[] {
    const usage = this.usage(projectId);
    let skills = listSkills({ ...opts, q: undefined, include_hidden: true }).map((skill) =>
      this.withUsage(this.metadata(skill, projectId), usage),
    );
    if (!opts?.include_hidden) skills = skills.filter((skill) => !skill.discovery_hidden);
    return rankItems(skills, opts?.sort === "recent" ? compareByRecent : compareByReads, opts?.q);
  }
  recordRead(name: string, projectId: string | null, source: SkillReadSource, ref?: string): void {
    const file = ref === undefined || ref === "SKILL.md" ? "" : ref;
    this.sqlite
      .query(
        "INSERT INTO skill_usage(project_key,skill_name,ref,source,read_count,last_read_at) VALUES(?,?,?,?,1,unixepoch()) ON CONFLICT(project_key,skill_name,ref,source) DO UPDATE SET read_count=read_count+1, last_read_at=excluded.last_read_at",
      )
      .run(key(projectId), name, file, source);
  }
  private usage(projectId: string | null): Map<string, SkillUsage> {
    const scoped = projectId === null ? "" : "WHERE project_key=?";
    const rows = this.sqlite
      .query<SkillUsageRow, string[]>(
        `SELECT skill_name, source, SUM(CASE WHEN ref='' THEN read_count ELSE 0 END) AS main_reads, SUM(CASE WHEN ref<>'' THEN read_count ELSE 0 END) AS ref_reads, MAX(CASE WHEN ref='' THEN last_read_at END) AS last_main_read_at FROM skill_usage ${scoped} GROUP BY skill_name, source`,
      )
      .all(...(projectId === null ? [] : [key(projectId)]));
    const usage = new Map<string, SkillUsage>();
    for (const row of rows) {
      const stats = usage.get(row.skill_name) ?? emptyUsage();
      addReads(stats, row.source, row.main_reads, row.last_main_read_at);
      stats.ref_read_count += row.ref_reads;
      usage.set(row.skill_name, stats);
    }
    return usage;
  }
  private withUsage(
    skill: SkillMeta & { mutation?: SkillMutation },
    usage: Map<string, SkillUsage>,
  ): SkillListItem {
    const stats = usage.get(skill.name) ?? emptyUsage();
    const activityAt =
      stats.last_read_at ?? skill.mutation?.updated_at ?? fileCreatedAt(skill.path);
    return { ...skill, ...stats, activity_at: activityAt };
  }
  private current(name: string, projectId: string | null): SkillChange | null {
    const read = this.sqlite.query<SkillChange, [string, string]>(
      `SELECT c.* FROM skill_instructions i JOIN skill_changes c ON c.id=i.change_id WHERE i.project_key=? AND i.skill_name=?`,
    );
    return (
      read.get(key(projectId), name) ?? (projectId === null ? null : read.get(key(null), name))
    );
  }
  metadata(skill: SkillMeta, projectId: string | null): SkillMeta & { mutation?: SkillMutation } {
    const change = this.current(skill.name, projectId);
    if (!change) return skill;
    const { frontmatter } = parseFrontmatter(change.raw);
    return {
      ...skill,
      discovery_hidden: false,
      description: frontmatter.description,
      mutation: {
        id: change.id,
        project_id: change.project_id,
        author: change.author,
        updated_at: change.created_at,
      },
    };
  }
  read(
    name: string,
    projectId: string | null,
    ref?: string,
  ): EffectiveSkill | SkillRefContent | null {
    const base = readSkill(name, ref);
    if (!base) return null;
    const change = this.current(name, projectId);
    if (!change || (ref && ref !== "SKILL.md")) return base;
    if (ref) return { ...(base as SkillRefContent), content: change.raw, encoding: "utf8" };
    const parsed = parseFrontmatter(change.raw);
    return {
      ...(base as SkillFull),
      ...this.metadata(base as SkillFull, projectId),
      content: parsed.body,
      metadata: parsed.frontmatter.metadata,
    };
  }
  history(name: string, projectId: string | null): SkillChange[] {
    const effective = this.current(name, projectId);
    const owner = effective ? effective.project_id : projectId;
    return this.sqlite
      .query<SkillChange, [string, string]>(
        `SELECT * FROM skill_changes WHERE project_key=? AND skill_name=? ORDER BY created_at DESC,rowid DESC`,
      )
      .all(key(owner), name);
  }
  update(input: SkillUpdate): EffectiveSkill {
    const page = SkillUpdateSchema.parse(input);
    const parsed = parseFrontmatter(page.content);
    if (parsed.frontmatter.name !== page.skill_name)
      throw new ValidationError("Skill name must stay unchanged");
    const base = readSkill(page.skill_name, "SKILL.md") as SkillRefContent | null;
    if (!base) throw new NotFoundError("Skill", page.skill_name);
    if (
      page.project_id !== null &&
      !this.sqlite.query("SELECT id FROM projects WHERE id=?").get(page.project_id)
    )
      throw new NotFoundError("Project", page.project_id);
    for (const slug of page.wiki_pages) new WikiStore(this.sqlite).get(page.project_id, slug);
    return this.sqlite.transaction(() => {
      const previous = this.current(page.skill_name, page.project_id)?.raw ?? base.content;
      if (previous !== page.expected_content)
        throw new ConflictError(
          "Skill changed since it was read; reload and reconcile before updating",
        );
      validateAuthoredSkillDescription(page.content, previous);
      this.apply(
        page.skill_name,
        page.project_id,
        page.content,
        previous,
        page.reason,
        page.author ?? "agent",
        page.session_id ?? null,
        "skill.updated",
      );
      return this.read(page.skill_name, page.project_id) as EffectiveSkill;
    })();
  }
  revert(
    name: string,
    projectId: string | null,
    changeId: string,
    expectedChangeId: string,
    reason: string,
    author = "human",
  ): EffectiveSkill {
    return this.sqlite.transaction(() => {
      const latest = this.current(name, projectId);
      if (!latest || latest.id !== expectedChangeId)
        throw new ConflictError("Skill changed since review; reload its history");
      if (latest.project_id !== projectId)
        throw new ValidationError("Select the changed skill's scope before reverting");
      const target = this.sqlite
        .query<SkillChange, [string, string, string]>(
          "SELECT * FROM skill_changes WHERE id=? AND project_key=? AND skill_name=?",
        )
        .get(changeId, key(projectId), name);
      if (!target) throw new NotFoundError("Skill change", changeId);
      this.apply(
        name,
        projectId,
        target.previous_raw,
        latest.raw,
        reason,
        author,
        null,
        "skill.reverted",
      );
      return this.read(name, projectId) as EffectiveSkill;
    })();
  }
  private apply(
    name: string,
    projectId: string | null,
    raw: string,
    previous: string,
    reason: string,
    author: string,
    sessionId: string | null,
    action: string,
  ): void {
    const id = ulid();
    this.sqlite
      .query(
        "INSERT INTO skill_changes(id,project_key,project_id,skill_name,raw,previous_raw,reason,author,session_id,action,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())",
      )
      .run(id, key(projectId), projectId, name, raw, previous, reason, author, sessionId, action);
    this.sqlite
      .query(
        "INSERT INTO skill_instructions(project_key,skill_name,change_id) VALUES(?,?,?) ON CONFLICT(project_key,skill_name) DO UPDATE SET change_id=excluded.change_id",
      )
      .run(key(projectId), name, id);
    new AuditLog(this.sqlite).record({
      action,
      project_id: projectId,
      actor: author,
      session_id: sessionId,
      subject_ids: [name],
      result_ids: [id],
      note: reason,
      snapshot: { change_id: id },
    });
  }
  prune(): void {
    this.sqlite
      .query(
        "DELETE FROM skill_changes WHERE created_at < unixepoch()-7776000 AND id NOT IN (SELECT change_id FROM skill_instructions)",
      )
      .run();
  }
}
