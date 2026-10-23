import { type Database, Database as SqliteDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcConfigSchema } from "@orc/core/config";
import { ConflictError, ForbiddenError, ValidationError } from "@orc/core/errors";
import type { KbCallContext } from "@orc/core/kb";
import { createTestDb, getSqlite } from "@orc/db";
import { projectKbCount } from "@orc/db/kb";
import { chunkBlocks } from "../chunker.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "../embeddings.js";
import type { KnowledgeConfig } from "../engine.js";
import { markdownToBlocks } from "../markdown.js";
import { KnowledgeService } from "../service.js";

const human = (source: KbCallContext["source"] = "ui"): KbCallContext => ({
  source,
  actor: {},
});
const agent = (source: KbCallContext["source"] = "mcp", session_id = "s1"): KbCallContext => ({
  source,
  actor: { backend: "claude", session_id },
});

/** Deterministic bag-of-words embedder: shared words => nearby vectors. */
const fakeEmbedder = (): EmbeddingProvider & { calls: number } => {
  const e = {
    provider: "ollama" as const,
    model: "fake",
    profile: "ollama:fake:16",
    batchSize: 8,
    calls: 0,
    async embed(texts: string[]) {
      e.calls++;
      return texts.map((t) => {
        const v = new Array(16).fill(0);
        for (const w of t.toLowerCase().match(/[a-z]+/g) ?? [])
          v[Number(BigInt(Bun.hash(w)) % 16n)] += 1;
        return v;
      });
    },
  };
  return e;
};

let root: string;
let db: Database;
let svc: KnowledgeService;
let config: KnowledgeConfig;

async function open(embedder: EmbeddingProvider | null = null) {
  const s = await KnowledgeService.open({ db, config: () => config, root, embedder });
  s.start();
  return s;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-kb-test-"));
  db = getSqlite(createTestDb());
  config = { ...OrcConfigSchema.parse({}).knowledge, root };
  svc = await open();
});

