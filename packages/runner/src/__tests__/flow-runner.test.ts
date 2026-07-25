import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { tasks } from "@orc/db/schema";
import { updateTaskStatus } from "@orc/task-service";
import { eq } from "drizzle-orm";
import {
  cancelFlowRun,
  finishNodeRun,
  getActiveFlowRunForTask,
  getLatestFlowRunForTask,
  onTaskStatusChangedExternally,
  reportNodeOutcome,
  resumeHumanNode,
  startFlowForTask,
  sweepFlowTimeouts,
} from "../flow-runner.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_AGENT_LOOP_ENABLED = "true";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_AGENT_LOOP_ENABLED;
  resetConfig();
});

type NodeRunRow = {
  id: string;
  node_id: string;
  node_kind: string;
  attempt: number;
  retry: number;
  status: string;
  outcome: string | null;
};

async function makeTask(overrides?: Partial<typeof tasks.$inferInsert>): Promise<string> {
  const id = ulid();
  const now = new Date();
  await getDb()
    .insert(tasks)
    .values({
      id,
      title: "Flow test task",
      body: "Do the thing",
      status: "todo",
      priority: "normal",
      author: "human",
      skill_name: "orc-coder",
      required_review: true,
      max_review_rounds: 3,
      created_at: now,
      updated_at: now,
      ...overrides,
    });
  return id;
}

