import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcConfigSchema } from "@orc/core/config";
import { ConflictError, ForbiddenError, ValidationError } from "@orc/core/errors";
import { KB_DIGEST_TEMPLATE, type KbCallContext } from "@orc/core/kb";
import { createTestDb, getSqlite } from "@orc/db";
import { KbDigestStore, kbDigestCommand } from "@orc/db/kb-digest";
import type { KnowledgeConfig } from "../engine.js";
import { KnowledgeService } from "../service.js";

const human: KbCallContext = { source: "ui", actor: { name: "nir" } };
const agent: KbCallContext = {
  source: "mcp",
  actor: { name: "codex", backend: "codex", session_id: "s1" },
};

let root: string;
let db: Database;
let svc: KnowledgeService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "orc-kb-collab-"));
  db = getSqlite(createTestDb());
  const config: KnowledgeConfig = { ...OrcConfigSchema.parse({}).knowledge, root };
  svc = await KnowledgeService.open({
    db,
    config: () => config,
    root,
    embedder: null,
    defaultBackend: () => "codex",
  });
  svc.start();
});

afterEach(async () => {
  await svc.stop();
  svc.close();
  rmSync(root, { recursive: true, force: true });
});

const actions = () =>
  (
    db.query("SELECT action FROM audit_log WHERE entity_type = 'kb' ORDER BY rowid").all() as {
      action: string;
    }[]
  ).map((r) => r.action);

describe("knowledge base management over MCP", () => {
  test("agents manage KBs that allow mcp; deletes name the KB", () => {
    const kb = svc.createKb(agent, { name: "Notes", project_id: null });
    expect(svc.updateKb(agent, kb.id, { description: "d" }).description).toBe("d");
    expect(() => svc.updateKb(agent, kb.id, { parser: "basic" })).toThrow(ForbiddenError);
    expect(() => svc.deleteKb(agent, kb.id)).toThrow(ValidationError);
    expect(() => svc.deleteKb(agent, kb.id, { confirm: "notes" })).toThrow(ValidationError);
    svc.deleteKb(agent, kb.id, { confirm: "Notes" });
    expect(() => svc.getKb(kb.id)).toThrow("not found");
    expect(actions()).toEqual(["kb.created", "kb.updated", "kb.deleted"]);

    const locked = svc.createKb(human, { name: "Locked", project_id: null, editable_by: ["ui"] });
    expect(() => svc.updateKb(agent, locked.id, { editable_by: ["mcp"] })).toThrow(ForbiddenError);
    expect(() => svc.deleteKb(agent, locked.id, { confirm: "Locked" })).toThrow(ForbiddenError);
  });
});

describe("partial document edits", () => {
  test("edits a revision by text and lines, refuses stale revisions, keeps history", () => {
    const kb = svc.createKb(human, { name: "KB", project_id: null });
    const doc = svc.createDocument(agent, kb.id, {
      title: "Guide",
      content: "# Guide\n\nalpha\nbeta\ngamma\n",
    });
    expect(svc.readLines(agent, doc.id, 3, 4)).toMatchObject({
      text: "3| alpha\n4| beta",
      total_lines: 5,
      revision: 1,
    });
    const res = svc.editDocument(agent, doc.id, {
      expected_revision: 1,
      note: "fix",
      edits: [
        { old: "alpha", new: "ALPHA" },
        { start_line: 5, end_line: 5, new: "gamma\ndelta" },
      ],
    });
    expect(res.document.revision).toBe(2);
    expect(res.changed).toEqual([
      { start_line: 3, end_line: 3 },
      { start_line: 5, end_line: 6 },
    ]);
    expect(svc.getDocument(agent, doc.id).content).toBe("# Guide\n\nALPHA\nbeta\ngamma\ndelta\n");
    expect(svc.revisions(doc.id)[0]?.note).toBe("fix");
    expect(() =>
      svc.editDocument(agent, doc.id, {
        expected_revision: 1,
        note: "late",
        edits: [{ old: "beta", new: "B" }],
      }),
    ).toThrow(ConflictError);

    const restored = svc.restoreRevision(human, doc.id, 1, 2);
    expect(restored.revision).toBe(3);
    expect(svc.getDocument(human, doc.id).content).toBe("# Guide\n\nalpha\nbeta\ngamma\n");
    expect(actions().filter((a) => a.startsWith("kb.document"))).toEqual([
      "kb.document.created",
      "kb.document.updated",
      "kb.document.updated",
    ]);
  });
});

