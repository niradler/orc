import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import { validateSkillName } from "@orc/core/skill-service";
import { AuditLog } from "./audit.js";
import {
  addReads,
  compareByReads,
  compareByRecent,
  emptyReadUsage,
  type ListSort,
  type RankedItem,
  type ReadSource,
  type ReadUsage,
  rankItems,
} from "./read-usage.js";

// A memory is a skill-shaped DB row: a name (unique per project), a short description that
// lists and search use, and short content that memory_read returns. Long guidance is a skill.

export const MEMORY_DESCRIPTION_MAX = 300;
export const MEMORY_PRIORITY_MAX = 100;

export type Memory = {
  project_id: string;
  name: string;
  description: string;
  content: string;
  /** 0-100, higher is read first; null when nobody scored it yet. */
  priority: number | null;
  author: string;
  /** Native session id of the agent that last created or edited the memory. */
  session_id: string | null;
  created_at: number;
  updated_at: number;
};
export type MemoryListItem = Omit<Memory, "content"> &
  ReadUsage &
  RankedItem & {
    /** project_id + name; unique across projects. */
    key: string;
  };
export type MemoryListSort = ListSort | "priority";
export type MemoryListOptions = { q?: string | undefined; sort?: MemoryListSort | undefined };
export type MemoryWriter = {
  author?: string | null | undefined;
  session_id?: string | null | undefined;
  reason?: string | undefined;
};
export type CreateMemoryInput = MemoryWriter & {
  project_id: string;
  name: string;
  description: string;
  content: string;
  priority?: number | null | undefined;
};
export type UpdateMemoryFields = {
  description?: string | undefined;
  content?: string | undefined;
  priority?: number | null | undefined;
};
export type MemorySnapshot = { description: string; content: string; priority: number | null };
export type MemoryChangeAction =
  | "memory.created"
  | "memory.updated"
  | "memory.deleted"
  | "memory.reverted";
export type MemoryChange = {
  id: string;
  project_id: string;
  memory_name: string;
  action: MemoryChangeAction;
  /** State before the change; null when the change created the memory. */
  previous: MemorySnapshot | null;
  /** State after the change; null when the change deleted the memory. */
  current: MemorySnapshot | null;
  reason: string | null;
  author: string;
  session_id: string | null;
  created_at: number;
};
type MemoryChangeRow = Omit<MemoryChange, "previous" | "current"> & {
  previous: string | null;
  current: string | null;
};

export function installMemories(sqlite: Database): void {
  // The first memories table (typed/scoped notes with FTS and auto-dedup) was replaced outright;
  // its rows are dropped, not converted. Only that old shape has a `type` column.
  const columns = sqlite.query<{ name: string }, []>("PRAGMA table_info(memories)").all();
  if (columns.some((column) => column.name === "type")) {
    sqlite.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;
      DROP TABLE IF EXISTS memories_fts_trigram;
      DROP TABLE IF EXISTS agent_memory_sources;
      DROP TABLE memories;
    `);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      priority INTEGER CHECK (priority BETWEEN 0 AND 100),
      author TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS memory_changes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, memory_name TEXT NOT NULL, action TEXT NOT NULL,
      previous TEXT, current TEXT, reason TEXT, author TEXT NOT NULL, session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_changes_name_idx ON memory_changes(project_id, memory_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS memory_changes_session_idx ON memory_changes(session_id);
    CREATE TABLE IF NOT EXISTS memory_usage (
      project_id TEXT NOT NULL, memory_name TEXT NOT NULL, source TEXT NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, memory_name, source)
    );
  `);
}

function chars(text: string): number {
  return [...text].length;
}

function validateName(name: string): void {
  try {
    validateSkillName(name);
  } catch {
    throw new ValidationError(
      "Invalid memory name: use 1-64 lowercase letters or numbers separated by single hyphens",
    );
  }
}

function validateDescription(description: string): void {
  if (!description.trim()) throw new ValidationError("Memory description cannot be empty");
  if (chars(description) > MEMORY_DESCRIPTION_MAX)
    throw new ValidationError(
      `Memory description is ${chars(description)} characters; the limit is ${MEMORY_DESCRIPTION_MAX}`,
    );
}

function validatePriority(priority: number | null | undefined): void {
  if (priority === null || priority === undefined) return;
  if (!Number.isInteger(priority) || priority < 0 || priority > MEMORY_PRIORITY_MAX)
    throw new ValidationError(
      `Memory priority must be an integer from 0 to ${MEMORY_PRIORITY_MAX}`,
    );
}

function snapshotOf(memory: Memory): MemorySnapshot {
  return { description: memory.description, content: memory.content, priority: memory.priority };
}

