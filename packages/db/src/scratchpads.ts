import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import {
  emptyScratchpadContent,
  type Scratchpad,
  type ScratchpadCreate,
  type ScratchpadListItem,
  type ScratchpadListQuery,
  type ScratchpadUpdate,
  validateScratchpadContent,
} from "@orc/core/scratchpad";
import { normalizeTags } from "@orc/core/tags";

type Row = Omit<Scratchpad, "tags"> & { tags: string | null };
type Revisions = { revision: number; content_revision: number };
type ListRow = Omit<ScratchpadListItem, "tags"> & { tags: string | null };

// session_id is the agent's native session id, like memories.session_id: pads come from several
// session sources (live, archived, plain agent CLI), so there is no single table to reference.
export function installScratchpads(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS scratchpads (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT,
      tags TEXT,
      author TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      content_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS scratchpads_project_idx ON scratchpads(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS scratchpads_session_idx ON scratchpads(session_id);
  `);
}

function parse<T extends { tags: string | null }>(row: T): Omit<T, "tags"> & { tags: string[] } {
  return { ...row, tags: row.tags ? (JSON.parse(row.tags) as string[]) : [] };
}

function tagsColumn(tags: string[] | undefined): string | null {
  const normalized = normalizeTags(tags ?? []);
  return normalized.length ? JSON.stringify(normalized) : null;
}

export class ScratchpadStore {
  constructor(private readonly sqlite: Database) {}

  /** Most recently updated first; list items omit content. */
  list(query: ScratchpadListQuery = {}): ScratchpadListItem[] {
    const where: string[] = [];
    const params: string[] = [];
    if (query.kind) {
      where.push("kind=?");
      params.push(query.kind);
    }
    if (query.project_id === null) where.push("project_id IS NULL");
    else if (query.project_id) {
      where.push("project_id=?");
      params.push(query.project_id);
    }
    if (query.session_id) {
      where.push("session_id=?");
      params.push(query.session_id);
    }
    if (query.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(scratchpads.tags) WHERE value=?)");
      params.push(normalizeTags([query.tag])[0] ?? query.tag);
    }
    if (query.q?.trim()) {
      const like = `%${query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    return this.sqlite
      .query<ListRow, string[]>(
        `SELECT id,kind,title,project_id,session_id,tags,author,revision,created_at,updated_at,
           length(CAST(content AS BLOB)) AS size_bytes
         FROM scratchpads ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(...params)
      .map(parse);
  }

  get(id: string): Scratchpad {
    const row = this.sqlite
      .query<Row, [string]>(
        `SELECT id,kind,title,content,project_id,session_id,tags,author,revision,created_at,updated_at
         FROM scratchpads WHERE id=?`,
      )
      .get(id);
    if (!row) throw new NotFoundError("Scratchpad", id);
    return parse(row);
  }

  create(input: ScratchpadCreate): Scratchpad {
    const content = input.content ?? emptyScratchpadContent(input.kind);
    validateScratchpadContent(input.kind, content);
    const id = ulid();
    this.sqlite
      .transaction(() => {
        if (input.project_id) this.requireProject(input.project_id);
        this.sqlite
          .query(
            "INSERT INTO scratchpads(id,kind,title,content,project_id,session_id,tags,author) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            input.kind,
            input.title.trim(),
            content,
            input.project_id ?? null,
            input.session_id ?? null,
            tagsColumn(input.tags),
            input.author ?? "human",
          );
      })
      .immediate();
    return this.get(id);
  }

  /**
   * The pad, or a 409 when its file has changed since `ifRevision`. Title, tag and project edits
   * leave the file alone, so a revision from before them still holds for the file.
   */
  at(id: string, ifRevision?: number): Scratchpad {
    return this.check(id, ifRevision, "file");
  }

  /**
   * Every write bumps the revision; `if_revision` turns a stale write into a 409. A write of the
   * file alone conflicts only with another file change, so a concurrent rename does not refuse it.
   */
  update(id: string, input: ScratchpadUpdate): Scratchpad {
    const fileOnly =
      input.title === undefined &&
      input.project_id === undefined &&
      input.session_id === undefined &&
      input.tags === undefined;
    this.sqlite
      .transaction(() => {
        const before = this.check(id, input.if_revision, fileOnly ? "file" : "pad");
        if (input.content !== undefined) validateScratchpadContent(before.kind, input.content);
        if (input.project_id) this.requireProject(input.project_id);
        const fileChanged = input.content !== undefined && input.content !== before.content;
        this.sqlite
          .query(
            `UPDATE scratchpads SET title=?,content=?,project_id=?,session_id=?,tags=?,author=?,
               revision=revision+1,
               content_revision=CASE WHEN ? THEN revision+1 ELSE content_revision END,
               updated_at=unixepoch() WHERE id=?`,
          )
          .run(
            input.title?.trim() ?? before.title,
            input.content ?? before.content,
            input.project_id === undefined ? before.project_id : input.project_id,
            input.session_id === undefined ? before.session_id : input.session_id,
            input.tags === undefined ? tagsColumn(before.tags) : tagsColumn(input.tags),
            input.author ?? "human",
            fileChanged ? 1 : 0,
            id,
          );
      })
      .immediate();
    return this.get(id);
  }

  remove(id: string): void {
    const { changes } = this.sqlite.query("DELETE FROM scratchpads WHERE id=?").run(id);
    if (!changes) throw new NotFoundError("Scratchpad", id);
  }

  private check(id: string, ifRevision: number | undefined, scope: "file" | "pad"): Scratchpad {
    const pad = this.get(id);
    if (ifRevision === undefined) return pad;
    const revisions = this.sqlite
      .query<Revisions, [string]>("SELECT revision,content_revision FROM scratchpads WHERE id=?")
      .get(id) as Revisions;
    const since = scope === "file" ? revisions.content_revision : revisions.revision;
    if (ifRevision < since || ifRevision > revisions.revision)
      throw new ConflictError(
        `Scratchpad changed: revision ${pad.revision} by ${pad.author}, expected ${ifRevision}`,
      );
    return pad;
  }

  private requireProject(projectId: string): void {
    if (!this.sqlite.query("SELECT 1 FROM projects WHERE id=?").get(projectId))
      throw new NotFoundError("Project", projectId);
  }
}
