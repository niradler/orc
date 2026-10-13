import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError } from "@orc/core/errors";
import { normalizeTags } from "@orc/core/tags";
import type {
  WikiChange,
  WikiIndexEntry,
  WikiPage,
  WikiPageKind,
  WikiRevision,
  WikiSearchHit,
  WikiWrite,
} from "@orc/core/wiki";
import { WikiWriteSchema } from "@orc/core/wiki";
import { AuditLog } from "./audit.js";

export function installWiki(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      project_key TEXT NOT NULL,
      project_id TEXT,
      slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      revision INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      sources TEXT NOT NULL DEFAULT '[]',
      author TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_key, slug)
    );

    CREATE TABLE IF NOT EXISTS wiki_revisions (
      project_key TEXT NOT NULL,
      project_id TEXT,
      slug TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      sources TEXT NOT NULL DEFAULT '[]',
      author TEXT NOT NULL,
      note TEXT NOT NULL,
      session_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_key, slug, revision)
    );
    CREATE INDEX IF NOT EXISTS wiki_revisions_recent_idx ON wiki_revisions(project_key, updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
      project_key UNINDEXED,
      slug UNINDEXED,
      title,
      summary,
      content,
      tags,
      tokenize='porter ascii'
    );

    CREATE TRIGGER IF NOT EXISTS wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
      INSERT INTO wiki_fts(project_key, slug, title, summary, content, tags)
        VALUES (new.project_key, new.slug, new.title, new.summary, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
      DELETE FROM wiki_fts WHERE project_key = old.project_key AND slug = old.slug;
    END;

    CREATE TRIGGER IF NOT EXISTS wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
      DELETE FROM wiki_fts WHERE project_key = old.project_key AND slug = old.slug;
      INSERT INTO wiki_fts(project_key, slug, title, summary, content, tags)
        VALUES (new.project_key, new.slug, new.title, new.summary, new.content, new.tags);
    END;
  `);
}

export type WikiSearchOptions = {
  projectId: string | null;
  limit?: number;
};

type PageRow = {
  project_id: string | null;
  slug: string;
  kind: string;
  revision: number;
  title: string;
  summary: string;
  content: string;
  tags: string;
  sources: string;
  author: string;
  updated_at: number;
};

type RevisionRow = PageRow & { note: string; session_id: string | null };

type SearchRow = PageRow & { snippet: string; rank: number };

const DEFAULT_AUTHOR = "unknown";
const MAX_QUERY_TERMS = 32;

function projectKey(projectId: string | null): string {
  if (projectId === null) return "global:";
  return `project:${projectId}`;
}

// A project sees its own pages plus global ones; global sees only global.
function visibleKeys(projectId: string | null): string[] {
  if (projectId === null) return [projectKey(null)];
  return [projectKey(projectId), projectKey(null)];
}

// A project page hides the global page with the same slug. `alias` is the wiki_pages alias.
function visibleFilter(alias: string, projectId: string | null): { sql: string; params: string[] } {
  const keys = visibleKeys(projectId);
  const inKeys = `${alias}.project_key IN (${keys.map(() => "?").join(",")})`;
  if (projectId === null) return { sql: inKeys, params: keys };
  return {
    sql: `${inKeys} AND NOT (${alias}.project_key = ? AND EXISTS (
      SELECT 1 FROM wiki_pages shadow WHERE shadow.project_key = ? AND shadow.slug = ${alias}.slug))`,
    params: [...keys, projectKey(null), projectKey(projectId)],
  };
}

function toPage(row: PageRow): WikiPage {
  return {
    slug: row.slug,
    project_id: row.project_id,
    kind: row.kind as WikiPageKind,
    revision: row.revision,
    title: row.title,
    summary: row.summary,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    sources: JSON.parse(row.sources) as string[],
    author: row.author,
    updated_at: row.updated_at,
  };
}

function toIndexEntry(page: WikiPage): WikiIndexEntry {
  return {
    slug: page.slug,
    project_id: page.project_id,
    kind: page.kind,
    title: page.title,
    summary: page.summary,
    revision: page.revision,
    tags: page.tags,
    updated_at: page.updated_at,
  };
}

function buildMatchExpression(query: string, mode: "AND" | "OR"): string {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(
    0,
    MAX_QUERY_TERMS,
  );
  return terms.map((term) => `"${term}"`).join(` ${mode} `);
}

export class WikiStore {
  constructor(private readonly sqlite: Database) {}

  write(input: WikiWrite): WikiRevision {
    const page = WikiWriteSchema.parse(input);
    if (
      page.project_id !== null &&
      !this.sqlite.query("SELECT id FROM projects WHERE id = ?").get(page.project_id)
    ) {
      throw new NotFoundError("Project", page.project_id);
    }
    const key = projectKey(page.project_id);
    const tags = normalizeTags(page.tags);
    const author = page.author ?? DEFAULT_AUTHOR;
    const sessionId = page.session_id ?? null;
    return this.sqlite.transaction((): WikiRevision => {
      const current = this.sqlite
        .query<{ revision: number }, [string, string]>(
          "SELECT revision FROM wiki_pages WHERE project_key = ? AND slug = ?",
        )
        .get(key, page.slug);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== page.expected_revision) {
        throw new ConflictError(
          `Wiki page "${page.slug}" is at revision ${currentRevision}, not ${page.expected_revision}. Reload it and retry.`,
        );
      }
      const revision = currentRevision + 1;
      const updatedAt = Math.floor(Date.now() / 1000);
      const values = [
        key,
        page.project_id,
        page.slug,
        page.kind,
        revision,
        page.title,
        page.summary,
        page.content,
        JSON.stringify(tags),
        JSON.stringify(page.sources),
        author,
        updatedAt,
      ] as const;
      this.sqlite
        .query(
          `INSERT INTO wiki_pages(project_key, project_id, slug, kind, revision, title, summary, content, tags, sources, author, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_key, slug) DO UPDATE SET
             kind = excluded.kind, revision = excluded.revision, title = excluded.title,
             summary = excluded.summary, content = excluded.content, tags = excluded.tags,
             sources = excluded.sources, author = excluded.author, updated_at = excluded.updated_at`,
        )
        .run(...values);
      this.sqlite
        .query(
          `INSERT INTO wiki_revisions(project_key, project_id, slug, kind, revision, title, summary, content, tags, sources, author, updated_at, note, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values, page.note, sessionId);
      new AuditLog(this.sqlite).record({
        action: revision === 1 ? "wiki.created" : "wiki.updated",
        subject_ids: [page.slug],
        project_id: page.project_id,
        actor: author,
        session_id: sessionId,
        note: page.note,
        snapshot: { revision },
      });
      return {
        slug: page.slug,
        project_id: page.project_id,
        kind: page.kind,
        revision,
        title: page.title,
        summary: page.summary,
        content: page.content,
        tags,
        sources: page.sources,
        author,
        updated_at: updatedAt,
        note: page.note,
        session_id: sessionId,
      };
    })();
  }

  // Resolves like list/search: the project page if it exists, otherwise the global one.
  get(projectId: string | null, slug: string): WikiPage {
    return toPage(this.resolve(projectId, slug));
  }

  list(projectId: string | null): WikiIndexEntry[] {
    const filter = visibleFilter("p", projectId);
    return this.sqlite
      .query<PageRow, string[]>(
        `SELECT * FROM wiki_pages p WHERE ${filter.sql} ORDER BY kind, slug`,
      )
      .all(...filter.params)
      .map((row) => toIndexEntry(toPage(row)));
  }

  history(projectId: string | null, slug: string): WikiRevision[] {
    const page = this.resolve(projectId, slug);
    return this.sqlite
      .query<RevisionRow, [string, string]>(
        "SELECT * FROM wiki_revisions WHERE project_key = ? AND slug = ? ORDER BY revision DESC",
      )
      .all(projectKey(page.project_id), slug)
      .map((row) => ({ ...toPage(row), note: row.note, session_id: row.session_id }));
  }

  private resolve(projectId: string | null, slug: string): PageRow {
    for (const key of visibleKeys(projectId)) {
      const row = this.sqlite
        .query<PageRow, [string, string]>(
          "SELECT * FROM wiki_pages WHERE project_key = ? AND slug = ?",
        )
        .get(key, slug);
      if (row) return row;
    }
    throw new NotFoundError("Wiki page", slug);
  }

  changes(projectId: string | null, limit = 20): WikiChange[] {
    const keys = visibleKeys(projectId);
    return this.sqlite
      .query<RevisionRow, (string | number)[]>(
        `SELECT * FROM wiki_revisions WHERE project_key IN (${keys.map(() => "?").join(",")})
         ORDER BY updated_at DESC, revision DESC LIMIT ?`,
      )
      .all(...keys, limit)
      .map((row) => ({
        slug: row.slug,
        project_id: row.project_id,
        title: row.title,
        kind: row.kind as WikiPageKind,
        revision: row.revision,
        note: row.note,
        author: row.author,
        session_id: row.session_id,
        updated_at: row.updated_at,
      }));
  }

  search(query: string, options: WikiSearchOptions): WikiSearchHit[] {
    const limit = options.limit ?? 10;
    const andRows = this.match(buildMatchExpression(query, "AND"), options.projectId, limit);
    const rows =
      andRows.length > 0
        ? andRows
        : this.match(buildMatchExpression(query, "OR"), options.projectId, limit);
    return rows.map((row) => ({
      ...toIndexEntry(toPage(row)),
      snippet: row.snippet,
      score: -row.rank,
    }));
  }

  private match(expression: string, projectId: string | null, limit: number): SearchRow[] {
    if (!expression) return [];
    const filter = visibleFilter("p", projectId);
    return this.sqlite
      .query<SearchRow, (string | number)[]>(
        `SELECT p.*, snippet(wiki_fts, 4, '[', ']', '…', 16) AS snippet,
                bm25(wiki_fts, 0, 0, 4.0, 2.0, 1.0, 1.5) AS rank
         FROM wiki_fts f
         JOIN wiki_pages p ON p.project_key = f.project_key AND p.slug = f.slug
         WHERE wiki_fts MATCH ? AND ${filter.sql}
         ORDER BY rank LIMIT ?`,
      )
      .all(expression, ...filter.params, limit);
  }
}
