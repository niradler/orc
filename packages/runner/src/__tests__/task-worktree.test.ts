import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackend, type SessionOpts } from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { projects, tasks } from "@orc/db/schema";
import { drainPendingNodes, reportNodeOutcome, startFlowForTask } from "../flow-runner.js";

const fixture = mkdtempSync(join(tmpdir(), "orc-task-worktree-"));
const repo = join(fixture, "repo");
const worktree = join(fixture, "task");
const starts: SessionOpts[] = [];
const projectId = ulid();

async function git(args: string[]): Promise<void> {
  execFileSync("git", args, { timeout: 15_000, stdio: "pipe" });
}

beforeAll(async () => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_SSH_HOST = "";
  resetConfig();
  createTestDb();
  await git(["init", repo]);
  await git([
    "-C",
    repo,
    "-c",
    "user.name=ORC Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await git(["-C", repo, "worktree", "add", "-b", "task", worktree]);
  await getDb()
    .insert(projects)
    .values({ id: projectId, name: `worktree-${projectId}`, scope: repo });
  registerBackend("worktree-test", () => ({
    name: "worktree-test",
    startSession: async (opts) => {
      starts.push(opts);
      return {
        id: ulid(),
        send: async () => {
          const row = getSqlite()
            .query(
              "SELECT task_id FROM gateway_sessions WHERE status = 'running' AND backend = 'worktree-test' ORDER BY rowid DESC LIMIT 1",
            )
            .get() as { task_id: string };
          await reportNodeOutcome({
            taskId: row.task_id,
            outcome: "submitted",
            summary: "Hello world",
          });
        },
        respondPermission: () => {},
        async *events() {
          yield { type: "result" as const, data: { runtimeSessionId: "native-worktree-test" } };
        },
        alive: () => false,
        close: async () => {},
      };
    },
    resumeSession: async () => {
      throw new Error("unexpected resume");
    },
    preflight: async () => ({ ok: true }),
    stop: async () => {},
  }));
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_SSH_HOST;
  resetConfig();
});

async function runTask(folder: string | null, repository: string = repo): Promise<string> {
  const id = ulid();
  await getDb().insert(tasks).values({
    id,
    title: "Hello world worktree test",
    project_id: projectId,
    git_repo: repository,
    git_worktree: folder,
    agent_backend: "worktree-test",
    skill_name: "orc-coder",
    required_review: false,
  });
  expect((await startFlowForTask(id)).ok).toBe(true);
  await drainPendingNodes();
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(id) as {
      status: string;
    };
    if (["done", "blocked", "paused"].includes(row.status)) return id;
    await Bun.sleep(10);
  }
  throw new Error("task did not finish within one second");
}

describe("task worktree launch", () => {
  test("should start the backend in the task worktree and persist it for terminal resume", async () => {
    const id = await runTask(worktree);
    expect(starts.at(-1)?.cwd).toBe(worktree);
    expect(
      getSqlite()
        .query("SELECT cwd, runtime_session_id FROM gateway_sessions WHERE task_id = ?")
        .get(id),
    ).toMatchObject({ cwd: worktree, runtime_session_id: "native-worktree-test" });
    expect(getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(id)).toMatchObject({
      status: "done",
    });
  });

  test("should block a missing worktree before starting an agent", async () => {
    const count = starts.length;
    const id = await runTask(join(fixture, "missing"));
    expect(starts).toHaveLength(count);
    expect(getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(id)).toMatchObject({
      status: "blocked",
    });
    expect(
      getSqlite()
        .query("SELECT error FROM flow_node_runs WHERE task_id = ? AND node_id = 'build'")
        .get(id),
    ).toMatchObject({ error: expect.stringContaining("worktree") });
  });

  test("should reject a worktree belonging to another repository", async () => {
    const other = join(fixture, "other");
    await git(["init", other]);
    const count = starts.length;
    const id = await runTask(worktree, other);
    expect(starts).toHaveLength(count);
    expect(getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(id)).toMatchObject({
      status: "blocked",
    });
  });

  test("should retain project scope when the task has no worktree", async () => {
    await runTask(null);
    expect(starts.at(-1)?.cwd).toBe(repo);
  });
});
