import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { normalizeTags } from "@orc/core/tags";
import { type AuditActor, AuditLog } from "./audit.js";

export const MEMORY_TYPES = ["fact", "decision", "event", "rule", "discovery"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_IMPORTANCE = ["low", "normal", "high", "critical"] as const;
export type MemoryImportance = (typeof MEMORY_IMPORTANCE)[number];

export type MemoryFields = {
  content?: string | undefined;
  title?: string | undefined;
  type?: MemoryType | undefined;
  source?: string | undefined;
  scope?: string | undefined;
  tags?: string[] | undefined;
  importance?: MemoryImportance | undefined;
};

export type StoreMemoryInput = MemoryFields &
  AuditActor & {
    content: string;
    project_id?: string | null | undefined;
    expires_at?: Date | undefined;
    merge_into?: string[] | undefined;
    supersedes?: string[] | undefined;
  };

export type SimilarMemory = {
  id: string;
  title: string | null;
  type: MemoryType;
  snippet: string;
  similarity: number;
};

export type StoreMemoryResult =
  | { status: "added"; id: string; similar: SimilarMemory[]; superseded: string[] }
  | { status: "merged"; id: string; merged: string[]; superseded: string[] }
  | { status: "skipped"; existing_id: string; similar: SimilarMemory[]; superseded: string[] };

export const SIMILAR_MEMORY_HINT =
  "Similar memories exist. If one says the same thing, re-store with merge_into; if one is now wrong, supersede it.";

export const MEMORY_REMOVAL_ACTIONS = ["memory.merged", "memory.superseded", "memory.deleted"];

type MemoryRow = {
  id: string;
  title: string | null;
  type: MemoryType;
  content: string;
  source: string | null;
  tags: string | null;
  scope: string | null;
  project_id: string | null;
  importance: MemoryImportance;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

type MemoryOwner = { project_id: string | null; scope: string | null };

// Near-identical notes are dropped without asking the agent; anything less similar is
// stored and reported back so the agent can merge or supersede with real judgement.
const SKIP_SIMILARITY = 0.9;
// Short notes differ by one meaningful token ("port 7711" vs "port 7700"), so they never auto-skip.
const MIN_SKIP_TOKENS = 5;
const CANDIDATE_LIMIT = 5;
const REPORTED_SIMILAR = 3;
const MAX_QUERY_TERMS = 32;
const SNIPPET_LENGTH = 150;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? [],
  );
}

export function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared++;
  return shared / (leftTokens.size + rightTokens.size - shared);
}

function canAutoSkip(left: string, right: string): boolean {
  if (tokenize(left).size < MIN_SKIP_TOKENS || tokenize(right).size < MIN_SKIP_TOKENS) {
    return false;
  }
  return jaccardSimilarity(left, right) >= SKIP_SIMILARITY;
}

function buildMatchExpression(text: string): string {
  return [...tokenize(text)]
    .slice(0, MAX_QUERY_TERMS)
    .map((term) => `"${term}"`)
    .join(" OR ");
}

function snippet(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_LENGTH) return flat;
  return `${flat.slice(0, SNIPPET_LENGTH)}…`;
}

function describeOwner(owner: MemoryOwner): string {
  return `project ${owner.project_id ?? "(global)"}, scope ${owner.scope ?? "(none)"}`;
}

function parseTags(row: MemoryRow): string[] {
  return row.tags ? (JSON.parse(row.tags) as string[]) : [];
}