describe("comments", () => {
  test("anyone comments; closing follows editable_by; deleted documents hand comments to the KB", () => {
    const kb = svc.createKb(human, { name: "KB", project_id: null, editable_by: ["ui"] });
    const doc = svc.createDocument(human, kb.id, { title: "Page", content: "x" });
    const onDoc = svc.addComment(agent, kb.id, { document_id: doc.id, body: "Page is wrong" });
    const onKb = svc.addComment(human, kb.id, { body: "Digest https://example.com" });
    expect(onDoc).toMatchObject({ author: "codex", source: "mcp", document_title: "Page" });
    expect(svc.listComments(kb.id, { status: "open" }).map((c) => c.id)).toEqual([
      onKb.id,
      onDoc.id,
    ]);
    expect(() => svc.closeComment(agent, onKb.id, { status: "resolved", reply: "ok" })).toThrow(
      ForbiddenError,
    );
    const done = svc.closeComment(human, onKb.id, { status: "dismissed", reply: "Out of scope" });
    expect(done).toMatchObject({ status: "dismissed", reply: "Out of scope", resolved_by: "nir" });
    expect(svc.commentCounts(kb.id)).toEqual({ open: 1, resolved: 0, dismissed: 1 });
    expect(svc.commentCounts(kb.id, doc.id)).toEqual({ open: 1, resolved: 0, dismissed: 0 });
    expect(() => svc.closeComment(human, onKb.id, { status: "resolved", reply: "x" })).toThrow(
      ConflictError,
    );
    expect(svc.reopenComment(human, onKb.id).status).toBe("open");

    svc.deleteDocument(human, doc.id);
    const moved = svc.comment(onDoc.id);
    expect(moved.document_id).toBeNull();
    expect(moved.body).toContain('deleted document "Page"');
  });
});

