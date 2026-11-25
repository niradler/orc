import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ulid } from "@orc/core/ids";
import { createTestDb, getDb, getSqlite } from "@orc/db/client";
import { KbDigestStore, kbDigestCommand } from "@orc/db/kb-digest";
import { job_runs, jobs } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { executeJob } from "./executor.js";
import { type KbDigestAgentRun, runKbDigest } from "./kb-digest.js";

const kbId = "kb1";
const jobId = "job-digest";
let prompts: KbDigestAgentRun[] = [];

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
  const now = Date.now();
  getDb()
    .insert(jobs)
    .values({
      id: jobId,
      name: `kb-digest:${kbId}`,
      command: kbDigestCommand(kbId),
      trigger_type: "manual",
      created_at: new Date(now),
      updated_at: new Date(now),
    })
    .run();
  const sqlite = getSqlite();
  sqlite
    .query(
      "INSERT INTO knowledge_bases(id, name, description, project_id, created_at, updated_at) VALUES (?, 'Learnings', 'Lessons', NULL, ?, ?)",
    )
    .run(kbId, now, now);
  sqlite
    .query(
      "INSERT INTO kb_digests(kb_id, instructions, backend, job_id, created_at, updated_at) VALUES (?, 'Keep it current.', 'codex', ?, ?, ?)",
    )
    .run(kbId, jobId, now, now);
  sqlite
    .query(
      "INSERT INTO kb_comments(id, kb_id, body, author, source, created_at, updated_at) VALUES ('c1', ?, 'Digest https://example.com/runbook', 'nir', 'ui', ?, ?)",
    )
    .run(kbId, now, now);
  sqlite
    .query(
      "INSERT INTO sessions(id, agent, summary, created_at) VALUES ('s1', 'codex', 'Found that the release needs --otp', unixepoch())",
    )
    .run();
});

beforeEach(() => {
  prompts = [];
});

afterAll(() => {
  delete process.env.ORC_DB_PATH;
});

const newRun = () => {
  const runId = ulid();
  getDb()
    .insert(job_runs)
    .values({ id: runId, job_id: jobId, status: "running", created_at: new Date() })
    .run();
  return runId;
};
const tokenOf = (prompt: string) => prompt.match(/token "([^"]+)"/)?.[1] ?? "";
const digest = () => new KbDigestStore(getSqlite()).row(kbId);
const runSession = (runId: string) =>
  getSqlite()
    .query<{ id: string; agent: string; summary: string }, [string]>(
      "SELECT id, agent, summary FROM sessions WHERE job_run_id = ?",
    )
    .get(runId);