function parseChange(row: MemoryChangeRow): MemoryChange {
  return {
    ...row,
    previous: row.previous ? (JSON.parse(row.previous) as MemorySnapshot) : null,
    current: row.current ? (JSON.parse(row.current) as MemorySnapshot) : null,
  };
}

/** Higher priority first; unscored memories after every scored one. */
function compareByPriority(left: MemoryListItem, right: MemoryListItem): number {
  return (
    (right.priority ?? -1) - (left.priority ?? -1) ||
    right.read_count - left.read_count ||
    right.activity_at - left.activity_at ||
    left.name.localeCompare(right.name)
  );
}

const COMPARE: Record<MemoryListSort, (left: MemoryListItem, right: MemoryListItem) => number> = {
  reads: compareByReads,
  recent: compareByRecent,
  priority: compareByPriority,
};

// Every write goes through here so the row, its history entry and the audit entry change together.
export class MemoryStore {
  private readonly maxContentChars: number;

  constructor(
    private readonly sqlite: Database,
    opts: { maxContentChars?: number } = {},
  ) {
    this.maxContentChars = opts.maxContentChars ?? loadConfig().memory.max_content_chars;
  }

  /** Memories of one project, or of every project when projectId is null. */
  list(projectId: string | null, opts: MemoryListOptions = {}): MemoryListItem[] {
    const scoped = projectId === null ? "" : "WHERE project_id=?";
    const params = projectId === null ? [] : [projectId];
    const rows = this.sqlite
      .query<Omit<Memory, "content">, string[]>(
        `SELECT project_id,name,description,priority,author,session_id,created_at,updated_at FROM memories ${scoped}`,
      )
      .all(...params);
    const usage = new Map<string, ReadUsage>();
    for (const row of this.sqlite
      .query<
        {
          project_id: string;
          memory_name: string;
          source: ReadSource;
          read_count: number;
          last_read_at: number;
        },
        string[]
      >(`SELECT project_id,memory_name,source,read_count,last_read_at FROM memory_usage ${scoped}`)
      .all(...params)) {
      const id = `${row.project_id}/${row.memory_name}`;
      const stats = usage.get(id) ?? emptyReadUsage();
      addReads(stats, row.source, row.read_count, row.last_read_at);
      usage.set(id, stats);
    }
    const items = rows.map((row): MemoryListItem => {
      const key = `${row.project_id}/${row.name}`;
      const stats = usage.get(key) ?? emptyReadUsage();
      return { ...row, ...stats, key, activity_at: stats.last_read_at ?? row.updated_at };
    });
    return rankItems(items, COMPARE[opts.sort ?? "reads"], opts.q);
  }

  /** What a session starts with: the top memories by priority, then reads. Not counted as reads. */
  context(projectId: string, limit: number): MemoryListItem[] {
    return this.list(projectId, { sort: "priority" }).slice(0, limit);
  }

  get(projectId: string, name: string): Memory {
    const memory = this.find(projectId, name);
    if (!memory) throw new NotFoundError("Memory", name);
    return memory;
  }

  /** Returns the memory and counts the read for its source. */
  read(projectId: string, name: string, source: ReadSource): Memory {
    const memory = this.get(projectId, name);
    this.sqlite
      .query(
        "INSERT INTO memory_usage(project_id,memory_name,source,read_count,last_read_at) VALUES(?,?,?,1,unixepoch()) ON CONFLICT(project_id,memory_name,source) DO UPDATE SET read_count=read_count+1, last_read_at=excluded.last_read_at",
      )
      .run(projectId, name, source);
    return memory;
  }

  create(input: CreateMemoryInput): Memory {
    validateName(input.name);
    const snapshot: MemorySnapshot = {
      description: input.description,
      content: input.content,
      priority: input.priority ?? null,
    };
    this.validate(snapshot);
    return this.sqlite.transaction((): Memory => {
      if (!this.sqlite.query("SELECT 1 FROM projects WHERE id=?").get(input.project_id))
        throw new NotFoundError("Project", input.project_id);
      if (this.find(input.project_id, input.name))
        throw new ConflictError(
          `Memory ${input.name} already exists in this project; update it instead`,
        );
      this.write(input.project_id, input.name, null, snapshot, "memory.created", input);
      return this.get(input.project_id, input.name);
    })();
  }

  update(
    projectId: string,
    name: string,
    fields: UpdateMemoryFields,
    writer: MemoryWriter = {},
  ): Memory {
    return this.sqlite.transaction((): Memory => {
      const before = this.get(projectId, name);
      const next: MemorySnapshot = {
        description: fields.description ?? before.description,
        content: fields.content ?? before.content,
        priority: fields.priority === undefined ? before.priority : fields.priority,
      };
      this.validate(next);
      this.write(projectId, name, before, next, "memory.updated", writer);
      return this.get(projectId, name);
    })();
  }