function nodeRuns(taskId: string): NodeRunRow[] {
  return getSqlite()
    .query(
      `SELECT id, node_id, node_kind, attempt, retry, status, outcome FROM flow_node_runs
       WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .all(taskId) as NodeRunRow[];
}

function activeNodeRun(taskId: string, nodeId?: string): NodeRunRow {
  const rows = nodeRuns(taskId).filter(
    (r) =>
      ["pending", "running", "awaiting_human"].includes(r.status) &&
      (!nodeId || r.node_id === nodeId),
  );
  const row = rows[0];
  if (!row)
    throw new Error(`no active node run${nodeId ? ` for ${nodeId}` : ""} on task ${taskId}`);
  return row;
}

function taskStatus(taskId: string): string {
  const row = getSqlite().query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
    status: string;
  } | null;
  if (!row) throw new Error("task vanished");
  return row.status;
}

/** Resolve the node the way a real session does: report, then end the session. */
async function completeNode(
  taskId: string,
  outcome: string,
  opts?: { nodeId?: string; vars?: Record<string, unknown> },
): Promise<void> {
  const node = activeNodeRun(taskId, opts?.nodeId);
  const reported = await reportNodeOutcome({
    taskId,
    nodeId: node.node_id,
    outcome,
    summary: `did the ${node.node_id} work`,
    ...(opts?.vars ? { vars: opts.vars } : {}),
  });
  if (!reported.ok) throw new Error(`report failed: ${reported.error}`);
  // A human node advances on report; an agent node advances when its session ends.
  if (node.status !== "awaiting_human") await finishNodeRun(node.id, null);
}

describe("startFlowForTask", () => {
  test("starts orc-default, claims the task, and queues the entry node", async () => {
    const taskId = await makeTask();
    const result = await startFlowForTask(taskId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flowName).toBe("orc-default");

    const run = getActiveFlowRunForTask(taskId);
    expect(run?.flow_name).toBe("orc-default");
    expect(run?.status).toBe("running");

    // The task is claimed by the run so the loop cannot start a second one.
    const claimed = getSqlite().query("SELECT claimed_by FROM tasks WHERE id = ?").get(taskId) as {
      claimed_by: string | null;
    };
    expect(claimed.claimed_by).toBe(result.flowRunId);

    const runs = nodeRuns(taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ node_id: "build", node_kind: "agent", status: "pending" });
    // The node inherits the task's skill via the $task.skill_name placeholder.
    const skill = getSqlite()
      .query("SELECT skill_name FROM flow_node_runs WHERE id = ?")
      .get(runs[0]?.id ?? "") as { skill_name: string | null };
    expect(skill.skill_name).toBe("orc-coder");
  });

  test("refuses a second concurrent run for the same task", async () => {
    const taskId = await makeTask();
    expect((await startFlowForTask(taskId)).ok).toBe(true);
    const second = await startFlowForTask(taskId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("already has a running flow");
  });

  test("an unknown flow name blocks the task instead of failing silently", async () => {
    const taskId = await makeTask({ flow_name: "does-not-exist" });
    const result = await startFlowForTask(taskId);
    expect(result.ok).toBe(false);
    expect(taskStatus(taskId)).toBe("blocked");
    const comments = getSqlite()
      .query("SELECT content FROM comments WHERE resource_id = ?")
      .all(taskId) as { content: string }[];
    expect(comments.some((c) => c.content.includes("Flow not found"))).toBe(true);
  });

  test("an invalid inline flow blocks the task with the validation errors", async () => {
    const taskId = await makeTask({
      flow_override: { name: "broken", entry: "nope", nodes: {}, edges: [] },
    });
    const result = await startFlowForTask(taskId);
    expect(result.ok).toBe(false);
    expect(taskStatus(taskId)).toBe("blocked");
  });
});

describe("orc-default end to end", () => {
  test("build → review → approved leaves the task done and the run completed", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);

    await completeNode(taskId, "submitted");
    // The review node is queued but has no session yet, so the task is `queued`
    // rather than claiming to be under review. It becomes `review` when the
    // reviewer actually starts (spawnNodeSession).
    expect(taskStatus(taskId)).toBe("queued");
    expect(activeNodeRun(taskId).node_id).toBe("review");

    await completeNode(taskId, "approved");

    expect(taskStatus(taskId)).toBe("done");
    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("completed");
    expect(run?.active).toEqual([]);

    // The ledger holds every node visit, including the gate the graph passed
    // through and the terminal it ended on.
    const ledger = nodeRuns(taskId);
    expect(ledger.map((r) => r.node_id)).toEqual(["build", "review_gate", "review", "done"]);
    expect(ledger.every((r) => r.status === "succeeded")).toBe(true);

    // And the task is released.
    const claimed = getSqlite().query("SELECT claimed_by FROM tasks WHERE id = ?").get(taskId) as {
      claimed_by: string | null;
    };
    expect(claimed.claimed_by).toBeNull();
  });

  test("changes_requested loops back to build and re-queues it with a fresh attempt", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);

    await completeNode(taskId, "submitted");
    await completeNode(taskId, "changes_requested");

    // Queued for rework — `doing` only once the worker session is up.
    expect(taskStatus(taskId)).toBe("queued");
    const rebuild = activeNodeRun(taskId);
    expect(rebuild).toMatchObject({ node_id: "build", attempt: 2, status: "pending" });

    const run = getLatestFlowRunForTask(taskId);
    expect(run?.visits.build).toBe(2);
    expect(run?.status).toBe("running");
  });

  test("running out of review rounds pauses the task for a human", async () => {
    const taskId = await makeTask({ max_review_rounds: 2 });
    await startFlowForTask(taskId);

    // max_review_rounds 2 → build twice, then escalate.
    await completeNode(taskId, "submitted");
    await completeNode(taskId, "changes_requested");
    await completeNode(taskId, "submitted");
    await completeNode(taskId, "changes_requested");

    expect(taskStatus(taskId)).toBe("paused");
    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("completed");
    expect(run?.visits.build).toBe(2);
    expect(nodeRuns(taskId).some((r) => r.node_id === "escalated")).toBe(true);
  });

  test("required_review=false skips review entirely", async () => {
    const taskId = await makeTask({ required_review: false });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted");

    expect(taskStatus(taskId)).toBe("done");
    expect(nodeRuns(taskId).some((r) => r.node_id === "review")).toBe(false);
  });

  test("a node that dies routes through on_error", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const build = activeNodeRun(taskId);

    await finishNodeRun(build.id, "agent crashed");

    // build.on_error = blocked → the blocked terminal, not an opaque halt.
    expect(taskStatus(taskId)).toBe("blocked");
    const failed = nodeRuns(taskId).find((r) => r.node_id === "build");
    expect(failed?.status).toBe("failed");
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("completed");
  });

  test("a node that never reports has its outcome inferred from the task status", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const build = activeNodeRun(taskId);

    // The old protocol: the agent moves the task itself and never calls flow_report.
    await updateTaskStatus({ taskId, status: "review", author: "agent" });
    await finishNodeRun(build.id, null);

    const inferred = nodeRuns(taskId).find((r) => r.node_id === "build");
    expect(inferred?.outcome).toBe("submitted");
    expect(activeNodeRun(taskId).node_id).toBe("review");
  });

  test("an outcome the node cannot route is rejected rather than halting the flow", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const result = await reportNodeOutcome({ taskId, nodeId: "build", outcome: "banana" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not routable");
    // The node is untouched and still waiting.
    expect(activeNodeRun(taskId)).toMatchObject({ node_id: "build", outcome: null });
  });

  test("reporting without a node id is rejected while several nodes are active", async () => {
    const taskId = await makeTask({ flow_name: "orc-parallel-review" });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted", { nodeId: "build" });

    const ambiguous = await reportNodeOutcome({ taskId, outcome: "reviewed" });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) return;
    expect(ambiguous.error).toContain("pass the node id");
  });
});

describe("a verdict survives a session that dies after reporting it", () => {
  test("a reported outcome beats the session error", async () => {
    // The common trigger is not exotic: the Claude adapter emits an `error`
    // event for any final result with is_error, which includes
    // error_max_turns. A worker that reported `submitted` and then ran out of
    // turns has still done the work and said so.
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const build = activeNodeRun(taskId);

    await reportNodeOutcome({ taskId, nodeId: "build", outcome: "submitted", summary: "done" });
    await finishNodeRun(build.id, "error_max_turns");

    // Routed on the report, not on build.on_error (which would be `blocked`).
    expect(taskStatus(taskId)).not.toBe("blocked");
    expect(activeNodeRun(taskId).node_id).toBe("review");

    // The failure is still on the record for whoever reads the ledger.
    const row = nodeRuns(taskId).find((r) => r.node_id === "build");
    expect(row?.outcome).toBe("submitted");
    expect(row?.status).toBe("succeeded");
    const err = getSqlite()
      .query("SELECT error FROM flow_node_runs WHERE id = ?")
      .get(build.id) as { error: string | null };
    expect(err.error).toBe("error_max_turns");
  });

  test("an approved review is not thrown away by a tail error", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted");

    const review = activeNodeRun(taskId);
    await reportNodeOutcome({ taskId, nodeId: "review", outcome: "approved" });
    await finishNodeRun(review.id, "error_max_turns");

    expect(taskStatus(taskId)).toBe("done");
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("completed");
  });

  test("a session error with no reported outcome still routes on_error", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const build = activeNodeRun(taskId);
    await finishNodeRun(build.id, "agent crashed");
    expect(taskStatus(taskId)).toBe("blocked");
  });
});

describe("recovery from infrastructure failure", () => {
  test("a reaped node is retried in place rather than routed to on_error", async () => {
    // The old loop reset a timed-out worker's task to `todo` so the next cycle
    // retried it. Routing on_error instead would end orc-default at `blocked`
    // on the first network blip and never come back.
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const build = activeNodeRun(taskId);

    const { cleanupStaleFlowSessions } = await import("../flow-runner.js");
    // Give the node a session and backdate it past the idle cutoff.
    const sessionId = ulid();
    const stale = Math.floor(Date.now() / 1000) - 100_000;
    getSqlite()
      .query(
        `INSERT INTO gateway_sessions (id, chat_id, backend, mode, status, role, task_id, last_activity_at, created_at, updated_at)
         VALUES (?, '__task-loop__', 'claude', 'agent:claude', 'running', 'worker', ?, ?, ?, ?)`,
      )
      .run(sessionId, taskId, stale, stale, stale);
    getSqlite()
      .query("UPDATE flow_node_runs SET status = 'running', gateway_session_id = ? WHERE id = ?")
      .run(sessionId, build.id);

    expect(await cleanupStaleFlowSessions()).toBe(1);

    // Same node, same graph visit, new session — retries have their own
    // coordinate so a later visit to this node cannot collide with them.
    const retry = activeNodeRun(taskId);
    expect(retry).toMatchObject({ node_id: "build", attempt: 1, retry: 1, status: "pending" });
    expect(taskStatus(taskId)).not.toBe("blocked");
    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("running");
    // A retry is not a graph visit, so it must not consume the loop budget.
    expect(run?.visits.build).toBe(1);
  });

  test("retries are bounded, then the graph is told it failed", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const { cleanupStaleFlowSessions } = await import("../flow-runner.js");

    // max_node_retries defaults to 2 → attempts 1,2,3 then on_error.
    for (let round = 0; round < 4; round++) {
      const node = nodeRuns(taskId).find((r) => ["pending", "running"].includes(r.status));
      if (!node) break;
      const sessionId = ulid();
      const stale = Math.floor(Date.now() / 1000) - 100_000;
      getSqlite()
        .query(
          `INSERT INTO gateway_sessions (id, chat_id, backend, mode, status, role, task_id, last_activity_at, created_at, updated_at)
           VALUES (?, '__task-loop__', 'claude', 'agent:claude', 'running', 'worker', ?, ?, ?, ?)`,
        )
        .run(sessionId, taskId, stale, stale, stale);
      getSqlite()
        .query("UPDATE flow_node_runs SET status = 'running', gateway_session_id = ? WHERE id = ?")
        .run(sessionId, node.id);
      await cleanupStaleFlowSessions();
    }

    const attempts = nodeRuns(taskId).filter((r) => r.node_id === "build");
    expect(attempts).toHaveLength(3);
    expect(attempts.map((r) => r.retry)).toEqual([0, 1, 2]);
    // Budget spent → on_error routed → orc-default's blocked terminal.
    expect(taskStatus(taskId)).toBe("blocked");
  });

  test("a node that was retried can still be revisited by the graph", async () => {
    // Retries and graph visits used to share the `attempt` column, so a node
    // that was retried and then revisited collided on the unique index — the
    // insert was swallowed and the run was left with an active node that had no
    // row to drive it, stalling until the 4h wall clock.
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const { cleanupStaleFlowSessions } = await import("../flow-runner.js");

    const reapCurrentNode = async () => {
      const node = nodeRuns(taskId).find((r) => ["pending", "running"].includes(r.status));
      if (!node) throw new Error("expected a live node");
      const sessionId = ulid();
      const stale = Math.floor(Date.now() / 1000) - 100_000;
      getSqlite()
        .query(
          `INSERT INTO gateway_sessions (id, chat_id, backend, mode, status, role, task_id, last_activity_at, created_at, updated_at)
           VALUES (?, '__task-loop__', 'claude', 'agent:claude', 'running', 'worker', ?, ?, ?, ?)`,
        )
        .run(sessionId, taskId, stale, stale, stale);
      getSqlite()
        .query("UPDATE flow_node_runs SET status = 'running', gateway_session_id = ? WHERE id = ?")
        .run(sessionId, node.id);
      await cleanupStaleFlowSessions();
    };

    await reapCurrentNode(); // build visit 1 gets a retry
    await completeNode(taskId, "submitted"); // the retry succeeds
    await completeNode(taskId, "changes_requested"); // review sends it back

    // The graph's second visit to build must have a live row of its own.
    const rebuild = activeNodeRun(taskId);
    expect(rebuild).toMatchObject({ node_id: "build", attempt: 2, retry: 0, status: "pending" });
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("running");
    expect(getLatestFlowRunForTask(taskId)?.visits.build).toBe(2);
  });
});

describe("cross-run rail", () => {
  test("a reject-loop flow cannot restart forever", async () => {
    // orc-review-only's `rejected` terminal sets changes_requested, which makes
    // the task eligible again. Per-run rails cannot see a loop made of runs.
    const taskId = await makeTask({ flow_name: "orc-review-only" });
    let started = 0;
    for (let round = 0; round < 10; round++) {
      const result = await startFlowForTask(taskId);
      if (!result.ok) break;
      started++;
      await completeNode(taskId, "changes_requested");
    }
    // Default max_flow_runs_per_task is 6.
    expect(started).toBe(6);
    expect(taskStatus(taskId)).toBe("paused");
    const comments = getSqlite()
      .query("SELECT content FROM comments WHERE resource_id = ?")
      .all(taskId) as { content: string }[];
    expect(comments.some((c) => c.content.includes("not converging"))).toBe(true);
  });
});

describe("queued node visibility", () => {
  test("a task is queued, not doing, until its node's session actually starts", async () => {
    // Otherwise the board shows N tasks in progress while max_workers allows one.
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    expect(activeNodeRun(taskId).status).toBe("pending");
    expect(taskStatus(taskId)).toBe("queued");
  });
});

describe("fan-out", () => {
  test("orc-parallel-review queues three reviewers and joins on all of them", async () => {
    const taskId = await makeTask({ flow_name: "orc-parallel-review" });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted", { nodeId: "build" });

    const pending = nodeRuns(taskId).filter((r) => r.status === "pending");
    expect(pending.map((r) => r.node_id).sort()).toEqual([
      "review_correctness",
      "review_security",
      "review_tests",
    ]);

    await completeNode(taskId, "reviewed", {
      nodeId: "review_correctness",
      vars: { correctness_ok: true },
    });
    // Still parked at the join — nothing new queued.
    expect(nodeRuns(taskId).filter((r) => r.status === "pending")).toHaveLength(2);

    await completeNode(taskId, "reviewed", {
      nodeId: "review_security",
      vars: { security_ok: true },
    });
    await completeNode(taskId, "reviewed", { nodeId: "review_tests", vars: { tests_ok: true } });

    expect(taskStatus(taskId)).toBe("done");
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("completed");
  });

  test("two branches spawning successors at the same moment both survive", async () => {
    // Each branch's completion spawns a successor whose task_status differs from
    // the current one, so applying the step awaits a task transition. Without
    // per-task serialization both branches read the same state across that await
    // and the second write drops the first's spawned node from `active`, leaving
    // the join permanently unsatisfiable.
    const raceFlow = {
      name: "test-spawn-race",
      entry: "start",
      nodes: {
        start: { kind: "gate", routing: "all" },
        a: { kind: "agent", skill: "orc-coder", outcomes: ["ok"] },
        b: { kind: "agent", skill: "orc-coder", outcomes: ["ok"] },
        a2: { kind: "agent", skill: "orc-coder", task_status: "review", outcomes: ["ok"] },
        b2: { kind: "agent", skill: "orc-coder", task_status: "doing", outcomes: ["ok"] },
        join: { kind: "gate", join: { mode: "all", from: ["a2", "b2"] } },
        done: { kind: "terminal", task_status: "done" },
      },
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "a2", when: { always: true } },
        { from: "b", to: "b2", when: { always: true } },
        { from: "a2", to: "join", when: { always: true } },
        { from: "b2", to: "join", when: { always: true } },
        { from: "join", to: "done", when: { always: true } },
      ],
    };

    const taskId = await makeTask({ flow_override: raceFlow });
    await startFlowForTask(taskId);

    const first = nodeRuns(taskId).filter((r) => r.status === "pending");
    expect(first.map((r) => r.node_id).sort()).toEqual(["a", "b"]);

    await Promise.all(
      first.map(async (branch) => {
        await reportNodeOutcome({ taskId, nodeId: branch.node_id, outcome: "ok" });
        await finishNodeRun(branch.id, null);
      }),
    );

    // Both successors must be queued — this is what a lost update would break.
    const second = nodeRuns(taskId).filter((r) => r.status === "pending");
    expect(second.map((r) => r.node_id).sort()).toEqual(["a2", "b2"]);
    expect(
      getLatestFlowRunForTask(taskId)
        ?.active.map((a) => a.nodeId)
        .sort(),
    ).toEqual(["a2", "b2"]);

    await Promise.all(
      second.map(async (branch) => {
        await reportNodeOutcome({ taskId, nodeId: branch.node_id, outcome: "ok" });
        await finishNodeRun(branch.id, null);
      }),
    );

    expect(getLatestFlowRunForTask(taskId)?.status).toBe("completed");
    expect(taskStatus(taskId)).toBe("done");
  });

  test("branches finishing simultaneously do not clobber each other's state", async () => {
    const taskId = await makeTask({ flow_name: "orc-parallel-review" });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted", { nodeId: "build" });

    const branches = nodeRuns(taskId).filter((r) => r.status === "pending");
    expect(branches).toHaveLength(3);
    const okVar: Record<string, string> = {
      review_correctness: "correctness_ok",
      review_security: "security_ok",
      review_tests: "tests_ok",
    };

    // All three report and end at once. Without per-task serialization each
    // would read the same flow state and the last write would win, losing two
    // join arrivals and resurrecting finished nodes.
    await Promise.all(
      branches.map(async (branch) => {
        await reportNodeOutcome({
          taskId,
          nodeId: branch.node_id,
          outcome: "reviewed",
          vars: { [okVar[branch.node_id] as string]: true },
        });
        await finishNodeRun(branch.id, null);
      }),
    );

    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("completed");
    expect(run?.active).toEqual([]);
    expect(taskStatus(taskId)).toBe("done");
    // Every branch is accounted for exactly once, and the join fired once.
    expect(nodeRuns(taskId).filter((r) => r.node_id.startsWith("review_"))).toHaveLength(3);
    expect(nodeRuns(taskId).filter((r) => r.node_id === "verdict")).toHaveLength(1);
    expect(nodeRuns(taskId).every((r) => r.status === "succeeded")).toBe(true);
  });

  test("one failing branch sends the work back to build", async () => {
    const taskId = await makeTask({ flow_name: "orc-parallel-review" });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted", { nodeId: "build" });

    await completeNode(taskId, "reviewed", {
      nodeId: "review_correctness",
      vars: { correctness_ok: true },
    });
    await completeNode(taskId, "reviewed", {
      nodeId: "review_security",
      vars: { security_ok: false },
    });
    await completeNode(taskId, "reviewed", { nodeId: "review_tests", vars: { tests_ok: true } });

    const rebuild = activeNodeRun(taskId);
    expect(rebuild).toMatchObject({ node_id: "build", attempt: 2 });
    // Verdict vars were cleared on re-entry, so last round's passes cannot carry over.
    const run = getLatestFlowRunForTask(taskId);
    expect(run?.vars.correctness_ok).toBeNull();
    expect(run?.vars.security_ok).toBeNull();
  });
});

describe("human nodes", () => {
  const gatedFlow = {
    name: "test-human-gate",
    description: "Build, then a human decides",
    entry: "build",
    nodes: {
      build: {
        kind: "agent",
        skill: "orc-coder",
        task_status: "doing",
        outcomes: ["submitted"],
        on_error: "failed",
      },
      sign_off: {
        kind: "human",
        prompt: "Approve the change or send it back.",
        task_status: "review",
        outcomes: ["approved", "changes_requested"],
      },
      done: { kind: "terminal", task_status: "done" },
      rework: { kind: "terminal", task_status: "changes_requested" },
      escalated: { kind: "terminal", task_status: "paused" },
    },
    edges: [
      { from: "build", to: "sign_off", when: { outcome: "submitted" } },
      { from: "build", to: "escalated", when: { always: true } },
      { from: "sign_off", to: "done", when: { outcome: "approved" } },
      { from: "sign_off", to: "rework", when: { outcome: "changes_requested" } },
    ],
  };

  test("a human node waits, records what to do, and resumes on a verdict", async () => {
    const taskId = await makeTask({ flow_override: gatedFlow });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted", { nodeId: "build" });

    const waiting = activeNodeRun(taskId);
    expect(waiting).toMatchObject({
      node_id: "sign_off",
      node_kind: "human",
      status: "awaiting_human",
    });
    expect(taskStatus(taskId)).toBe("review");

    const comments = getSqlite()
      .query("SELECT content FROM comments WHERE resource_id = ?")
      .all(taskId) as { content: string }[];
    expect(comments.some((c) => c.content.includes("waiting for a human"))).toBe(true);

    const resumed = await resumeHumanNode({
      taskId,
      outcome: "approved",
      summary: "looks good",
      author: "human",
    });
    expect(resumed.ok).toBe(true);
    expect(taskStatus(taskId)).toBe("done");
  });

  test("resuming when nothing is waiting is an error, not a no-op", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    const result = await resumeHumanNode({ taskId, outcome: "approved" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("No node is waiting");
  });

  test("a human requesting changes out of band resolves the waiting node", async () => {
    const taskId = await makeTask({ flow_override: gatedFlow });
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted", { nodeId: "build" });

    await onTaskStatusChangedExternally(taskId, "changes_requested");

    expect(getLatestFlowRunForTask(taskId)?.status).toBe("completed");
    expect(taskStatus(taskId)).toBe("changes_requested");
  });
});

describe("human authority", () => {
  test("a human closing a task with a merely queued node still stops the flow", async () => {
    // The guard used to key on node status, so a human closing a task whose node
    // was queued (the common case at max_workers 1) was silently ignored and an
    // agent was later spawned on work they had closed.
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    expect(activeNodeRun(taskId).status).toBe("pending");

    await updateTaskStatus({ taskId, status: "done", author: "human" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getLatestFlowRunForTask(taskId)?.status).toBe("cancelled");
    expect(nodeRuns(taskId).every((r) => r.status === "cancelled")).toBe(true);
  });

  test("a human blocking a task stops the flow too", async () => {
    // `blocked` and `paused` are how a human says "hold off"; they were not even
    // reported to the flow before.
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    await updateTaskStatus({ taskId, status: "blocked", author: "human" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("cancelled");
  });

  test("an agent moving the task is the in-flow protocol, not interference", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    await updateTaskStatus({ taskId, status: "review", author: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getActiveFlowRunForTask(taskId)).not.toBeNull();
  });
});

describe("human gates and the wall clock", () => {
  const gate = {
    name: "test-gate-clock",
    entry: "sign_off",
    limits: { execution_timeout_secs: 3600 },
    nodes: {
      sign_off: {
        kind: "human",
        prompt: "Approve?",
        task_status: "review",
        outcomes: ["approved"],
      },
      done: { kind: "terminal", task_status: "done" },
    },
    edges: [{ from: "sign_off", to: "done", when: { outcome: "approved" } }],
  };

  test("a gate that waited longer than the timeout is not killed by it", async () => {
    const taskId = await makeTask({ flow_override: gate });
    const started = await startFlowForTask(taskId);
    if (!started.ok) throw new Error("expected a run");
    expect(activeNodeRun(taskId).status).toBe("awaiting_human");

    // Backdate both the run and the gate: a human took two hours on a flow whose
    // agent budget is one.
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    getSqlite()
      .query("UPDATE flow_runs SET started_at = ? WHERE id = ?")
      .run(twoHoursAgo, started.flowRunId);
    getSqlite()
      .query("UPDATE flow_node_runs SET created_at = ? WHERE task_id = ?")
      .run(twoHoursAgo, taskId);

    // The sweep must not reap a run that is only waiting on a person.
    expect(await sweepFlowTimeouts()).toBe(0);

    // And answering still works, because the wait was charged to paused_secs.
    const resumed = await resumeHumanNode({ taskId, outcome: "approved", author: "human" });
    expect(resumed.ok).toBe(true);
    expect(taskStatus(taskId)).toBe("done");
  });
});

describe("cross-run budget accounting", () => {
  test("runs a human cancelled do not count toward the budget", async () => {
    // Attaching and halting repeatedly is not a flow failing to converge, and
    // counting those runs parked tasks nobody had looped.
    const taskId = await makeTask();
    const { haltFlowRunForTask } = await import("../flow-runner.js");
    for (let i = 0; i < 8; i++) {
      const started = await startFlowForTask(taskId);
      expect(started.ok, `attach ${i + 1} should be allowed`).toBe(true);
      await haltFlowRunForTask(taskId, "operator stopped it");
    }
    expect(taskStatus(taskId)).not.toBe("paused");
  });

  test("a human comment forgives the budget so a parked task can be restarted", async () => {
    const taskId = await makeTask({ flow_name: "orc-review-only" });
    for (let i = 0; i < 6; i++) {
      const result = await startFlowForTask(taskId);
      if (!result.ok) break;
      await completeNode(taskId, "changes_requested");
    }
    expect((await startFlowForTask(taskId)).ok).toBe(false);
    expect(taskStatus(taskId)).toBe("paused");

    // A human weighing in resets the budget — otherwise the park is permanent
    // and every cycle appends another "not converging" comment.
    const { addTaskComment } = await import("@orc/task-service");
    await addTaskComment(taskId, "Rebased on main, try again", "human");
    await getDb()
      .update(tasks)
      .set({ status: "todo", claimed_by: null })
      .where(eq(tasks.id, taskId));

    expect((await startFlowForTask(taskId)).ok).toBe(true);
  });
});

describe("external interference", () => {
  test("cancelling a task cancels its flow and kills queued nodes", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);

    await onTaskStatusChangedExternally(taskId, "cancelled");

    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("cancelled");
    expect(nodeRuns(taskId).every((r) => r.status === "cancelled")).toBe(true);
    const claimed = getSqlite().query("SELECT claimed_by FROM tasks WHERE id = ?").get(taskId) as {
      claimed_by: string | null;
    };
    expect(claimed.claimed_by).toBeNull();
  });

  test("a status change routed through the task service reaches the flow", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);

    await updateTaskStatus({ taskId, status: "cancelled", author: "human" });
    // The hook is fired without awaiting, so let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getLatestFlowRunForTask(taskId)?.status).toBe("cancelled");
  });

  test("the flow's own transitions do not cancel the run", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    await completeNode(taskId, "submitted");
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The flow moved the task itself — that must not read as interference.
    expect(getActiveFlowRunForTask(taskId)).not.toBeNull();
    expect(taskStatus(taskId)).toBe("queued");
  });

  test("cancelFlowRun releases the task and stops every node", async () => {
    const taskId = await makeTask();
    const started = await startFlowForTask(taskId);
    if (!started.ok) throw new Error("expected a run");

    await cancelFlowRun(started.flowRunId, "manual stop");

    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("cancelled");
    expect(run?.halt_reason).toBe("manual stop");
  });
});

describe("sweepFlowTimeouts", () => {
  beforeEach(() => {
    getSqlite().query("DELETE FROM flow_runs").run();
  });

  test("halts a run that blew its wall clock and pauses the task", async () => {
    const taskId = await makeTask();
    const started = await startFlowForTask(taskId);
    if (!started.ok) throw new Error("expected a run");

    // orc-default allows 4h; backdate the run well past it.
    getSqlite()
      .query("UPDATE flow_runs SET started_at = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) - 20_000, started.flowRunId);

    expect(await sweepFlowTimeouts()).toBe(1);

    const run = getLatestFlowRunForTask(taskId);
    expect(run?.status).toBe("halted");
    expect(run?.halt_reason).toBe("execution_timeout");
    expect(taskStatus(taskId)).toBe("paused");
    expect(nodeRuns(taskId).find((r) => r.node_id === "build")?.status).toBe("cancelled");
  });

  test("leaves healthy runs alone", async () => {
    const taskId = await makeTask();
    await startFlowForTask(taskId);
    expect(await sweepFlowTimeouts()).toBe(0);
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("running");
  });
});

describe("task eligibility", () => {
  test("a task with only a flow_name is picked up by the loop", async () => {
    const taskId = await makeTask({ skill_name: null, flow_name: "orc-plan-build-verify" });
    const { OrcTaskProvider } = await import("../orc-task-provider.js");
    const picked = await new OrcTaskProvider().pickWorkTasks();
    expect(picked.some((t) => t.id === taskId)).toBe(true);

    await getDb().update(tasks).set({ claimed_by: null }).where(eq(tasks.id, taskId));
  });
});
