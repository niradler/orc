import { extname } from "node:path";
import { ulid } from "@orc/core/ids";
import type { DocRow, JobKind, JobRow } from "./catalog.js";
import { chunkBlocks } from "./chunker.js";
import { documentText } from "./content.js";
import { embedPendingBatch } from "./embedding-batch.js";
import { EmbeddingError } from "./embeddings.js";
import type { Engine } from "./engine.js";
import { inputHash } from "./index-db.js";
import { setDocumentLinks } from "./links.js";
import { ParserUnavailableError, runParser, selectParser } from "./parsers/registry.js";
import { decodeVector } from "./vector.js";

const MAX_ATTEMPTS = 3;
/** Idle re-check so jobs queued by another process (e.g. a stdio MCP server) are picked up. */
const IDLE_POLL_MS = 10_000;
const SLOTS: Record<JobKind, number> = { parse: 2, index: 1, embed: 1 };

/** Terminal, non-retryable job failure (bad input, missing parser) - retrying cannot help. */
class PermanentJobError extends Error {}

const extOf = (doc: DocRow) =>
  extname(doc.original_name ?? doc.external_path ?? doc.path)
    .slice(1)
    .toLowerCase();

/**
 * Processes the kb_jobs outbox: parse (uploads/external binaries) -> index (chunks, FTS, links)
 * -> embed (vectors). Jobs are durable rows, so a crash or restart resumes where it stopped.
 */
