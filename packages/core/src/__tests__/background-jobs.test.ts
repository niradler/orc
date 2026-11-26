import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBackgroundJob,
  listBackgroundJobs,
  readBackgroundJobLog,
  startBackgroundJob,
  stopBackgroundJob,
} from "../background-jobs.js";

async function waitFor<T>(fn: () => T | null, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for background job state.");
}

describe("background-jobs detached runner", () => {
  let root: string;
  let workDir: string;
  const startedIds: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orc-bg-jobs-"));
    workDir = join(root, "work");
    mkdirSync(workDir, { recursive: true });
    startedIds.length = 0;
  });

  afterEach(async () => {
    for (const id of startedIds) {
      await stopBackgroundJob(id, root, 500).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("runs detached command, writes logs and exact exit code 0", async () => {
    const started = startBackgroundJob(
      {
        command: 'echo "hello-stdout"; echo "hello-stderr" >&2',
        cwd: workDir,
        label: "echo test",
        session_id: "sess-1",
      },
      root,
    );
    startedIds.push(started.id);

    const done = await waitFor(() => {
      const current = getBackgroundJob(started.id, root);
      return current && current.status !== "running" ? current : null;
    });

    expect(done.status).toBe("completed");
    expect(done.exit_code).toBe(0);
    expect(done.signal).toBeNull();
    expect(done.finished_at).toBeGreaterThanOrEqual(done.started_at);

    const log = readBackgroundJobLog(started.id, {}, root);
    expect(log.text).toContain("hello-stdout");
    expect(log.text).toContain("hello-stderr");
    expect(log.truncated).toBe(false);
  });

  test("records non-zero exit code distinctly as failed", async () => {
    const started = startBackgroundJob({ command: 'echo "failing"; exit 42', cwd: workDir }, root);
    startedIds.push(started.id);

    const done = await waitFor(() => {
      const current = getBackgroundJob(started.id, root);
      return current && current.status !== "running" ? current : null;
    });

    expect(done.status).toBe("failed");
    expect(done.exit_code).toBe(42);
    expect(done.error).toContain("42");
    expect(readBackgroundJobLog(started.id, {}, root).text).toContain("failing");
  });

  test("stops a running detached process group cleanly", async () => {
    const started = startBackgroundJob(
      { command: 'echo "started"; sleep 30', cwd: workDir, session_id: "sess-stop" },
      root,
    );
    startedIds.push(started.id);

    await waitFor(() =>
      readBackgroundJobLog(started.id, {}, root).text.includes("started") ? true : null,
    );

    const stopped = await stopBackgroundJob(started.id, root, 1500);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.finished_at).not.toBeNull();
  });

  test("reconciles dead pid without exit file as interrupted_by_restart", () => {
    const id = "01JTESTDEADPID000000000000";
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "output.log");
    writeFileSync(log, "partial output before crash\n");
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id,
        label: "lost build",
        command: "bun run ci:pr",
        cwd: workDir,
        session_id: "sess-crash",
        project_id: null,
        status: "running",
        pid: 999_999_999,
        started_at: Date.now() - 10_000,
        finished_at: null,
        exit_code: null,
        signal: null,
        error: null,
        log_path: log,
      }),
    );

    const reconciled = getBackgroundJob(id, root);
    expect(reconciled?.status).toBe("interrupted_by_restart");
    expect(reconciled?.error).toContain("without recording a completion status");
    expect(readBackgroundJobLog(id, {}, root).text).toContain("partial output before crash");

    const listed = listBackgroundJobs({ session_id: "sess-crash" }, root);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("interrupted_by_restart");
  });
});