describe("KB digest runner", () => {
  test("a run that ends without digest_complete fails and keeps the watermark", async () => {
    const runId = newRun();
    await expect(
      runKbDigest(kbId, {
        runId,
        triggerBy: "ui",
        timeoutMs: 60_000,
        runAgent: async (run) => {
          prompts.push(run);
          return { trace: `worked on ${tokenOf(run.prompt)}`, runtimeId: "rt-1", error: null };
        },
      }),
    ).rejects.toThrow(/without digest_complete/);
    expect(digest()).toMatchObject({ last_status: "failed", last_success_at: null, token: null });
    expect(runSession(runId)?.summary).toContain("failed");
    const live = getSqlite()
      .query<{ status: string; summary: string }, [string]>(
        "SELECT status, summary FROM gateway_sessions WHERE id = ?",
      )
      .get(prompts[0]?.sessionId ?? "");
    expect(live?.status).toBe("error");
    // The claim token never reaches the stored trace.
    expect(live?.summary).toBe("worked on [digest claim]");
  });

  test("the prompt carries instructions, open comments and session summaries; completion moves the watermark", async () => {
    const runId = newRun();
    const note = await runKbDigest(kbId, {
      runId,
      triggerBy: "mcp",
      timeoutMs: 60_000,
      runAgent: async (run) => {
        prompts.push(run);
        new KbDigestStore(getSqlite()).complete(
          tokenOf(run.prompt),
          "applied",
          "added release notes",
          "codex",
        );
        return { trace: "done", runtimeId: null, error: null };
      },
    });
    expect(note).toBe("applied: added release notes");
    const run = prompts[0];
    expect(run?.backend).toBe("codex");
    expect(run?.prompt).toContain("Keep it current.");
    expect(run?.prompt).toContain("c1 by nir");
    expect(run?.prompt).toContain("Digest https://example.com/runbook");
    expect(run?.prompt).toContain("s1 (codex");
    expect(run?.prompt).toContain("never; this is the first run");
    expect(run?.prompt).toContain(`session_id "${run?.sessionId}"`);
    expect(digest()?.last_status).toBe("completed");
    expect(digest()?.last_success_at).not.toBeNull();
    expect(runSession(runId)).toMatchObject({ id: run?.sessionId, agent: "kb-digest" });
  });

  test("an agent error is the run's failure", async () => {
    await expect(
      runKbDigest(kbId, {
        runId: newRun(),
        triggerBy: "ui",
        timeoutMs: 60_000,
        runAgent: async () => ({ trace: "", runtimeId: null, error: "Digest timed out after 60s" }),
      }),
    ).rejects.toThrow("Digest timed out after 60s");
    expect(digest()?.last_note).toBe("Digest timed out after 60s");
  });

  test("a cron run with nothing new is skipped without starting an agent", async () => {
    getSqlite().query("UPDATE kb_comments SET status = 'resolved'").run();
    getSqlite()
      .query("UPDATE kb_digests SET last_success_at = ? WHERE kb_id = ?")
      .run(Date.now() + 1000, kbId);
    const runAgent = async () => {
      throw new Error("must not start");
    };
    expect(
      await runKbDigest(kbId, { runId: newRun(), triggerBy: "cron", timeoutMs: 60_000, runAgent }),
    ).toContain("Skipped");
    expect(digest()?.last_status).toBe("skipped");
  });

  test("a backend that cannot enforce the whitelist fails with how to fix it", async () => {
    getSqlite().query("UPDATE kb_digests SET backend = 'opencode' WHERE kb_id = ?").run(kbId);
    try {
      await expect(
        runKbDigest(kbId, { runId: newRun(), triggerBy: "manual", timeoutMs: 60_000 }),
      ).rejects.toThrow(/cannot enforce this digest's tool whitelist/);
      expect(digest()?.last_note).toContain("change the digest backend to");
      // Refusing before the session opens means no unrestricted digest agent ever runs.
      expect(digest()?.last_status).toBe("failed");
    } finally {
      getSqlite().query("UPDATE kb_digests SET backend = 'codex' WHERE kb_id = ?").run(kbId);
    }
  });

  // "claude" is a capable backend that often is not: its preflight can fail and the session
  // factory then runs the turn on acpx, which ignores the whitelist. The guard judges the backend
  // the run would get, so the note names it instead of the generic refusal. An unregistered name
  // reaches acpx the same way and is deterministic here.
  test("the refusal names the backend the run resolves to", async () => {
    getSqlite().query("UPDATE kb_digests SET backend = 'gemini' WHERE kb_id = ?").run(kbId);
    try {
      await expect(
        runKbDigest(kbId, { runId: newRun(), triggerBy: "manual", timeoutMs: 60_000 }),
      ).rejects.toThrow(/cannot enforce this digest's tool whitelist/);
      expect(digest()?.last_note).toContain('Digest backend "gemini", which runs on "acpx"');
      expect(digest()?.last_note).toContain("change the digest backend to");
    } finally {
      getSqlite().query("UPDATE kb_digests SET backend = 'codex' WHERE kb_id = ?").run(kbId);
    }
  });

  test("the executor runs a digest job as a digest, not a shell command", async () => {
    const runId = await executeJob({ jobId, triggerBy: "cron" });
    const run = getDb().select().from(job_runs).where(eq(job_runs.id, runId)).get();
    expect(run).toMatchObject({
      status: "success",
      stdout: "Skipped: no new input since the last run",
    });
  });
});