  remove(projectId: string, name: string, writer: MemoryWriter = {}): void {
    this.sqlite.transaction((): void => {
      const before = this.get(projectId, name);
      this.write(projectId, name, before, null, "memory.deleted", writer);
    })();
  }

  history(projectId: string, name: string): MemoryChange[] {
    return this.sqlite
      .query<MemoryChangeRow, [string, string]>(
        "SELECT * FROM memory_changes WHERE project_id=? AND memory_name=? ORDER BY created_at DESC, rowid DESC",
      )
      .all(projectId, name)
      .map(parseChange);
  }

  /** Changes written by one agent session, newest first. */
  sessionChanges(sessionId: string): MemoryChange[] {
    return this.sqlite
      .query<MemoryChangeRow, [string]>(
        "SELECT * FROM memory_changes WHERE session_id=? ORDER BY created_at DESC, rowid DESC",
      )
      .all(sessionId)
      .map(parseChange);
  }

  /**
   * Restores the state from before `changeId`: reverting a creation deletes the memory, reverting a
   * deletion brings it back. `expectedChangeId` must still be the latest change.
   */
  revert(
    projectId: string,
    name: string,
    changeId: string,
    expectedChangeId: string,
    writer: MemoryWriter & { reason: string },
  ): Memory | null {
    return this.sqlite.transaction((): Memory | null => {
      const [latest] = this.history(projectId, name);
      if (!latest || latest.id !== expectedChangeId)
        throw new ConflictError("Memory changed since review; reload its history");
      const target = this.history(projectId, name).find((change) => change.id === changeId);
      if (!target) throw new NotFoundError("Memory change", changeId);
      const before = this.find(projectId, name);
      if (target.previous) this.validate(target.previous);
      this.write(projectId, name, before, target.previous, "memory.reverted", writer);
      return this.find(projectId, name);
    })();
  }

  /** Drops a project's memories with their history and reads (the project is being deleted). */
  removeProject(projectId: string): void {
    for (const table of ["memories", "memory_changes", "memory_usage"])
      this.sqlite.query(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
  }

  private validate(snapshot: MemorySnapshot): void {
    validateDescription(snapshot.description);
    if (!snapshot.content.trim()) throw new ValidationError("Memory content cannot be empty");
    const length = chars(snapshot.content);
    if (length > this.maxContentChars)
      throw new ValidationError(
        `Memory content is ${length} characters; the limit is ${this.maxContentChars}. ` +
          "Longer guidance belongs in a skill: make it a skill (skill_create) and keep at most a short memory pointing to it.",
      );
    validatePriority(snapshot.priority);
  }

  private find(projectId: string, name: string): Memory | null {
    return this.sqlite
      .query<Memory, [string, string]>("SELECT * FROM memories WHERE project_id=? AND name=?")
      .get(projectId, name);
  }

  private write(
    projectId: string,
    name: string,
    before: Memory | null,
    next: MemorySnapshot | null,
    action: MemoryChangeAction,
    writer: MemoryWriter,
  ): void {
    const author = writer.author || "agent";
    const sessionId = writer.session_id ?? null;
    if (next && before) {
      this.sqlite
        .query(
          "UPDATE memories SET description=?,content=?,priority=?,author=?,session_id=?,updated_at=unixepoch() WHERE project_id=? AND name=?",
        )
        .run(next.description, next.content, next.priority, author, sessionId, projectId, name);
    } else if (next) {
      this.sqlite
        .query(
          "INSERT INTO memories(project_id,name,description,content,priority,author,session_id) VALUES(?,?,?,?,?,?,?)",
        )
        .run(projectId, name, next.description, next.content, next.priority, author, sessionId);
    } else {
      this.sqlite.query("DELETE FROM memories WHERE project_id=? AND name=?").run(projectId, name);
    }
    const id = ulid();
    this.sqlite
      .query(
        "INSERT INTO memory_changes(id,project_id,memory_name,action,previous,current,reason,author,session_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,unixepoch())",
      )
      .run(
        id,
        projectId,
        name,
        action,
        before ? JSON.stringify(snapshotOf(before)) : null,
        next ? JSON.stringify(next) : null,
        writer.reason ?? null,
        author,
        sessionId,
      );
    new AuditLog(this.sqlite).record({
      action,
      project_id: projectId,
      actor: author,
      session_id: sessionId,
      subject_ids: [name],
      result_ids: [id],
      note: writer.reason ?? null,
    });
  }
}