afterEach(async () => {
  await svc.stop();
  svc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("knowledge bases", () => {
  test("project KBs require an existing project; names are unique per scope", () => {
    expect(() => svc.createKb(human(), { name: "P", project_id: "nope" })).toThrow("Project");
    db.run("INSERT INTO projects (id, name) VALUES ('p1', 'Proj')");
    const g = svc.createKb(human(), { name: "Docs", project_id: null });
    const p = svc.createKb(human(), { name: "Docs", project_id: "p1" });
    expect(g.project_id).toBeNull();
    expect(p.project_id).toBe("p1");
    expect(() => svc.createKb(human(), { name: "docs", project_id: null })).toThrow(ConflictError);
    // Agents create KBs over MCP too; folders and parsers stay off MCP.
    expect(svc.createKb(agent(), { name: "X", project_id: null }).name).toBe("X");
    expect(projectKbCount(getSqlite(), "p1")).toBe(1);
    const x = svc.listKbs(human()).find((k) => k.name === "X")?.id as string;
    expect(svc.listKbs({ ...human(), project_id: "p1" }).map((k) => k.id)).toEqual([p.id, g.id, x]);
    expect(svc.listKbs(human()).map((k) => k.id)).toEqual([g.id, x]);
  });
});

describe("documents", () => {
  test("exact-title fallback does not cite superseded chunks while reindex is pending", async () => {
    const kb = svc.createKb(human(), { name: "Revision fixture", project_id: null });
    const doc = svc.createDocument(human(), kb.id, {
      title: "Unique Runbook",
      content: "Obsolete passage",
    });
    await svc.jobs.idle();
    await svc.stop();
    db.run("UPDATE kb_documents SET revision = revision + 1 WHERE id = ?", [doc.id]);
    const res = await svc.search(agent(), { query: "Unique Runbook" });
    expect(res.hits[0]?.document_id).toBe(doc.id);
    expect(res.hits[0]?.passages).toEqual([]);
  });
  test("authored document: create, search, cite, read by source", async () => {
    const kb = svc.createKb(human(), { name: "Ops", project_id: null });
    const doc = svc.createDocument(human(), kb.id, {
      title: "Deploy runbook",
      content: "# Deploy runbook\n\nRoll back with `orc rollback` when the canary fails.\n",
      labels: ["Ops Team"],
    });
    expect(doc.path).toBe("deploy-runbook.md");
    expect(doc.labels).toEqual(["ops-team"]);
    expect(existsSync(join(root, "documents", kb.id, `${doc.id}.md`))).toBe(true);
    await svc.jobs.idle();
    expect(svc.engine.catalog.doc(doc.id)?.index_state).toBe("lexical_ready");

    const res = await svc.search(agent(), { query: "canary rollback" });
    expect(res.mode).toBe("lexical");
    const hit = res.hits[0];
    expect(hit?.document_id).toBe(doc.id);
    const citation = hit?.passages[0]?.citation ?? "";
    expect(citation).toMatch(new RegExp(`^kb:${doc.id}@1#0$`));

    const passage = svc.readCitation(agent(), doc.id, 1, 0);
    expect(passage.content).toContain("canary");
    svc.getDocument(agent("mcp", "s2"), doc.id);
    svc.getDocument(human("api"), doc.id);
    svc.getDocument(human("ui"), doc.id, { record: false });

    const stats = svc.documentUsage(doc.id);
    expect(stats.totals.mcp.fetch).toBe(2);
    expect(stats.totals.api.fetch).toBe(1);
    expect(stats.totals.ui.fetch).toBe(0);
    expect(stats.totals.mcp.search_hit).toBe(1);
    expect(stats.reads).toBe(3);
    expect(stats.exposures).toBe(1);
    expect(stats.distinct_sessions).toBe(2);
    const listing = svc.listDocuments(kb.id);
    expect(listing.documents[0]?.reads).toBe(3);
    expect(listing.documents[0]?.reads_by_source).toEqual({ mcp: 2, api: 1 });
  });

  test("revision conflicts and edit permissions by source", async () => {
    const kb = svc.createKb(human(), { name: "K", project_id: null, editable_by: ["ui", "cli"] });
    const doc = svc.createDocument(human(), kb.id, { title: "A", content: "one" });
    const v2 = svc.updateDocument(human(), doc.id, { expected_revision: 1, content: "two" });
    expect(v2.revision).toBe(2);
    expect(() =>
      svc.updateDocument(human(), doc.id, { expected_revision: 1, content: "three" }),
    ).toThrow(ConflictError);
    expect(() =>
      svc.updateDocument(agent(), doc.id, { expected_revision: 2, content: "x" }),
    ).toThrow(ForbiddenError);
    expect(() => svc.deleteDocument(agent(), doc.id)).toThrow(ForbiddenError);
    expect(() =>
      svc.updateDocument(human("api"), doc.id, { expected_revision: 2, content: "x" }),
    ).toThrow(ForbiddenError);
    expect(svc.revisions(doc.id).map((r) => r.revision)).toEqual([2, 1]);
    expect(svc.revisionContent(doc.id, 1).content).toBe("one");
    // Metadata-only change keeps content, bumps revision.
    const v3 = svc.updateDocument(human(), doc.id, { expected_revision: 2, path: "notes/a.md" });
    expect(v3.revision).toBe(3);
    expect(svc.listDocuments(kb.id).folders).toEqual(["notes"]);
    expect(() =>
      svc.updateDocument(human(), doc.id, { expected_revision: 3, path: "a.pdf" }),
    ).toThrow(ValidationError);
    await svc.jobs.idle();
    const res = await svc.search(human(), { query: "two" });
    expect(res.hits[0]?.revision).toBe(3);
  });

  test("wiki links resolve to backlinks, including documents created later", async () => {
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    const a = svc.createDocument(human(), kb.id, {
      title: "Alpha",
      content: "See [[Beta]] and [x](gamma.md).",
    });
    await svc.jobs.idle();
    expect(svc.getDocument(human(), a.id).links).toEqual([
      { target: "beta", document_id: null, title: null },
      { target: "gamma", document_id: null, title: null },
    ]);
    expect(svc.maintenanceQueue(kb.id).unresolved_links).toHaveLength(2);
    const b = svc.createDocument(human(), kb.id, { title: "Beta", content: "Back to [[Alpha]]" });
    await svc.jobs.idle();
    expect(svc.getDocument(human(), a.id).links[0]).toEqual({
      target: "beta",
      document_id: b.id,
      title: "Beta",
    });
    expect(svc.getDocument(human(), b.id).backlinks.map((l) => l.document_id)).toEqual([a.id]);
    expect(svc.getDocument(human(), a.id).backlinks.map((l) => l.document_id)).toEqual([b.id]);
    expect(svc.maintenanceQueue(kb.id).unresolved_links.map((l) => l.target)).toEqual(["gamma"]);
  });

  test("uploads are parsed in a worker and become searchable", async () => {
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    const html =
      "<html><body><h1>Quarterly report</h1><p>Revenue grew in the widget segment.</p></body></html>";
    const doc = svc.upload(human(), kb.id, {
      name: "report.html",
      bytes: new TextEncoder().encode(html),
    });
    expect(doc.parse_state).toBe("pending");
    // An HTML page is titled like a Markdown upload: from its own heading, not the file name.
    expect(doc.title).toBe("Quarterly report");
    await svc.jobs.idle();
    const parsed = svc.engine.catalog.doc(doc.id);
    expect(parsed?.parse_state).toBe("ok");
    expect(parsed?.parser_id).toBe("basic");
    const res = await svc.search(human(), { query: "widget revenue" });
    expect(res.hits[0]?.document_id).toBe(doc.id);
    // Same bytes again is a no-op; unknown formats are refused.
    const same = svc.upload(human(), kb.id, {
      name: "report.html",
      bytes: new TextEncoder().encode(html),
      document_id: doc.id,
      expected_revision: 1,
    });
    expect(same.revision).toBe(1);
    expect(() => svc.upload(human(), kb.id, { name: "x.exe", bytes: new Uint8Array([1]) })).toThrow(
      ValidationError,
    );
    const original = svc.original(human("api"), doc.id);
    expect(readFileSync(original.path, "utf8")).toBe(html);
    // Markdown uploads become editable authored docs.
    const md = svc.upload(human(), kb.id, {
      name: "Guide.md",
      bytes: new TextEncoder().encode("# Setup guide\n\nhi"),
    });
    expect(md.title).toBe("Setup guide");
    expect(md.editable).toBe(true);
  });

  test("deleting a KB removes its stored files and index", async () => {
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    const doc = svc.upload(human(), kb.id, {
      name: "a.csv",
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
    });
    await svc.jobs.idle();
    expect(existsSync(join(root, "originals", kb.id))).toBe(true);
    svc.deleteKb(human(), kb.id);
    expect(existsSync(join(root, "originals", kb.id))).toBe(false);
    expect(existsSync(join(root, "artifacts", doc.id))).toBe(false);
    expect(svc.engine.idx.chunkCount()).toBe(0);
    expect(svc.status().documents).toBe(0);
  });
});

describe("jobs", () => {
  test.each(["invalid-json", "wrong-source"])(
    "rebuilds a corrupt parser cache from the retained original (%s)",
    async (damage) => {
      const kb = svc.createKb(human(), { name: "Parser recovery", project_id: null });
      const doc = svc.upload(human(), kb.id, {
        name: "recovery.html",
        bytes: new TextEncoder().encode("<h1>Original</h1><p>retained original content</p>"),
      });
      await svc.jobs.idle();
      const row = svc.engine.catalog.doc(doc.id);
      if (!row?.parser_id || !row.parser_version) throw Error("Missing parsed fixture");
      const path = svc.engine.storage.artifactPath(
        doc.id,
        row.content_hash,
        row.parser_id,
        row.parser_version,
      );
      if (damage === "invalid-json") writeFileSync(path, "{");
      else {
        const artifact = JSON.parse(readFileSync(path, "utf8"));
        artifact.source_sha256 = "0".repeat(64);
        artifact.markdown = "Wrong document content";
        artifact.blocks = [{ kind: "paragraph", text: "Wrong document content", heading_path: [] }];
        writeFileSync(path, JSON.stringify(artifact));
      }
      svc.engine.catalog.enqueue(kb.id, doc.id, 1, "index", "cache-recovery-job");
      svc.jobs.kick();
      await svc.jobs.idle();
      expect(svc.getDocument(human(), doc.id).content).toContain("retained original content");
      expect(
        svc.engine.idx
          .documentChunks(doc.id)
          .map((c) => c.text)
          .join("\n"),
      ).toContain("retained original content");
      expect(svc.engine.catalog.doc(doc.id)?.revision).toBe(1);
    },
  );
  test("transient provider failures leave keyword search available and resume the durable embedding job", async () => {
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        calls++;
        if (calls === 1) return new Response("private provider payload", { status: 429 });
        return Response.json({ embeddings: body.input.map(() => [1, 0]) });
      },
    });
    try {
      const provider = createEmbeddingProvider({
        provider: "ollama",
        model: "fixture",
        base_url: `http://127.0.0.1:${server.port}`,
        batch_size: 2,
        timeout_secs: 1,
      });
      svc.engine.embedder = () => provider;
      const kb = svc.createKb(human(), { name: "Durable retry", project_id: null });
      const doc = svc.createDocument(human(), kb.id, {
        title: "Retryable",
        content: "unique retry keyword",
      });
      await svc.jobs.idle();
      const job = db
        .query(
          "SELECT status, attempts, error FROM kb_jobs WHERE document_id = ? AND kind = 'embed'",
        )
        .get(doc.id) as { status: string; attempts: number; error: string };
      expect(job.status).toBe("queued");
      expect(job.attempts).toBe(1);
      expect(job.error).not.toContain("private");
      expect(
        (await svc.search(human(), { query: "unique retry", mode: "lexical" })).hits[0]
          ?.document_id,
      ).toBe(doc.id);
      db.run("UPDATE kb_jobs SET run_after = 0 WHERE document_id = ? AND kind = 'embed'", [doc.id]);
      svc.jobs.kick();
      await svc.jobs.idle();
      expect(svc.engine.catalog.doc(doc.id)?.index_state).toBe("semantic_ready");
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });
  test("reconcile repairs a nonempty index containing a superseded revision", async () => {
    const kb = svc.createKb(human(), { name: "Stale index", project_id: null });
    const doc = svc.createDocument(human(), kb.id, {
      title: "Current",
      content: "current catalog passage",
    });
    await svc.jobs.idle();
    svc.engine.idx.db.run(
      "UPDATE chunks SET revision = 0, text = 'superseded passage' WHERE document_id = ?",
      [doc.id],
    );
    svc.reconcile();
    await svc.jobs.idle();
    expect(
      svc.engine.idx
        .documentChunks(doc.id)
        .every((c) => c.revision === 1 && c.text === "current catalog passage"),
    ).toBe(true);
  });
  test("reconcile clears orphaned derived passages left by an interrupted document deletion", async () => {
    const kb = svc.createKb(human(), { name: "Interrupted removal", project_id: null });
    const doc = svc.createDocument(human(), kb.id, {
      title: "Removed document",
      content: "private deleted passage",
    });
    await svc.jobs.idle();
    // Simulate a crash after catalog deletion committed but before index cleanup.
    db.run("DELETE FROM kb_documents WHERE id = ?", [doc.id]);
    expect(svc.engine.idx.documentChunks(doc.id).length).toBeGreaterThan(0);
    svc.reconcile();
    expect(svc.engine.idx.documentChunks(doc.id)).toEqual([]);
  });
  test.each([false, true])(
    "changing embedding profile during an in-flight job finishes the new active profile (old failure: %s)",
    async (fail) => {
      let release: (() => void) | undefined;
      let started: (() => void) | undefined;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const old = fakeEmbedder();
      old.embed = async (texts) => {
        started?.();
        await wait;
        if (fail) throw new Error("Old endpoint unavailable");
        return texts.map(() => [1, 0]);
      };
      const next = { ...fakeEmbedder(), profile: "new-active-profile" };
      let active: EmbeddingProvider = old;
      svc.engine.embedder = () => active;
      const kb = svc.createKb(human(), { name: "Profile race", project_id: null });
      const doc = svc.createDocument(human(), kb.id, {
        title: "Network",
        content: "DNS resolver instructions",
      });
      await began;
      active = next;
      svc.reconcile();
      release?.();
      await svc.jobs.idle();
      expect(svc.engine.idx.fullyEmbedded(next.profile, doc.id)).toBe(true);
      expect(svc.engine.catalog.doc(doc.id)?.index_state).toBe("semantic_ready");
    },
  );
  test("rebuilding legacy passages preserves citations; new revisions opt into improved chunking", async () => {
    await svc.stop();
    const kb = svc.createKb(human(), { name: "Versioned chunks", project_id: null });
    const content = "A long sentence for the old citation boundaries. ".repeat(100);
    const doc = svc.createDocument(human(), kb.id, { title: "Legacy", content });
    db.run("UPDATE kb_document_revisions SET chunk_version = 1 WHERE document_id = ?", [doc.id]);
    svc.start();
    await svc.jobs.idle();
    const expected = chunkBlocks(markdownToBlocks(content), 1);
    expect(svc.engine.idx.documentChunks(doc.id).map((c) => c.text)).toEqual(
      expected.map((c) => c.text),
    );
    await svc.stop();
    svc.close();
    for (const file of ["index.db", "index.db-wal", "index.db-shm"])
      rmSync(join(root, file), { force: true });
    svc = await open();
    await svc.jobs.idle();
    const first = expected[0];
    if (!first) throw new Error("Missing expected legacy passage");
    expect(svc.readCitation(human(), doc.id, 1, 0).content).toBe(first.text);
    svc.updateDocument(human(), doc.id, {
      expected_revision: 1,
      content: `${content}\nNew revision.`,
    });
    await svc.jobs.idle();
    expect(svc.engine.catalog.revision(doc.id, 2)?.chunk_version).toBe(2);
    expect(() => svc.readCitation(human(), doc.id, 1, 0)).toThrow(ConflictError);
  });
  test("interrupted jobs resume after restart; lost index is rebuilt", async () => {
    await svc.stop();
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    const doc = svc.createDocument(human(), kb.id, {
      title: "Crash",
      content: "survives restarts",
    });
    // A fresh claim belongs to another live process (e.g. a stdio MCP server): left alone.
    db.run("UPDATE kb_jobs SET status = 'running', started_at = ? WHERE document_id = ?", [
      Date.now(),
      doc.id,
    ]);
    svc.close();
    svc = await open();
    await svc.jobs.idle();
    expect(svc.engine.catalog.doc(doc.id)?.index_state).toBe("pending");
    // An expired claim was a crashed process: requeued and finished.
    await svc.stop();
    db.run("UPDATE kb_jobs SET started_at = 1 WHERE document_id = ?", [doc.id]);
    svc.close();
    svc = await open();
    await svc.jobs.idle();
    expect(svc.engine.catalog.doc(doc.id)?.index_state).toBe("lexical_ready");
    expect((await svc.search(human(), { query: "restarts" })).hits).toHaveLength(1);

    // index.db deleted while stopped: reconcile requeues indexing.
    await svc.stop();
    svc.close();
    for (const f of ["index.db", "index.db-wal", "index.db-shm"])
      rmSync(join(root, f), { force: true });
    svc = await open();
    await svc.jobs.idle();
    expect((await svc.search(human(), { query: "restarts" })).hits).toHaveLength(1);
  });

  test("a backup of orc.db and originals restores uploads by parsing them again", async () => {
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    const doc = svc.upload(human(), kb.id, {
      name: "page.html",
      bytes: new TextEncoder().encode("<html><body><p>restoreneedle text</p></body></html>"),
    });
    await svc.jobs.idle();
    await svc.stop();
    svc.close();
    for (const f of ["index.db", "index.db-wal", "index.db-shm", "artifacts", "documents"])
      rmSync(join(root, f), { recursive: true, force: true });
    svc = await open();
    await svc.jobs.idle();
    expect(svc.engine.catalog.doc(doc.id)).toMatchObject({
      parse_state: "ok",
      index_state: "lexical_ready",
    });
    expect((await svc.search(human(), { query: "restoreneedle" })).hits).toHaveLength(1);
  });

  test("an index from an older schema version is rebuilt, vectors included", async () => {
    await svc.stop();
    svc.close();
    svc = await open(fakeEmbedder());
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    svc.createDocument(human(), kb.id, { title: "Cats", content: "felines purr and nap" });
    await svc.jobs.idle();
    await svc.stop();
    svc.close();
    const raw = new SqliteDatabase(join(root, "index.db"));
    raw.run("PRAGMA user_version = 1");
    raw.close();
    svc = await open(fakeEmbedder());
    await svc.jobs.idle();
    const res = await svc.search(human(), { query: "purr", mode: "semantic" });
    expect(res.hits[0]?.title).toBe("Cats");
    expect(svc.status().embedding.pending_chunks).toBe(0);
  });

  test("hybrid search with embeddings; vectors are reused across restarts", async () => {
    await svc.stop();
    svc.close();
    const emb = fakeEmbedder();
    svc = await open(emb);
    const kb = svc.createKb(human(), { name: "K", project_id: null });
    svc.createDocument(human(), kb.id, {
      title: "Cats",
      content: "felines purr and nap in sunlight",
    });
    svc.createDocument(human(), kb.id, { title: "Engines", content: "pistons compress fuel" });
    await svc.jobs.idle();
    expect(svc.status().embedding.ready).toBe(true);
    // Without a configured size, status reports the size the provider returned.
    expect(svc.status().embedding.dimensions).toBe(16);
    const res = await svc.search(human(), { query: "purr sunlight", mode: "hybrid" });
    expect(res.mode).toBe("hybrid");
    expect(res.hits[0]?.title).toBe("Cats");
    expect(res.hits[0]?.matched_by).toContain("semantic");
    const calls = emb.calls;
    await svc.stop();
    svc.close();
    svc = await open(emb);
    await svc.jobs.idle();
    expect(emb.calls).toBe(calls);
  });
});

