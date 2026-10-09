import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { readSkillFile } from "@orc/core/skill-files";
import type { SkillFull, SkillRefContent } from "@orc/core/skill-service";
import { parseFrontmatter, readSkill } from "@orc/core/skill-service";

type ActiveRow = { id: string; raw: string; base_hash: string };
export type SkillSnapshot = { skill: SkillFull; raw: string; hash: string; base_hash: string };

export function installSkillEvolution(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS skill_activations (
    id TEXT PRIMARY KEY,project_key TEXT NOT NULL,skill_name TEXT NOT NULL,proposal_id TEXT,
    evaluation_id TEXT,raw TEXT NOT NULL,previous_raw TEXT NOT NULL,base_hash TEXT NOT NULL,
    previous_hash TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,action TEXT NOT NULL,
    reason TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch())
  );
  CREATE UNIQUE INDEX IF NOT EXISTS skill_activation_current ON skill_activations(project_key,skill_name) WHERE active=1;`);
}

function key(project: string | null): string {
  return project === null ? "global:" : `project:${project}`;
}
function packageHash(skill: SkillFull, raw: string): string {
  const hash = createHash("sha256").update("SKILL.md\0").update(raw);
  for (const file of skill.files) {
    const content = readSkillFile(dirname(skill.path), file.name, false);
    hash.update(`\0${file.name}\0${content.encoding}\0`).update(content.content);
  }
  return hash.digest("hex");
}

export function getSkillSnapshot(
  sqlite: Database,
  name: string,
  project: string | null,
): SkillSnapshot {
  installSkillEvolution(sqlite);
  const skill = readSkill(name) as SkillFull | null;
  if (!skill) throw new NotFoundError("Skill", name);
  const original = readFileSync(skill.path, "utf8");
  const baseHash = packageHash(skill, original);
  const overlay = sqlite
    .query<ActiveRow, [string, string]>(
      "SELECT id,raw,base_hash FROM skill_activations WHERE project_key=? AND skill_name=? AND active=1",
    )
    .get(key(project), name);
  const raw = overlay?.base_hash === baseHash ? overlay.raw : original;
  return { skill, raw, hash: packageHash(skill, raw), base_hash: baseHash };
}

export function readEvolvedSkill(
  sqlite: Database,
  name: string,
  project: string | null,
  ref?: string,
): SkillFull | SkillRefContent | null {
  const installed = readSkill(name, ref);
  if (!installed || (ref && ref !== "SKILL.md")) return installed;
  const snapshot = getSkillSnapshot(sqlite, name, project);
  if (ref === "SKILL.md")
    return { ...installed, content: snapshot.raw, encoding: "utf8" } as SkillRefContent;
  if (snapshot.raw === readFileSync(snapshot.skill.path, "utf8")) return snapshot.skill;
  const parsed = parseFrontmatter(snapshot.raw);
  return {
    ...snapshot.skill,
    content: parsed.body,
    description: parsed.frontmatter.description,
    metadata: { ...parsed.frontmatter.metadata, evolved: "true", baseline_hash: snapshot.hash },
  };
}

export function activateSkill(
  sqlite: Database,
  input: {
    project: string | null;
    name: string;
    baselineHash: string;
    candidate: string;
    proposalId: string;
    evaluationId: string;
  },
): string {
  const parsed = parseFrontmatter(input.candidate);
  if (parsed.frontmatter.name !== input.name || !parsed.body.trim())
    throw new ValidationError(
      "Candidate must retain the skill identity and meaningful instructions",
    );
  const current = getSkillSnapshot(sqlite, input.name, input.project);
  if (current.hash !== input.baselineHash)
    throw new ConflictError("Skill baseline changed; reevaluate the current package");
  if (input.candidate === current.raw) throw new ValidationError("Candidate has no change");
  return sqlite.transaction(() => {
    sqlite
      .query(
        "UPDATE skill_activations SET active=0 WHERE project_key=? AND skill_name=? AND active=1",
      )
      .run(key(input.project), input.name);
    const id = ulid();
    sqlite
      .query(
        "INSERT INTO skill_activations(id,project_key,skill_name,proposal_id,evaluation_id,raw,previous_raw,base_hash,previous_hash,action,reason) VALUES(?,?,?,?,?,?,?,?,?,'promote','Held-out evaluation gate passed')",
      )
      .run(
        id,
        key(input.project),
        input.name,
        input.proposalId,
        input.evaluationId,
        input.candidate,
        current.raw,
        current.base_hash,
        current.hash,
      );
    return id;
  })();
}

export function revertSkill(
  sqlite: Database,
  id: string,
  project: string | null,
  reason: string,
): string {
  installSkillEvolution(sqlite);
  if (!reason.trim()) throw new ValidationError("Revert requires a reason");
  const row = sqlite
    .query<
      {
        skill_name: string;
        raw: string;
        previous_raw: string;
        base_hash: string;
        previous_hash: string;
      },
      [string, string]
    >(
      "SELECT skill_name,raw,previous_raw,base_hash,previous_hash FROM skill_activations WHERE id=? AND project_key=? AND active=1",
    )
    .get(id, key(project));
  if (!row) throw new ConflictError("Activation is not current; reload history before reverting");
  const snapshot = getSkillSnapshot(sqlite, row.skill_name, project);
  if (snapshot.raw !== row.raw || snapshot.base_hash !== row.base_hash)
    throw new ConflictError("Installed skill changed; refusing to revert over a newer package");
  return sqlite.transaction(() => {
    sqlite.query("UPDATE skill_activations SET active=0 WHERE id=? AND active=1").run(id);
    const revertId = ulid();
    sqlite
      .query(
        "INSERT INTO skill_activations(id,project_key,skill_name,raw,previous_raw,base_hash,previous_hash,action,reason) VALUES(?,?,?,?,?,?,?,'revert',?)",
      )
      .run(
        revertId,
        key(project),
        row.skill_name,
        row.previous_raw,
        row.raw,
        row.base_hash,
        snapshot.hash,
        reason,
      );
    return revertId;
  })();
}
