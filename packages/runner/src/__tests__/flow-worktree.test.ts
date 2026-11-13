import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackend } from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { projects, tasks } from "@orc/db/schema";
import {
  drainPendingNodes,
  getLatestFlowRunForTask,
  reportNodeOutcome,
  retireFlowWorktrees,
  startFlowForTask,
} from "../flow-runner.js";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "orc-flow-worktree-")));
const repo = join(fixture, "repo");
const projectId = ulid();
const gates = new Map<string, () => void>();
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { timeout: 15_000, stdio: "pipe" }).toString();

const flow = {
  name: "test-isolated",
  isolation: "worktree",
  entry: "start",
  nodes: {
    start: { kind: "gate", routing: "all" },
    a: { kind: "agent", skill: "orc-coder", backend: "flow-worktree-test", outcomes: ["ok"] },
    b: { kind: "agent", skill: "orc-coder", backend: "flow-worktree-test", outcomes: ["ok"] },
    join: { kind: "gate", join: { mode: "all", from: ["a", "b"] } },
    check: { kind: "agent", skill: "orc-coder", backend: "flow-worktree-test", outcomes: ["ok"] },
    done: { kind: "terminal", task_status: "done" },
  },
  edges: [
    { from: "start", to: "a" },
    { from: "start", to: "b" },
    { from: "a", to: "join", when: { always: true } },
    { from: "b", to: "join", when: { always: true } },
    { from: "join", to: "check", when: { always: true } },
    { from: "check", to: "done", when: { always: true } },
  ],
};

function worktrees(): string {
  try {
    return git("worktree", "list");
  } catch {
    return ".orc/worktrees";
  }
}