describe("edit permissions", () => {
  test("editable_by decides which call sources may change documents", () => {
    const open_ = svc.createKb(human(), { name: "Open", project_id: null });
    expect(open_.editable_by).toEqual(["mcp", "api", "cli", "ui"]);
    const doc = svc.createDocument(agent(), open_.id, { title: "Direct", content: "d" });
    expect(doc.updated_by).toBe("claude");
    expect(svc.revisions(doc.id)[0]?.source).toBe("mcp");
    svc.updateDocument(human("cli"), doc.id, { expected_revision: 1, content: "e" });
    expect(svc.revisions(doc.id).map((r) => r.source)).toEqual(["cli", "mcp"]);

    // Order and duplicates do not matter; an empty list freezes the KB for every source.
    const frozen = svc.updateKb(human(), open_.id, { editable_by: ["ui", "mcp", "ui"] });
    expect(frozen.editable_by).toEqual(["mcp", "ui"]);
    svc.updateKb(human(), open_.id, { editable_by: [] });
    for (const ctx of [human(), human("api"), agent()])
      expect(() => svc.createDocument(ctx, open_.id, { title: "T", content: "c" })).toThrow(
        ForbiddenError,
      );

    // An agent cannot change a KB that does not allow mcp, so it cannot grant itself edit rights.
    expect(() => svc.updateKb(agent(), open_.id, { editable_by: ["mcp"] })).toThrow(ForbiddenError);
    expect(() => svc.deleteKb(agent(), open_.id)).toThrow(ForbiddenError);
    expect(() =>
      svc.createKb(human("api"), { name: "Bad", project_id: null, editable_by: ["root" as "ui"] }),
    ).toThrow();
  });
});

