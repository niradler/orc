import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { changes } from "@orc/core/changes";
import { loadConfig, type OrcConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import type {
  ArchiveSearch,
  ArchiveSearchResult,
  ArchiveSession,
  ArchiveUpload,
} from "@orc/core/session-archive";
import { ArchiveUploadSchema } from "@orc/core/session-archive";
import { getSqlite } from "@orc/db/client";
import { splitPassageText } from "@orc/knowledge/chunker";
import { embedPendingBatch } from "@orc/knowledge/embedding-batch";
import { createEmbeddingProvider, type EmbeddingProvider } from "@orc/knowledge/embeddings";
import { IndexDb } from "@orc/knowledge/index-db";
import { parseTranscriptContent, type TranscriptTurn } from "./transcript.js";

type Row = Omit<ArchiveSession, "metadata"> & { metadata: string };
type Revision = {
  chunk_version: number;
  revision: number;
  content_hash: string;
  file_hashes: string;
  blob: string;
  conflict: number;
  created_at: string;
};
type FileHashes = Record<string, string[]>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const dto = (row: Row): ArchiveSession => ({ ...row, metadata: JSON.parse(row.metadata) });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function fingerprints(upload: ArchiveUpload): FileHashes {
  const files: FileHashes = {};
  for (const file of upload.bundle.files) {
    if (
      files[file.path] ||
      (file.path !== "session.jsonl" &&
        !(upload.agent === "claude" && /^subagents\/agent-[A-Za-z0-9_-]+\.jsonl$/.test(file.path)))
    )
      throw new ValidationError("Unsupported or duplicate session file path");
    const rows: Record<string, unknown>[] = [];
    for (const line of file.content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new ValidationError("Invalid session JSONL; upload complete records only");
      }
      if (!object(value)) throw new ValidationError("Session records must be objects");
      rows.push(value);
    }
    if (!rows.length) throw new ValidationError("Session file is empty");
    if (file.path === "session.jsonl") {
      if (upload.agent === "codex") {
        if (
          rows[0]?.type !== "session_meta" ||
          !object(rows[0].payload) ||
          rows[0].payload.id !== upload.session_id ||
          rows.filter((r) => r.type === "session_meta").length !== 1
        )
          throw new ValidationError("Codex session identity does not match");
      } else if (
        !rows.some(
          (r) =>
            r.sessionId === upload.session_id && ["user", "assistant"].includes(String(r.type)),
        ) ||
        rows.some((r) => typeof r.sessionId === "string" && r.sessionId !== upload.session_id)
      )
        throw new ValidationError("Claude session identity does not match");
    }
    files[file.path] = rows.map((row) => hash(canonical(row)));
  }
  if (!files["session.jsonl"]) throw new ValidationError("session.jsonl is required");
  return files;
}

function prefix(a: FileHashes, b: FileHashes): boolean {
  return Object.entries(a).every(([path, rows]) => rows.every((h, i) => b[path]?.[i] === h));
}

function turnText(turn: TranscriptTurn): string {
  return turn.blocks
    .map((b) => (b.type === "tool_use" ? `${b.name}\n${b.input}\n${b.result ?? ""}` : b.text))
    .join("\n");
}