function highestImportance(values: MemoryImportance[]): MemoryImportance {
  return values.reduce(
    (best, value) =>
      MEMORY_IMPORTANCE.indexOf(value) > MEMORY_IMPORTANCE.indexOf(best) ? value : best,
    "low" as MemoryImportance,
  );
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function actorOf(actor: AuditActor): AuditActor {
  return { actor: actor.actor ?? null, session_id: actor.session_id ?? null };
}

// Every change goes through here so it is written to the audit log in the same transaction.
// Merge and supersede remove the old rows; their full content lives on in the audit snapshot.
export class MemoryStore {
  private readonly audit: AuditLog;

  constructor(private readonly sqlite: Database) {
    this.audit = new AuditLog(sqlite);
  }

  store(input: StoreMemoryInput): StoreMemoryResult {
    if (!input.content.trim()) throw new ValidationError("Memory content cannot be empty");
    return this.sqlite.transaction((): StoreMemoryResult => {
      if (input.merge_into?.length) return this.mergeInto(input.merge_into, input);

      const owner: MemoryOwner = {
        project_id: input.project_id ?? null,
        scope: input.scope ?? null,
      };
      const type = input.type ?? "fact";
      const candidates = this.findCandidates(input.content, owner.project_id);
      const duplicate = candidates.find(
        (row) =>
          row.type === type && row.scope === owner.scope && canAutoSkip(input.content, row.content),
      );
      if (duplicate) {
        const superseded = this.supersedeWithin(duplicate, input.supersedes ?? [], input);
        return {
          status: "skipped",
          existing_id: duplicate.id,
          similar: this.toSimilar(input.content, candidates)
            .filter((memory) => memory.id !== duplicate.id && !superseded.includes(memory.id))
            .slice(0, REPORTED_SIMILAR),
          superseded,
        };
      }

      const created = this.insert(input, owner, {
        type,
        title: input.title ?? null,
        tags: normalizeTags(input.tags ?? []),
        importance: input.importance ?? "normal",
      });
      this.audit.record({
        ...actorOf(input),
        action: "memory.created",
        subject_ids: [created.id],
        project_id: owner.project_id,
        note: created.title,
      });
      const superseded = this.supersedeWithin(created, input.supersedes ?? [], input);
      return {
        status: "added",
        id: created.id,
        similar: this.toSimilar(input.content, candidates)
          .filter((memory) => !superseded.includes(memory.id))
          .slice(0, REPORTED_SIMILAR),
        superseded,
      };
    })();
  }

  supersede(replacementId: string, ids: string[], actor: AuditActor = {}): string[] {
    return this.sqlite.transaction((): string[] =>
      this.supersedeWithin(this.require(replacementId), ids, actor),
    )();
  }

  update(id: string, fields: MemoryFields, actor: AuditActor = {}): void {
    this.sqlite.transaction((): void => {
      const before = this.require(id);
      this.sqlite
        .query(
          `UPDATE memories SET content = ?, title = ?, type = ?, source = ?, scope = ?, tags = ?,
             importance = ?, updated_at = unixepoch() WHERE id = ?`,
        )
        .run(
          fields.content ?? before.content,
          fields.title ?? before.title,
          fields.type ?? before.type,
          fields.source ?? before.source,
          fields.scope ?? before.scope,
          fields.tags ? JSON.stringify(normalizeTags(fields.tags)) : before.tags,
          fields.importance ?? before.importance,
          id,
        );
      this.audit.record({
        ...actorOf(actor),
        action: "memory.updated",
        subject_ids: [id],
        project_id: before.project_id,
        snapshot: [before],
      });
    })();
  }

  remove(id: string, actor: AuditActor = {}): void {
    this.sqlite.transaction((): void => {
      const before = this.require(id);
      this.deleteRows([id]);
      this.audit.record({
        ...actorOf(actor),
        action: "memory.deleted",
        subject_ids: [id],
        project_id: before.project_id,
        snapshot: [before],
      });
    })();
  }

  findSimilar(content: string, projectId: string | null): SimilarMemory[] {
    return this.toSimilar(content, this.findCandidates(content, projectId));
  }

  private mergeInto(ids: string[], input: StoreMemoryInput): StoreMemoryResult {
    const targets = unique(ids).map((id) => this.require(id));
    const first = targets[0] as MemoryRow;
    const owner: MemoryOwner = {
      project_id: input.project_id ?? null,
      scope: input.scope ?? first.scope,
    };
    for (const target of targets) this.assertSameOwner(target, owner);

    const created = this.insert(input, owner, {
      type: input.type ?? first.type,
      title: input.title ?? first.title,
      tags: normalizeTags([...targets.flatMap(parseTags), ...(input.tags ?? [])]),
      importance: highestImportance([
        ...targets.map((target) => target.importance),
        input.importance ?? "normal",
      ]),
    });
    const merged = targets.map((target) => target.id);
    this.deleteRows(merged);
    this.audit.record({
      ...actorOf(input),
      action: "memory.merged",
      subject_ids: merged,
      result_ids: [created.id],
      project_id: owner.project_id,
      note: created.title,
      snapshot: targets,
    });
    const superseded = this.supersedeWithin(created, input.supersedes ?? [], input);
    return { status: "merged", id: created.id, merged, superseded };
  }

  private supersedeWithin(replacement: MemoryRow, ids: string[], actor: AuditActor): string[] {
    const targets = unique(ids).map((id) => {
      if (id === replacement.id) throw new ValidationError("A memory cannot supersede itself");
      const target = this.require(id);
      this.assertSameOwner(target, replacement);
      return target;
    });
    if (targets.length === 0) return [];
    const superseded = targets.map((target) => target.id);
    this.deleteRows(superseded);
    this.audit.record({
      ...actorOf(actor),
      action: "memory.superseded",
      subject_ids: superseded,
      result_ids: [replacement.id],
      project_id: replacement.project_id,
      snapshot: targets,
    });
    return superseded;
  }

  private insert(
    input: StoreMemoryInput,
    owner: MemoryOwner,
    resolved: {
      type: MemoryType;
      title: string | null;
      tags: string[];
      importance: MemoryImportance;
    },
  ): MemoryRow {
    const id = ulid();
    const expiresAt = input.expires_at ? Math.floor(input.expires_at.getTime() / 1000) : null;
    this.sqlite
      .query(
        `INSERT INTO memories(id, title, type, content, source, scope, project_id, tags, importance, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
      )
      .run(
        id,
        resolved.title,
        resolved.type,
        input.content,
        input.source ?? null,
        owner.scope,
        owner.project_id,
        resolved.tags.length > 0 ? JSON.stringify(resolved.tags) : null,
        resolved.importance,
        expiresAt,
      );
    return this.require(id);
  }

  private deleteRows(ids: string[]): void {
    const remove = this.sqlite.query("DELETE FROM memories WHERE id = ?");
    for (const id of ids) remove.run(id);
  }

  private findCandidates(content: string, projectId: string | null): MemoryRow[] {
    const expression = buildMatchExpression(content);
    if (!expression) return [];
    return this.sqlite
      .query<MemoryRow, [string, string | null, number]>(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.id
         WHERE memories_fts MATCH ? AND m.project_id IS ?
           AND (m.expires_at IS NULL OR m.expires_at > unixepoch())
         ORDER BY bm25(memories_fts, 0, 1.0, 3.0, 1.5, 0) LIMIT ?`,
      )
      .all(expression, projectId, CANDIDATE_LIMIT);
  }

  private toSimilar(content: string, rows: MemoryRow[]): SimilarMemory[] {
    return rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        snippet: snippet(row.content),
        similarity: jaccardSimilarity(content, row.content),
      }))
      .sort((left, right) => right.similarity - left.similarity);
  }

  private assertSameOwner(target: MemoryRow, owner: MemoryOwner): void {
    if (target.project_id === owner.project_id && target.scope === owner.scope) return;
    throw new ValidationError(
      `Memory ${target.id} belongs to ${describeOwner(target)}, not ${describeOwner(owner)}`,
    );
  }

  // A removed id resolves to a conflict that names its replacement, so stale citations self-correct.
  private require(id: string): MemoryRow {
    const row = this.sqlite
      .query<MemoryRow, [string]>("SELECT * FROM memories WHERE id = ?")
      .get(id);
    if (row) return row;
    const removal = this.audit.findLatest(id, MEMORY_REMOVAL_ACTIONS);
    if (!removal) throw new NotFoundError("Memory", id);
    const replacement =
      removal.result_ids.length > 0 ? `; use ${removal.result_ids.join(", ")}` : "";
    throw new ConflictError(`Memory ${id} was removed (${removal.action})${replacement}`);
  }
}