export class JobRunner {
  private running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly e: Engine) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.recoverExpired();
    this.kick();
  }

  /**
   * Requeue jobs whose claim outlived the longest legitimate run: their process crashed or exited.
   * Several processes may share the outbox, so a fresh "running" row belongs to someone else.
   */
  recoverExpired() {
    const leaseMs = this.e.config().parser_timeout_secs * 1000 + 60_000;
    this.e.db
      .query(
        "UPDATE kb_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)",
      )
      .run(Date.now() - leaseMs);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled(this.running.values());
  }

  kick() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
  }

  /** Resolves once no job is running or runnable now (tests, CLI one-shot commands). */
  idle(): Promise<void> {
    if (!this.running.size && !this.nextRunnable(new Set()).length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private nextRunnable(busyKinds: Set<JobKind>): JobRow[] {
    const kinds = (["parse", "index", "embed"] as JobKind[]).filter((k) => !busyKinds.has(k));
    if (!kinds.length) return [];
    return this.e.db
      .query(
        `SELECT * FROM kb_jobs WHERE status = 'queued' AND run_after <= ? AND kind IN (${kinds.map(() => "?").join(",")})
         ORDER BY CASE kind WHEN 'index' THEN 0 WHEN 'parse' THEN 1 ELSE 2 END, created_at LIMIT 20`,
      )
      .all(Date.now(), ...kinds) as JobRow[];
  }

  private tick() {
    this.timer = null;
    if (this.stopped) return;
    const counts: Record<JobKind, number> = { parse: 0, index: 0, embed: 0 };
    for (const id of this.running.keys()) {
      const kind = id.split(":")[0] as JobKind;
      counts[kind]++;
    }
    const slots = { ...SLOTS, parse: this.e.config().parser_concurrency };
    const busy = new Set((Object.keys(counts) as JobKind[]).filter((k) => counts[k] >= slots[k]));
    for (const job of this.nextRunnable(busy)) {
      if (counts[job.kind] >= slots[job.kind]) continue;
      const claimed = this.e.db
        .query(
          "UPDATE kb_jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(Date.now(), Date.now(), job.id);
      if (!claimed.changes) continue;
      counts[job.kind]++;
      const key = `${job.kind}:${job.id}`;
      const p = this.execute({ ...job, attempts: job.attempts + 1 }).finally(() => {
        this.running.delete(key);
        this.kick();
      });
      this.running.set(key, p);
    }
    if (!this.running.size) {
      const next = this.e.db
        .query("SELECT min(run_after) t FROM kb_jobs WHERE status = 'queued'")
        .get() as { t: number | null };
      if (next.t === null || next.t > Date.now()) {
        for (const w of this.idleWaiters.splice(0)) w();
      }
      const delay =
        next.t === null ? IDLE_POLL_MS : Math.max(50, Math.min(IDLE_POLL_MS, next.t - Date.now()));
      this.timer = setTimeout(() => this.tick(), delay);
      this.timer.unref?.();
    }
  }

  private finish(job: JobRow, status: JobRow["status"], error: string | null = null) {
    this.e.db
      .query(
        "UPDATE kb_jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, error, Date.now(), Date.now(), job.id);
  }

  private async execute(job: JobRow) {
    const doc = this.e.catalog.doc(job.document_id);
    // Superseded: the document was deleted or has a newer revision with its own jobs.
    if (!doc || doc.revision !== job.revision) return this.finish(job, "superseded");
    try {
      if (job.kind === "parse") await this.parse(doc);
      else if (job.kind === "index") this.index(doc);
      else await this.embed(doc);
      this.finish(job, "done");
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const retryable =
        !(err instanceof PermanentJobError) &&
        !(err instanceof ParserUnavailableError) &&
        !(err instanceof EmbeddingError && !err.retryable);
      if (retryable && job.attempts < MAX_ATTEMPTS) {
        this.e.db
          .query(
            "UPDATE kb_jobs SET status = 'queued', error = ?, run_after = ?, updated_at = ? WHERE id = ?",
          )
          .run(message, Date.now() + 5000 * 2 ** (job.attempts - 1), Date.now(), job.id);
        return;
      }
      this.finish(job, "failed", message);
      this.markFailed(job, doc, message);
    }
  }

  private markFailed(job: JobRow, doc: DocRow, message: string) {
    const warnings = JSON.stringify(
      [...(JSON.parse(doc.warnings) as string[]), message].slice(-10),
    );
    if (job.kind === "parse")
      this.e.db.run(
        "UPDATE kb_documents SET parse_state = 'failed', index_state = 'failed', warnings = ? WHERE id = ? AND revision = ?",
        [warnings, doc.id, doc.revision],
      );
    else if (job.kind === "index")
      this.e.db.run(
        "UPDATE kb_documents SET index_state = 'failed', warnings = ? WHERE id = ? AND revision = ?",
        [warnings, doc.id, doc.revision],
      );
    // Embed failures leave the document lexically searchable; status reports the failed job.
  }

  private async parse(doc: DocRow) {
    const kb = this.e.catalog.kb(doc.kb_id);
    if (!kb) throw new PermanentJobError("Knowledge base no longer exists");
    const ext = extOf(doc);
    const parser = selectParser(ext, kb.parser, this.e.storage.root, this.e.config());
    // Uploads and folder copies both parse their stored original, never the folder file.
    const rev = this.e.catalog.revision(doc.id, doc.revision);
    if (!rev?.original_rel) throw new PermanentJobError("Original file is missing");
    const input = this.e.storage.resolveRel(rev.original_rel);
    const parsed = await runParser(parser, input, ext, doc.content_hash, {
      root: this.e.storage.root,
      workDir: this.e.storage.workDir(),
      timeoutSecs: this.e.config().parser_timeout_secs,
    });
    if (parsed.status !== "failed") this.e.storage.putArtifact(doc.id, parsed);
    const res = this.e.db
      .query(
        `UPDATE kb_documents SET parse_state = ?, parser_id = ?, parser_version = ?, parser_options_hash = ?,
           warnings = ?, index_state = ? WHERE id = ? AND revision = ?`,
      )
      .run(
        parsed.status,
        parsed.parser.id,
        parsed.parser.version,
        Bun.hash(JSON.stringify(parsed.parser.options)).toString(16),
        JSON.stringify(parsed.warnings.slice(0, 20)),
        parsed.status === "failed" ? "failed" : "pending",
        doc.id,
        doc.revision,
      );
    if (res.changes && parsed.status !== "failed")
      this.e.catalog.enqueue(doc.kb_id, doc.id, doc.revision, "index", ulid());
  }

  private index(doc: DocRow) {
    const text = documentText(this.e, doc);
    if (!text && doc.origin !== "authored" && doc.parser_id) {
      // Parse artifacts are a cache keyed by source hash (lost with a backup that kept only
      // orc.db and originals): parse the source again, which queues this index once more.
      this.e.db.run(
        "UPDATE kb_documents SET parse_state = 'pending', index_state = 'pending' WHERE id = ? AND revision = ?",
        [doc.id, doc.revision],
      );
      this.e.catalog.enqueue(doc.kb_id, doc.id, doc.revision, "parse", ulid());
      return;
    }
    if (!text) throw new PermanentJobError("Document content is unavailable");
    const chunks = chunkBlocks(
      text.blocks,
      this.e.catalog.revision(doc.id, doc.revision)?.chunk_version ?? 1,
    );
    this.e.idx.replaceDocument({
      document_id: doc.id,
      kb_id: doc.kb_id,
      revision: doc.revision,
      title: doc.title,
      labels: JSON.parse(doc.labels) as string[],
      media_type: doc.media_type,
      chunks,
    });
    setDocumentLinks(this.e.db, doc, doc.media_type === "text/markdown" ? text.markdown : null);
    const embedder = this.e.embedder();
    const state = embedder && chunks.length ? "semantic_pending" : "lexical_ready";
    this.e.db.run("UPDATE kb_documents SET index_state = ? WHERE id = ? AND revision = ?", [
      state,
      doc.id,
      doc.revision,
    ]);
    if (state === "semantic_pending")
      this.e.catalog.enqueue(doc.kb_id, doc.id, doc.revision, "embed", ulid());
  }

  private async embed(doc: DocRow) {
    for (;;) {
      if (this.e.catalog.doc(doc.id)?.revision !== doc.revision) return;
      const embedder = this.e.embedder();
      if (!embedder) {
        this.e.db.run(
          "UPDATE kb_documents SET index_state = 'lexical_ready' WHERE id = ? AND revision = ?",
          [doc.id, doc.revision],
        );
        return;
      }
      let count: number;
      try {
        count = await embedPendingBatch(this.e.idx, embedder, doc.id);
      } catch (error) {
        // Credentials/timeouts can change without changing the vector space. The
        // service caches provider objects per full config, so retry with the new one.
        if (this.e.embedder() !== embedder) continue;
        throw error;
      }
      // Settings may change while awaiting the provider. Drain the active profile before
      // marking ready; reconcile cannot enqueue another job while this one owns the lease.
      if (this.e.embedder()?.profile !== embedder.profile) continue;
      if (this.e.catalog.doc(doc.id)?.revision !== doc.revision) return;
      if (count) continue;
      if (this.e.idx.fullyEmbedded(embedder.profile, doc.id))
        this.e.db.run(
          "UPDATE kb_documents SET index_state = 'semantic_ready' WHERE id = ? AND revision = ?",
          [doc.id, doc.revision],
        );
      return;
    }
  }
}

export { decodeVector, inputHash };