async function chunksOf(upload: ArchiveUpload, key: string, version: number) {
  if (version !== 1 && version !== 2) throw new Error("Unsupported passage chunking version");
  const chunks: { ordinal: number; heading_path: string[]; locator: null; text: string }[] = [];
  for (const file of [...upload.bundle.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const turns = await parseTranscriptContent(
      file.content,
      upload.agent,
      `${key}:${file.path}`,
      hash(file.content),
    );
    for (const turn of turns) {
      const text = turnText(turn);
      const passages =
        version === 1
          ? Array.from({ length: Math.ceil(text.length / 1600) }, (_, i) =>
              text.slice(i * 1600, (i + 1) * 1600),
            )
          : splitPassageText(text);
      for (const passage of passages)
        chunks.push({
          ordinal: chunks.length,
          heading_path: [`turn:${turn.index}`, turn.role, file.path],
          locator: null,
          text: passage,
        });
    }
  }
  return chunks;
}

export class SessionArchive {
  private job: Promise<void> | null = null;
  private embeddingJob: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  private constructor(
    readonly db: Database,
    readonly root: string,
    readonly index: IndexDb,
    private readonly config: () => OrcConfig,
    private readonly override?: () => EmbeddingProvider | null,
  ) {}

  static async open(options: {
    db: Database;
    root: string;
    config?: () => OrcConfig;
    embedder?: () => EmbeddingProvider | null;
  }) {
    mkdirSync(join(options.root, "blobs"), { recursive: true, mode: 0o700 });
    const index = await IndexDb.open(join(options.root, "index.db"));
    const service = new SessionArchive(
      options.db,
      options.root,
      index,
      options.config ?? loadConfig,
      options.embedder,
    );
    const indexed = index.documentChunkCounts();
    for (const row of service.db.query<Row, []>("SELECT * FROM session_archives").all())
      if (!indexed.has(row.id))
        service.db.run("UPDATE session_archives SET index_revision = 0 WHERE id = ?", [row.id]);
    service.timer = setInterval(() => service.kick(), 30_000);
    service.timer.unref();
    service.kick();
    return service;
  }

  private provider() {
    if (!this.config().knowledge.session_embeddings) return null;
    return this.override
      ? this.override()
      : createEmbeddingProvider(this.config().knowledge.embedding);
  }

  get(id: string): ArchiveSession {
    const row = this.db.query<Row, [string]>("SELECT * FROM session_archives WHERE id = ?").get(id);
    if (!row) throw new NotFoundError("Archived session", id);
    return dto(row);
  }

  private revision(id: string, revision?: number): Revision {
    const row = this.get(id);
    const found = this.db
      .query<Revision, [string, number]>(
        "SELECT * FROM session_archive_revisions WHERE session_id = ? AND revision = ?",
      )
      .get(id, revision ?? row.revision);
    if (!found) throw new NotFoundError("Session revision", String(revision));
    return found;
  }

  bundle(id: string, revision?: number): ArchiveUpload {
    const row = this.revision(id, revision);
    return ArchiveUploadSchema.parse(
      JSON.parse(readFileSync(join(this.root, "blobs", row.blob), "utf8")),
    );
  }

  history(id: string) {
    this.get(id);
    return this.db
      .query<Omit<Revision, "blob" | "file_hashes" | "chunk_version">, [string]>(
        "SELECT revision, content_hash, conflict, created_at FROM session_archive_revisions WHERE session_id = ? ORDER BY revision DESC",
      )
      .all(id);
  }

  async ingest(raw: ArchiveUpload) {
    const upload = ArchiveUploadSchema.parse(raw);
    const project = this.db
      .query<{ id: string }, [string]>("SELECT id FROM projects WHERE lower(name) = lower(?)")
      .get(upload.project);
    if (!project) throw new NotFoundError("Project", upload.project);
    const files = fingerprints(upload);
    const digest = hash(canonical(files));
    const encoded = JSON.stringify(upload);
    const blob = `${hash(encoded)}.json`;
    const result = this.db.transaction(() => {
      const old = this.db
        .query<Row, [string, string, string]>(
          "SELECT * FROM session_archives WHERE source_id = ? AND agent = ? AND native_id = ?",
        )
        .get(upload.source_id, upload.agent, upload.session_id);
      if (old && old.project_id !== project.id)
        throw new ConflictError("This origin is already assigned to another project");
      if (old?.content_hash === digest) {
        if (upload.reindex)
          this.db.run(
            "UPDATE session_archives SET index_revision = 0, embedding_error = NULL WHERE id = ?",
            [old.id],
          );
        return { session: this.get(old.id), outcome: "unchanged" as const };
      }
      const previous: FileHashes | null = old
        ? JSON.parse(this.revision(old.id).file_hashes)
        : null;
      if (old && previous && prefix(files, previous))
        return { session: dto(old), outcome: "stale" as const };
      const conflict =
        !!old &&
        ((!!previous && !prefix(previous, files)) ||
          (upload.expected_revision !== undefined && upload.expected_revision !== old.revision));
      const now = new Date().toISOString();
      let id = old?.id ?? ulid();
      while (!old && this.db.query("SELECT 1 FROM session_archives WHERE id = ?").get(id))
        id = ulid();
      const max =
        this.db
          .query<{ n: number }, [string]>(
            "SELECT coalesce(max(revision), 0) n FROM session_archive_revisions WHERE session_id = ?",
          )
          .get(id)?.n ?? 0;
      const revision = max + 1;
      if (!old)
        this.db.run(
          "INSERT INTO session_archives (id, project_id, source_id, agent, native_id, title, metadata, revision, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?)",
          [
            id,
            project.id,
            upload.source_id,
            upload.agent,
            upload.session_id,
            upload.title,
            JSON.stringify(upload.metadata),
            upload.metadata.started_at ?? now,
            upload.metadata.ended_at ?? now,
          ],
        );
      const duplicateConflict = conflict
        ? this.db
            .query<{ revision: number }, [string, string]>(
              "SELECT revision FROM session_archive_revisions WHERE session_id = ? AND content_hash = ? AND conflict = 1",
            )
            .get(id, digest)
        : null;
      if (!duplicateConflict) {
        try {
          writeFileSync(join(this.root, "blobs", blob), encoded, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        this.db.run(
          "INSERT INTO session_archive_revisions (session_id, revision, content_hash, file_hashes, blob, conflict, created_at, chunk_version) VALUES (?, ?, ?, ?, ?, ?, ?, 2)",
          [id, revision, digest, JSON.stringify(files), blob, conflict ? 1 : 0, now],
        );
      }
      if (conflict)
        return {
          session: this.get(id),
          outcome: "conflict" as const,
          conflict_revision: duplicateConflict?.revision ?? revision,
        };
      this.db.run(
        "UPDATE session_archives SET revision = ?, content_hash = ?, title = ?, metadata = ?, updated_at = ?, embedding_error = NULL WHERE id = ?",
        [
          revision,
          digest,
          upload.title,
          JSON.stringify(upload.metadata),
          upload.metadata.ended_at ?? now,
          id,
        ],
      );
      return { session: this.get(id), outcome: old ? ("updated" as const) : ("created" as const) };
    })();
    this.kick();
    changes.publish("sessions");
    return result;
  }

  kick() {
    if (this.stopped) return;
    if (!this.job)
      this.job = this.process()
        .catch(() => {})
        .finally(() => {
          this.job = null;
          this.kickEmbeddings();
          if (
            !this.stopped &&
            this.db
              .query(
                "SELECT 1 FROM session_archives WHERE revision != index_revision AND (embedding_error IS NULL OR embedding_error NOT LIKE 'Session indexing failed%') LIMIT 1",
              )
              .get()
          )
            this.kick();
        });
    this.kickEmbeddings();
  }

  private kickEmbeddings() {
    if (this.embeddingJob || this.stopped || !this.provider()) return;
    this.embeddingJob = this.embedPending()
      .catch(() => {})
      .finally(() => {
        this.embeddingJob = null;
      });
  }

  async idle() {
    await this.job;
    this.kick();
    await this.job;
    this.kickEmbeddings();
    await this.embeddingJob;
  }

  private async process() {
    const pending = this.db
      .query<Row, []>(
        "SELECT * FROM session_archives WHERE revision != index_revision AND (embedding_error IS NULL OR embedding_error NOT LIKE 'Session indexing failed%') ORDER BY updated_at LIMIT 50",
      )
      .all();
    for (const row of pending) {
      if (this.stopped) return;
      try {
        const chunks = await chunksOf(
          this.bundle(row.id, row.revision),
          `${row.id}@${row.revision}`,
          this.revision(row.id, row.revision).chunk_version,
        );
        if (this.get(row.id).revision !== row.revision) continue;
        this.index.replaceDocument({
          document_id: row.id,
          kb_id: row.project_id ?? "unassigned",
          revision: row.revision,
          title: row.title,
          labels: [row.agent],
          media_type: "application/x-orc-session",
          chunks,
        });
        this.db.run(
          "UPDATE session_archives SET index_revision = ?, embedding_error = NULL WHERE id = ? AND revision = ?",
          [row.revision, row.id, row.revision],
        );
      } catch {
        this.db.run("UPDATE session_archives SET embedding_error = ? WHERE id = ?", [
          "Session indexing failed; retry indexing after checking the transcript",
          row.id,
        ]);
      }
    }
  }

  private async embedPending() {
    const provider = this.provider();
    if (!provider || this.stopped) return;
    for (let batch = 0; batch < 16 && !this.stopped; batch++) {
      if (this.provider()?.profile !== provider.profile) return;
      try {
        if (!(await embedPendingBatch(this.index, provider))) return;
        this.db.run(
          "UPDATE session_archives SET embedding_error = NULL WHERE embedding_error LIKE 'Embedding provider unavailable%'",
        );
      } catch {
        this.db.run(
          "UPDATE session_archives SET embedding_error = ? WHERE revision = index_revision AND (embedding_error IS NULL OR embedding_error LIKE 'Embedding provider unavailable%')",
          ["Embedding provider unavailable; keyword search remains available"],
        );
        return;
      }
    }
  }

  async search(req: ArchiveSearch): Promise<ArchiveSearchResult> {
    this.kick();
    const projectFilter =
      req.project_id === "unassigned"
        ? "AND project_id IS NULL"
        : req.project_id
          ? "AND project_id = ?"
          : "";
    const args = req.project_id && req.project_id !== "unassigned" ? [req.project_id] : [];
    if (!req.q) {
      const provider = this.provider();
      const rows = this.db
        .query<Row, (string | number)[]>(
          `SELECT * FROM session_archives WHERE 1=1 ${projectFilter} ${req.agent ? "AND agent = ?" : ""} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
        )
        .all(...args, ...(req.agent ? [req.agent] : []), req.limit + 1, req.offset);
      return {
        sessions: rows.slice(0, req.limit).map((row) => ({ ...dto(row), score: 0, passages: [] })),
        mode: "lexical",
        pending_chunks: provider ? this.index.pendingEmbeddingCount(provider.profile) : 0,
        offset: req.offset,
        has_more: rows.length > req.limit,
      };
    }
    const scope = this.db
      .query<{ project_id: string | null }, string[]>(
        `SELECT DISTINCT project_id FROM session_archives WHERE 1=1 ${projectFilter}`,
      )
      .all(...args)
      .map((r) => r.project_id ?? "unassigned");
    const filter = { kb_ids: scope, ...(req.agent ? { labels: [req.agent] } : {}) };
    let degraded: string | undefined;
    let mode: ArchiveSearchResult["mode"] = "lexical";
    const scores = new Map<number, number>();
    const add = (ids: number[]) =>
      ids.forEach((id, i) => {
        scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i));
      });
    const count = Math.max(100, (req.offset + req.limit + 1) * 3);
    const provider = this.provider();
    let lexicalAdded = false;
    const addLexical = () => {
      if (!lexicalAdded) {
        add(this.index.lexical(req.q, filter, count, 3).map((r) => r.id));
        lexicalAdded = true;
      }
    };
    if (req.q && (req.mode !== "semantic" || !provider)) addLexical();
    let pending = provider ? this.index.pendingEmbeddingCount(provider.profile) : 0;
    if (req.q && req.mode !== "lexical" && provider) {
      if (pending) {
        degraded = "Session embeddings are still indexing; keyword matches are included";
        addLexical();
      }
      try {
        const [vector] = await provider.embed([req.q], "query");
        if (!vector?.length || vector.some((v) => !Number.isFinite(v)))
          throw new Error("Invalid vector");
        const dimensions = this.index.vectorDimensions(provider.profile);
        if (dimensions && dimensions !== vector.length)
          throw new Error("Embedding dimensions changed");
        add(this.index.semantic(vector, provider.profile, filter, count, 3).map((r) => r.id));
        mode = req.mode === "semantic" && !pending ? "semantic" : "hybrid";
      } catch {
        degraded = "Embedding search unavailable; showing keyword results";
        addLexical();
      }
    } else if (
      req.q &&
      req.mode !== "lexical" &&
      this.config().knowledge.session_embeddings &&
      !provider
    )
      degraded = "Connect an embedding provider; showing keyword results";
    const grouped = new Map<
      string,
      { score: number; passages: ArchiveSearchResult["sessions"][number]["passages"] }
    >();
    for (const c of this.index
      .getChunks([...scores.keys()])
      .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))) {
      const row = this.get(c.document_id);
      if (row.revision !== c.revision) continue;
      const hit = grouped.get(row.id) ?? { score: scores.get(c.id) ?? 0, passages: [] };
      if (hit.passages.length < 3)
        hit.passages.push({
          citation: `session:${row.id}@${row.revision}#${c.ordinal}`,
          ordinal: c.ordinal,
          text: c.text,
          snippet: c.text.slice(0, 240),
          turn: Number(c.heading_path[0]?.split(":")[1] ?? 0),
          file: c.heading_path[2] ?? "session.jsonl",
        });
      grouped.set(row.id, hit);
    }
    const titleSql = req.q
      ? "AND (title LIKE ? ESCAPE '\\' OR json_extract(metadata, '$.cwd') LIKE ? ESCAPE '\\')"
      : "";
    const needle = `%${req.q.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.db
      .query<Row, (string | number)[]>(
        `SELECT * FROM session_archives WHERE 1=1 ${projectFilter} ${req.agent ? "AND agent = ?" : ""} ${titleSql} ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(...args, ...(req.agent ? [req.agent] : []), ...(req.q ? [needle, needle] : []), count);
    for (const row of rows)
      if (!grouped.has(row.id)) grouped.set(row.id, { score: req.q ? 0.02 : 0, passages: [] });
    const ordered = [...grouped.entries()]
      .map(([id, hit]) => ({ ...this.get(id), ...hit }))
      .sort(
        (a, b) =>
          b.score - a.score || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id),
      );
    pending = provider ? this.index.pendingEmbeddingCount(provider.profile) : 0;
    return {
      sessions: ordered.slice(req.offset, req.offset + req.limit),
      mode,
      ...(degraded ? { degraded } : {}),
      pending_chunks: pending,
      offset: req.offset,
      has_more: ordered.length > req.offset + req.limit,
    };
  }

  async citation(id: string, revision: number, ordinal: number) {
    const chunk = (
      await chunksOf(
        this.bundle(id, revision),
        `${id}@${revision}`,
        this.revision(id, revision).chunk_version,
      )
    )[ordinal];
    if (!chunk) throw new NotFoundError("Session passage", String(ordinal));
    return {
      citation: `session:${id}@${revision}#${ordinal}`,
      text: chunk.text,
      turn: Number(chunk.heading_path[0]?.split(":")[1] ?? 0),
      file: chunk.heading_path[2] ?? "session.jsonl",
    };
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.all([this.job, this.embeddingJob]);
    this.index.close();
  }
}

let instance: { db: Database; service: Promise<SessionArchive> } | undefined;
export function getSessionArchive(): Promise<SessionArchive> {
  const db = getSqlite();
  if (!instance || instance.db !== db) {
    const previous = instance;
    if (previous) void previous.service.then((service) => service.close()).catch(() => {});
    const config = loadConfig();
    const root = join(
      config.knowledge.root || join(dirname(config.db.path.replace(/^~/, homedir())), "knowledge"),
      "sessions",
    );
    instance = { db, service: SessionArchive.open({ db, root }) };
    const current = instance;
    void current.service.catch(() => {
      if (instance === current) instance = undefined;
    });
  }
  return instance.service;
}

export async function closeSessionArchive() {
  const old = instance;
  instance = undefined;
  if (old) await (await old.service).close();
}