async function until<T>(read: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = read();
    if (value) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function nodeCwd(taskId: string, nodeId: string): string | undefined {
  return getLatestFlowRunForTask(taskId)?.nodes.find((node) => node.node_id === nodeId && node.cwd)
    ?.cwd as string | undefined;
}

async function finish(taskId: string, nodeId: string): Promise<void> {
  const cwd = await until(() => nodeCwd(taskId, nodeId), `${nodeId} running`);
  await reportNodeOutcome({ taskId, nodeId, outcome: "ok" });
  gates.get(cwd)?.();
  await until(
    () =>
      getLatestFlowRunForTask(taskId)?.nodes.find((node) => node.node_id === nodeId)?.status ===
        "succeeded" ||
      getLatestFlowRunForTask(taskId)?.nodes.find((node) => node.node_id === nodeId)?.ended_at,
    `${nodeId} ended`,
  );
}

beforeAll(async () => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_SSH_HOST = "";
  process.env.ORC_AGENT_LOOP_MAX_WORKERS = "4";
  resetConfig();
  createTestDb();
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  await getDb()
    .insert(projects)
    .values({ id: projectId, name: `flow-worktree-${projectId}`, scope: repo });
  registerBackend("flow-worktree-test", () => ({
    name: "flow-worktree-test",
    startSession: async (opts) => {
      let release = () => {};
      const gate = new Promise<void>((done) => {
        release = done;
      });
      gates.set(opts.cwd, release);
      return {
        id: ulid(),
        send: async () => {},
        respondPermission: () => {},
        async *events() {
          await gate;
          yield { type: "result" as const, data: { runtimeSessionId: ulid() } };
        },
        alive: () => false,
        close: async () => release(),
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
  for (const release of gates.values()) release();
  closeDb();
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_SSH_HOST;
  delete process.env.ORC_AGENT_LOOP_MAX_WORKERS;
  resetConfig();
  rmSync(fixture, { recursive: true, force: true });
});

describe("flow worktree isolation", () => {
  test("should give parallel nodes separate worktrees, hand one to the next node, and retire them on done", async () => {
    const taskId = ulid();
    await getDb().insert(tasks).values({
      id: taskId,
      title: "Isolated parallel work",
      project_id: projectId,
      skill_name: "orc-coder",
      required_review: false,
      flow_override: flow,
    });
    expect((await startFlowForTask(taskId)).ok).toBe(true);
    await drainPendingNodes();

    const a = await until(() => nodeCwd(taskId, "a"), "a cwd");
    const b = await until(() => nodeCwd(taskId, "b"), "b cwd");
    expect(a).toBe(join(repo, ".orc", "worktrees", `${taskId}-a`));
    expect(b).toBe(join(repo, ".orc", "worktrees", `${taskId}-b`));
    const listed = git("worktree", "list");
    // Git prints worktree paths with forward slashes on every platform.
    expect(listed.replace(/\\/g, "/")).toContain(`${a.replace(/\\/g, "/")} `);
    expect(listed).toContain(`[orc/task/${taskId}-a]`);
    expect(listed).toContain(`[orc/task/${taskId}-b]`);
    expect(
      getLatestFlowRunForTask(taskId)?.nodes.find((node) => node.node_id === "a")?.worktree_branch,
    ).toBe(`orc/task/${taskId}-a`);

    expect(git("config", `branch.orc/task/${taskId}-a.orc-base`).trim()).toBe(
      git("rev-parse", "main").trim(),
    );
    writeFileSync(join(a, "a.txt"), "from a");
    expect(existsSync(join(b, "a.txt"))).toBe(false);
    execFileSync("git", ["-C", a, "add", "a.txt"]);
    execFileSync("git", [
      "-C",
      a,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "a",
    ]);

    await finish(taskId, "b");
    await finish(taskId, "a");
    await drainPendingNodes();
    const check = await until(() => nodeCwd(taskId, "check"), "check cwd");
    expect(check).toBe(a);
    await finish(taskId, "check");

    await until(
      () =>
        (
          getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
            status: string;
          }
        ).status === "done",
      "task done",
    );
    await until(() => !worktrees().includes(".orc/worktrees"), "worktrees removed");
    expect(git("branch", "--list", "orc/task/*")).toContain(`orc/task/${taskId}-a`);
    expect(git("log", "--format=%s", `orc/task/${taskId}-a`)).toContain("a");
  });

  test("should start a fan-out lane from the last finished lane's commit, not the checkout HEAD", async () => {
    const fanOut = {
      name: "test-fan-out",
      isolation: "worktree",
      entry: "build",
      nodes: {
        build: {
          kind: "agent",
          skill: "orc-coder",
          backend: "flow-worktree-test",
          outcomes: ["ok"],
          routing: "all",
        },
        "review one": {
          kind: "agent",
          skill: "orc-coder",
          backend: "flow-worktree-test",
          outcomes: ["ok"],
        },
        review_two: {
          kind: "agent",
          skill: "orc-coder",
          backend: "flow-worktree-test",
          outcomes: ["ok"],
        },
        join: { kind: "gate", join: { mode: "all", from: ["review one", "review_two"] } },
        done: { kind: "terminal", task_status: "done" },
      },
      edges: [
        { from: "build", to: "review one", when: { always: true } },
        { from: "build", to: "review_two", when: { always: true } },
        { from: "review one", to: "join", when: { always: true } },
        { from: "review_two", to: "join", when: { always: true } },
        { from: "join", to: "done", when: { always: true } },
      ],
    };
    const taskId = ulid();
    await getDb().insert(tasks).values({
      id: taskId,
      title: "Fan-out reviewers",
      project_id: projectId,
      skill_name: "orc-coder",
      required_review: false,
      flow_override: fanOut,
    });
    expect((await startFlowForTask(taskId)).ok).toBe(true);
    await drainPendingNodes();
    const build = await until(() => nodeCwd(taskId, "build"), "build cwd");
    writeFileSync(join(build, "built.txt"), "built");
    execFileSync("git", ["-C", build, "add", "built.txt"]);
    execFileSync("git", [
      "-C",
      build,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "built",
    ]);
    await finish(taskId, "build");
    await drainPendingNodes();

    const one = await until(() => nodeCwd(taskId, "review one"), "review one cwd");
    const two = await until(() => nodeCwd(taskId, "review_two"), "review_two cwd");
    expect(new Set([one, two]).size).toBe(2);
    expect([one, two]).toContain(build);
    const fresh = one === build ? two : one;
    expect(fresh.startsWith(join(repo, ".orc", "worktrees", taskId))).toBe(true);
    expect(fresh).not.toContain(" ");
    expect(existsSync(join(fresh, "built.txt"))).toBe(true);

    await finish(taskId, "review one");
    await finish(taskId, "review_two");
    await until(() => !worktrees().includes(".orc/worktrees"), "fan-out trees removed");
  });

  test("should continue a reopened task on its kept lane branch, inside the project's subfolder, and clean up once", async () => {
    execFileSync("mkdir", ["-p", join(repo, "pkg")]);
    writeFileSync(join(repo, "pkg", "keep.txt"), "x");
    git("add", "pkg");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pkg");
    const subProject = ulid();
    await getDb()
      .insert(projects)
      .values({
        id: subProject,
        name: `flow-worktree-sub-${subProject}`,
        scope: join(repo, "pkg"),
      });
    const single = {
      name: "test-single",
      isolation: "worktree",
      entry: "work",
      nodes: {
        work: {
          kind: "agent",
          skill: "orc-coder",
          backend: "flow-worktree-test",
          outcomes: ["ok"],
        },
        done: { kind: "terminal", task_status: "done" },
      },
      edges: [{ from: "work", to: "done", when: { always: true } }],
    };
    const taskId = ulid();
    await getDb().insert(tasks).values({
      id: taskId,
      title: "Reopened",
      project_id: subProject,
      skill_name: "orc-coder",
      required_review: false,
      flow_override: single,
    });
    expect((await startFlowForTask(taskId)).ok).toBe(true);
    await drainPendingNodes();
    const lane = join(repo, ".orc", "worktrees", `${taskId}-work`);
    const first = await until(() => nodeCwd(taskId, "work"), "first cwd");
    expect(first).toBe(join(lane, "pkg"));
    writeFileSync(join(first, "round1.txt"), "one");
    execFileSync("git", ["-C", first, "add", "round1.txt"]);
    execFileSync("git", [
      "-C",
      first,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "round 1",
    ]);
    await finish(taskId, "work");
    await until(() => !worktrees().includes(`${taskId}-work`), "first lane removed");

    const comments = () =>
      (
        getSqlite()
          .query(
            "SELECT COUNT(*) AS n FROM comments WHERE resource_type = 'task' AND resource_id = ? AND content LIKE 'Kept the flow worktree%'",
          )
          .get(taskId) as { n: number }
      ).n;
    expect(comments()).toBe(0);

    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "master moved",
    );
    getSqlite()
      .query("UPDATE tasks SET status = 'todo', claimed_by = NULL WHERE id = ?")
      .run(taskId);
    expect((await startFlowForTask(taskId)).ok).toBe(true);
    await drainPendingNodes();
    const second = await until(
      () =>
        getLatestFlowRunForTask(taskId)?.nodes.find(
          (node) => node.node_id === "work" && node.status === "running",
        )?.cwd as string | undefined,
      "second cwd",
    );
    expect(second).toBe(join(lane, "pkg"));
    expect(existsSync(join(second, "round1.txt"))).toBe(true);
    expect(
      getLatestFlowRunForTask(taskId)?.nodes.find((node) => node.node_id === "work")
        ?.worktree_branch,
    ).toBe(`orc/task/${taskId}-work`);
    await finish(taskId, "work");
    await Promise.all([retireFlowWorktrees(taskId), retireFlowWorktrees(taskId)]);
    await until(() => !worktrees().includes(`${taskId}-work`), "second lane removed");
    expect(comments()).toBe(0);
  }, 20_000);
});