describe("digests", () => {
  test("set creates a job; changes update it; delete removes both", () => {
    const synced: string[] = [];
    svc.jobHooks = { sync: (id) => synced.push(id), run: async () => "run-1" };
    const kb = svc.createKb(human, { name: "Learnings", project_id: null });
    const digest = svc.setDigest(human, kb.id, {});
    expect(digest).toMatchObject({
      instructions: KB_DIGEST_TEMPLATE,
      backend: "codex",
      schedule: { type: "cron", cron: "0 3 * * *" },
      enabled: true,
      open_comments: 0,
      last_run: null,
    });
    const job = db.query("SELECT * FROM jobs WHERE id = ?").get(digest.job_id) as {
      command: string;
      trigger_type: string;
    };
    expect(job.command).toBe(kbDigestCommand(kb.id));

    expect(() =>
      svc.setDigest(human, kb.id, { schedule: { type: "cron", cron: "not cron" } }),
    ).toThrow(ValidationError);
    const manual = svc.setDigest(agent, kb.id, {
      schedule: { type: "manual" },
      backend: "claude",
    });
    expect(manual).toMatchObject({ schedule: { type: "manual" }, backend: "claude" });
    expect(manual.job_id).toBe(digest.job_id);

    expect(() => svc.deleteDigest(agent, kb.id)).toThrow(ValidationError);
    svc.deleteDigest(agent, kb.id, { confirm: "Learnings" });
    expect(svc.getDigest(kb.id)).toBeNull();
    expect(db.query("SELECT 1 FROM jobs WHERE id = ?").get(digest.job_id)).toBeNull();
    expect(synced).toEqual([digest.job_id, digest.job_id, digest.job_id]);
    expect(actions().filter((a) => a.startsWith("kb.digest"))).toEqual([
      "kb.digest.set",
      "kb.digest.set",
      "kb.digest.deleted",
    ]);
  });

  test("a digest needs mcp in editable_by; runs need the daemon hooks", async () => {
    const locked = svc.createKb(human, { name: "L", project_id: null, editable_by: ["ui"] });
    expect(() => svc.setDigest(human, locked.id, {})).toThrow("allow mcp");
    const kb = svc.createKb(human, { name: "K", project_id: null });
    svc.setDigest(human, kb.id, {});
    await expect(svc.runDigest(human, kb.id)).rejects.toThrow("ORC daemon");
    svc.jobHooks = { sync: () => {}, run: async () => "run-9" };
    expect(await svc.runDigest(human, kb.id)).toEqual({ run_id: "run-9" });

    const jobId = svc.getDigest(kb.id)?.job_id;
    db.run(
      "INSERT INTO job_runs (id, job_id, status, trigger_by, started_at, stdout, created_at) VALUES ('r1', ?, 'success', 'ui', 100, 'applied: 2 docs', 100)",
      [jobId as string],
    );
    db.run("INSERT INTO sessions (id, agent, job_run_id) VALUES ('sess-r1', 'codex', 'r1')");
    expect(svc.digestRuns(kb.id)).toEqual([
      {
        run_id: "r1",
        status: "success",
        trigger_by: "ui",
        started_at: 100_000,
        ended_at: null,
        summary: "applied: 2 docs",
        error: null,
        session_id: "sess-r1",
      },
    ]);
  });

  test("claim, complete and fail move the watermark only on completion", () => {
    const kb = svc.createKb(human, { name: "K", project_id: null });
    svc.setDigest(human, kb.id, {});
    svc.addComment(human, kb.id, { body: "Add the deploy steps" });
    const store = new KbDigestStore(db);
    expect(store.hasNewInput(kb.id)).toBe(true);

    const first = store.claim(kb.id, 600);
    expect(first?.comments.map((c) => c.body)).toEqual(["Add the deploy steps"]);
    expect(store.claim(kb.id, 600)).toBeNull();
    store.fail(first?.token as string, "timed out");
    expect(svc.getDigest(kb.id)?.last_success_at).toBeNull();
    expect(svc.getDigest(kb.id)?.last_run?.status).toBe("failed");

    const second = store.claim(kb.id, 600);
    store.complete(second?.token as string, "applied", "added deploy doc", "codex");
    const after = svc.getDigest(kb.id);
    expect(after?.last_success_at).toBeGreaterThan(0);
    expect(after?.last_run).toMatchObject({
      status: "completed",
      note: "applied: added deploy doc",
    });
    expect(store.completed(second?.token as string)).toBe(true);
    expect(() => store.complete(second?.token as string, "applied", "again", "codex")).toThrow(
      ConflictError,
    );
  });

  test("next_run_at is the next cron start while the schedule is on", () => {
    const kb = svc.createKb(human, { name: "K", project_id: null });
    const before = Date.now();
    const daily = svc.setDigest(human, kb.id, {});
    const next = new Date(daily.next_run_at as number);
    expect(next.getTime()).toBeGreaterThan(before);
    expect(next.getTime() - before).toBeLessThanOrEqual(86_400_000);
    expect([next.getHours(), next.getMinutes()]).toEqual([3, 0]);
    expect(svc.setDigest(human, kb.id, { enabled: false }).next_run_at).toBeNull();
    expect(svc.setDigest(human, kb.id, { schedule: { type: "manual" } }).next_run_at).toBeNull();
  });

  test("deleting the KB removes its digest job", () => {
    const kb = svc.createKb(human, { name: "K", project_id: null });
    const { job_id } = svc.setDigest(human, kb.id, {});
    svc.deleteKb(human, kb.id);
    expect(db.query("SELECT 1 FROM jobs WHERE id = ?").get(job_id)).toBeNull();
  });
});

describe("starter Learnings KBs", () => {
  test("each active project gets one with a digest, once", () => {
    db.exec(
      "INSERT INTO projects(id, name) VALUES ('p1', 'one'), ('p2', 'two'); INSERT INTO projects(id, name, status) VALUES ('p3', 'old', 'archived')",
    );
    svc.createKb(human, { name: "learnings", project_id: "p2" });

    const created = svc.ensureLearningsKbs();
    expect(created).toHaveLength(1);
    const kbs = svc.listKbs(human, "all").filter((k) => k.name === "Learnings");
    expect(kbs.map((k) => k.project_id)).toEqual(["p1"]);
    const p1 = kbs[0];
    expect(svc.getDigest(p1?.id as string)).toMatchObject({
      backend: "codex",
      instructions: KB_DIGEST_TEMPLATE,
      schedule: { type: "cron", cron: "0 3 * * *" },
      enabled: true,
    });

    // A deleted starter is not created again; the user's own KB in p2 is left alone.
    svc.deleteKb(human, p1?.id as string);
    expect(svc.ensureLearningsKbs()).toEqual([]);
    expect(svc.listKbs(human, "all").map((k) => k.name)).toEqual(["learnings"]);
  });
});
