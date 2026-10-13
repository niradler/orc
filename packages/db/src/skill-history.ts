import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  parseFrontmatter,
  readSkill,
  type SkillFull,
  type SkillMeta,
  type SkillRefContent,
} from "@orc/core/skill-service";
import { type SkillUpdate, SkillUpdateSchema } from "@orc/core/wiki";
import { AuditLog } from "./audit.js";
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
function key(projectId: string | null): string {
  return projectId === null ? "global:" : `project:${projectId}`;
}

export class SkillHistory {
  constructor(private readonly sqlite: Database) {}
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