describe("registered folders", () => {
  test("folder files are copied in, follow the file until edited, and never get written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-kb-src-"));
    try {
      mkdirSync(join(dir, "sub"));
      mkdirSync(join(dir, ".git"));
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, "sub", "a.md"), "# Alpha note\n\nzebra facts");
      writeFileSync(join(dir, "c.md"), "# Gamma\n\nottér notes");
      writeFileSync(join(dir, ".git", "x.md"), "hidden");
      writeFileSync(join(dir, "node_modules", "y.md"), "dep");
      writeFileSync(join(dir, "b.csv"), "k,v\nquokka,1\n");
      const kb = svc.createKb(human(), { name: "Folder", project_id: null });
      expect(() => svc.addSource(agent(), kb.id, { root_path: dir })).toThrow(ForbiddenError);
      const { source, scan } = svc.addSource(human(), kb.id, { root_path: dir });
      expect(scan).toMatchObject({ added: 3, updated: 0, missing: 0 });
      await svc.jobs.idle();
      expect((await svc.search(human(), { query: "zebra" })).hits[0]?.title).toBe("Alpha note");
      expect((await svc.search(human(), { query: "quokka" })).hits).toHaveLength(1);

      const byTitle = (t: string) => svc.listDocuments(kb.id).documents.find((d) => d.title === t);
      const a = byTitle("Alpha note");
      expect(a?.path.endsWith("/sub/a.md")).toBe(true);
      expect(a).toMatchObject({ editable: true, folder_sync: "following" });

      // Following: a change in the folder updates the copy.
      writeFileSync(join(dir, "sub", "a.md"), "# Alpha note\n\nchanged in folder");
      expect(svc.scanSource(source.id)).toMatchObject({ updated: 1, unchanged: 2 });
      expect(svc.getDocument(human(), a?.id ?? "").content).toBe(
        "# Alpha note\n\nchanged in folder",
      );

      // Editing in ORC changes the copy only and detaches it from the file.
      const edited = svc.updateDocument(human(), a?.id ?? "", {
        expected_revision: 2,
        content: "# Alpha note\n\nedited in orc",
      });
      expect(edited.folder_sync).toBe("detached");
      expect(readFileSync(join(dir, "sub", "a.md"), "utf8")).toBe(
        "# Alpha note\n\nchanged in folder",
      );
      writeFileSync(join(dir, "sub", "a.md"), "# Alpha note\n\nchanged again");
      expect(svc.scanSource(source.id).updated).toBe(0);
      expect(svc.getDocument(human(), a?.id ?? "").content).toBe("# Alpha note\n\nedited in orc");

      // Binary-ish formats keep a stored original, so a vanished file keeps its copy searchable.
      const csv = byTitle("b");
      expect(svc.original(human(), csv?.id ?? "").path.startsWith(dir)).toBe(false);
      unlinkSync(join(dir, "b.csv"));
      unlinkSync(join(dir, "c.md"));
      expect(svc.scanSource(source.id).missing).toBe(2);
      await svc.jobs.idle();
      expect((await svc.search(human(), { query: "quokka" })).hits).toHaveLength(1);
      expect(byTitle("Gamma")?.warnings).toContain("Source file is missing");
      expect(svc.maintenanceQueue(kb.id).failed).toHaveLength(0);
      writeFileSync(join(dir, "c.md"), "# Gamma\n\nottér notes");
      expect(svc.scanSource(source.id).updated).toBe(1);
      expect(byTitle("Gamma")?.warnings).toEqual([]);

      expect(() => svc.deleteDocument(human(), csv?.id ?? "")).toThrow(ValidationError);
      expect(svc.listSources(kb.id)).toEqual([
        expect.objectContaining({ id: source.id, document_count: 3, edited_count: 1 }),
      ]);

      // Stopping the sync removes the following copies and keeps the edited one as a document.
      expect(svc.removeSource(human(), source.id)).toEqual({ removed: 2, kept: 1 });
      expect(svc.listSources(kb.id)).toEqual([]);
      const kept = svc.listDocuments(kb.id).documents;
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({
        id: a?.id,
        origin: "authored",
        folder_sync: null,
        editable: true,
        original_name: null,
      });
      expect(svc.getDocument(human(), a?.id ?? "").content).toBe("# Alpha note\n\nedited in orc");
      await svc.jobs.idle();
      expect((await svc.search(human(), { query: "edited" })).hits[0]?.title).toBe("Alpha note");
      expect((await svc.search(human(), { query: "quokka" })).hits).toHaveLength(0);
      // A kept copy is an ordinary document now: deletable, and a re-added folder does not claim it.
      const again = svc.addSource(human(), kb.id, { root_path: dir });
      expect(again.scan.errors.join("\n")).toContain("already uses the path");
      expect(again.source).toMatchObject({ document_count: 1, edited_count: 0 });
      expect(svc.removeSource(human(), again.source.id)).toEqual({ removed: 1, kept: 0 });
      svc.deleteDocument(human(), a?.id ?? "");
      expect(svc.listDocuments(kb.id).documents).toHaveLength(0);
      expect(existsSync(join(dir, "sub", "a.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("storage", () => {
  test("paths cannot escape the knowledge root", () => {
    expect(() => svc.engine.storage.resolveRel("../outside")).toThrow();
    expect(() => svc.engine.storage.resolveRel("originals/../../x")).toThrow();
    expect(() =>
      svc.engine.storage.putOriginal("../k", "d", 1, "pdf", new Uint8Array([1])),
    ).toThrow();
  });
});
