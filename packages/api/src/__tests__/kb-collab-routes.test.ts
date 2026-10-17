import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeKnowledgeService, getKnowledgeService } from "@orc/knowledge";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const ENV = ["ORC_KNOWLEDGE_ROOT", "HOME", "USERPROFILE"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const agent = {
  "X-Orc-Source": "mcp",
  "X-Orc-Actor-Name": "codex",
  "X-Orc-Actor-Backend": "codex",
};
let app: ReturnType<typeof createApp>;
let home: string;
const started: string[] = [];

const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  req(app, method, `/kb${path}`, body, headers);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "orc-api-kb-collab-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_KNOWLEDGE_ROOT = join(home, "knowledge");
  app = setupTestApp();
  // Runs are started by the daemon's executor; here they are only recorded.
  (await getKnowledgeService()).jobHooks = {
    sync: () => {},
    run: async (jobId) => {
      started.push(jobId);
      return `run-${started.length}`;
    },
  };
});

afterAll(async () => {
  await closeKnowledgeService();
  teardownTestApp();
  for (const k of ENV)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

describe("/api/kb collaboration", () => {
  let kbId: string;
  let docId: string;

  test("partial edits, numbered lines and restore", async () => {
    kbId = (await (await call("POST", "/bases", { name: "Learnings", project_id: null })).json())
      .id;
    const created = await call(
      "POST",
      `/bases/${kbId}/documents`,
      { title: "Deploy", content: "# Deploy\n\nstep one\nstep two\n" },
      agent,
    );
    docId = (await created.json()).id;

    const lines = await (await call("GET", `/documents/${docId}/lines?start=3&end=4`)).json();
    expect(lines).toMatchObject({ text: "3| step one\n4| step two", total_lines: 4, revision: 1 });

    const edit = await call(
      "POST",
      `/documents/${docId}/edit`,
      {
        expected_revision: 1,
        note: "add a step",
        edits: [{ start_line: 5, end_line: 4, new: "step three" }],
      },
      agent,
    );
    expect(edit.status).toBe(200);
    expect((await edit.json()).changed).toEqual([{ start_line: 5, end_line: 5 }]);
    const stale = await call(
      "POST",
      `/documents/${docId}/edit`,
      { expected_revision: 1, note: "late", edits: [{ old: "one", new: "1" }] },
      agent,
    );
    expect(stale.status).toBe(409);

    const restored = await call("POST", `/documents/${docId}/restore`, {
      revision: 1,
      expected_revision: 2,
    });
    expect((await restored.json()).revision).toBe(3);
  });

  test("comments: add on KB and document, list open first, close with a reply, reopen", async () => {
    const onDoc = await (
      await call(
        "POST",
        `/bases/${kbId}/comments`,
        { document_id: docId, body: "Missing rollback" },
        agent,
      )
    ).json();
    expect(onDoc).toMatchObject({ author: "codex", source: "mcp", document_title: "Deploy" });
    const onKb = await (
      await call("POST", `/bases/${kbId}/comments`, { body: "Digest https://example.com/runbook" })
    ).json();

    const closed = await call("POST", `/comments/${onDoc.id}/close`, {
      status: "resolved",
      reply: "Added a rollback section",
    });
    expect((await closed.json()).status).toBe("resolved");
    const list = await (await call("GET", `/bases/${kbId}/comments`)).json();
    expect(list.comments.map((c: { id: string }) => c.id)).toEqual([onKb.id, onDoc.id]);
    const open = await (await call("GET", `/bases/${kbId}/comments?status=open`)).json();
    expect(open.comments).toHaveLength(1);
    expect((await (await call("POST", `/comments/${onDoc.id}/reopen`)).json()).status).toBe("open");
  });

  test("digest: template, set creates a job, run, runs, and the job is guarded", async () => {
    const template = await (await call("GET", "/digest-template")).json();
    expect(template.instructions).toContain("open comment");
    expect((await (await call("GET", `/bases/${kbId}/digest`)).json()).digest).toBeNull();

    const set = await call("PUT", `/bases/${kbId}/digest`, {
      backend: "codex",
      schedule: { type: "cron", cron: "0 4 * * *" },
    });
    expect(set.status).toBe(200);
    const digest = await set.json();
    expect(digest).toMatchObject({
      backend: "codex",
      schedule: { cron: "0 4 * * *" },
      open_comments: 2,
    });
    expect(
      (await call("PUT", `/bases/${kbId}/digest`, { schedule: { type: "cron", cron: "nope" } }))
        .status,
    ).toBe(400);

    const run = await call("POST", `/bases/${kbId}/digest/run`, undefined, agent);
    expect(run.status).toBe(202);
    expect((await run.json()) as unknown).toEqual({ run_id: "run-1" });
    expect(started).toEqual([digest.job_id]);
    expect((await call("GET", `/bases/${kbId}/digest/runs`)).status).toBe(200);

    // The job page may pause or reschedule a digest; everything else belongs to the KB.
    const jobPath = `/jobs/${digest.job_id}`;
    expect((await req(app, "PATCH", jobPath, { enabled: false })).status).toBe(200);
    expect((await (await call("GET", `/bases/${kbId}/digest`)).json()).digest.enabled).toBe(false);
    expect((await req(app, "PATCH", jobPath, { command: "echo hi" })).status).toBe(400);
    expect((await req(app, "PATCH", jobPath, { trigger_type: "watch" })).status).toBe(400);
    expect((await req(app, "DELETE", jobPath)).status).toBe(400);
    expect(
      (
        await req(app, "POST", "/jobs", {
          name: "fake",
          command: `__orc_kb_digest__:${kbId}`,
          trigger_type: "manual",
        })
      ).status,
    ).toBe(400);

    expect((await call("DELETE", `/bases/${kbId}/digest`, undefined, agent)).status).toBe(400);
    expect(
      (await call("DELETE", `/bases/${kbId}/digest?confirm=Learnings`, undefined, agent)).status,
    ).toBe(204);
    expect((await req(app, "GET", jobPath)).status).toBe(404);
  });

  test("KB changes are in the audit log under entity type kb", async () => {
    const audit = await (await req(app, "GET", "/audit?entity_type=kb&limit=100")).json();
    const names = (audit.entries as { action: string }[]).map((a) => a.action);
    for (const a of [
      "kb.created",
      "kb.document.created",
      "kb.document.updated",
      "kb.comment.added",
      "kb.digest.set",
      "kb.digest.started",
      "kb.digest.deleted",
    ])
      expect(names).toContain(a);
  });
});
