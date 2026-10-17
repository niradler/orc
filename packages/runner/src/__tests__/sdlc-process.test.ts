import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AgentSession, registerBackend } from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { readSkill, type SkillRefContent } from "@orc/core/skill-service";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { projects, tasks } from "@orc/db/schema";
import { SkillHistory } from "@orc/db/skill-history";
import { addTaskComment } from "@orc/task-service";
import {
  cancelFlowRun,
  drainPendingNodes,
  getLatestFlowRunForTask,
  reportNodeOutcome,
  resumeHumanNode,
  startFlowForTask,
} from "../flow-runner.js";

type CapturedSession = { prompt: string; resumed: boolean; finish: () => void; id: string };
const received: CapturedSession[] = [];
const permissions: (boolean | undefined)[] = [];
const backendName = "sdlc-process-contract";
const environment = { ...process.env };

function session(resumed: boolean, id = ulid()): AgentSession {
  let finish!: () => void;
  const ending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    id,
    send: async (prompt) => {
      received.push({ prompt, resumed, finish, id });
    },
    respondPermission: () => {},
    events: async function* () {
      await ending;
      yield { type: "result" as const, data: { runtimeSessionId: id } };
    },
    alive: () => true,
    close: async () => {
      finish();
    },
  };
}

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_AGENT_LOOP_ENABLED = "true";
  process.env.ORC_AGENT_LOOP_MAX_WORKERS = "1";
  resetConfig();
  createTestDb();
  registerBackend(backendName, () => ({
    name: backendName,
    startSession: async (opts) => {
      permissions.push(opts.autoApprove);
      return session(false);
    },
    resumeSession: async (id) => session(true, id),
    preflight: async () => ({ ok: true }),
    stop: async () => {},
  }));
});

afterAll(async () => {
  await drainPendingNodes();
  closeDb();
  for (const key of ["ORC_DB_PATH", "ORC_AGENT_LOOP_ENABLED", "ORC_AGENT_LOOP_MAX_WORKERS"]) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  resetConfig();
});

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("SDLC process did not reach expected state");
    await Bun.sleep(5);
  }
}

let consumed = 0;
async function launch(dispatch = true): Promise<CapturedSession> {
  const count = consumed;
  if (dispatch) await drainPendingNodes();
  await waitFor(() => received.length > count);
  consumed++;
  return received[count] as CapturedSession;
}

async function finish(taskId: string, nodeId: string, outcome: string, active: CapturedSession) {
  expect(
    await reportNodeOutcome({
      taskId,
      nodeId,
      outcome,
      summary: "Artifact verified; Knowledge: no durable learning",
    }),
  ).toMatchObject({ ok: true });
  active.finish();
  await waitFor(() => {
    const row = getSqlite()
      .query("SELECT status FROM gateway_sessions WHERE runtime_session_id=?")
      .get(active.id) as { status: string } | null;
    return row?.status === "stopped";
  });
  await waitFor(
    () =>
      !getLatestFlowRunForTask(taskId)?.nodes.some(
        (node) => node.node_id === nodeId && node.status === "running",
      ),
  );
}

describe("shared SDLC delivery process", () => {
  test("should serialize simultaneous dispatches without exceeding shared worker capacity", async () => {
    const taskIds = [ulid(), ulid()];
    for (const id of taskIds)
      await getDb().insert(tasks).values({
        id,
        title: "Concurrent explicit start",
        agent_backend: backendName,
        flow_name: "orc-default",
        required_review: false,
      });
    const runs = await Promise.all(taskIds.map((id) => startFlowForTask(id)));
    const drained = await Promise.all([drainPendingNodes(), drainPendingNodes()]);
    expect(drained.flat()).toHaveLength(1);
    expect(
      getSqlite()
        .query("SELECT count(*) AS count FROM gateway_sessions WHERE status='running'")
        .get(),
    ).toEqual({ count: 1 });
    const worker = await launch(false);
    const running = getSqlite()
      .query("SELECT task_id FROM gateway_sessions WHERE status='running'")
      .get() as { task_id: string };
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      if (taskIds[index] !== running.task_id && run?.ok)
        await cancelFlowRun(run.flowRunId, "Queued fixture no longer needed");
    }
    await finish(running.task_id, "build", "submitted", worker);
  });
  test("should halt a hung explicitly started node without automatic task polling", async () => {
    const taskId = ulid();
    await getDb()
      .insert(tasks)
      .values({
        id: taskId,
        title: "Bound explicit execution",
        agent_backend: backendName,
        flow_override: {
          name: "bounded-explicit",
          entry: "build",
          limits: { execution_timeout_secs: 1 },
          nodes: {
            build: {
              kind: "agent",
              prompt: "Wait for fixture completion",
              outcomes: ["submitted"],
            },
            done: { kind: "terminal", task_status: "done" },
          },
          edges: [{ from: "build", to: "done", when: { outcome: "submitted" } }],
        },
      });
    const started = await startFlowForTask(taskId);
    if (!started.ok) throw new Error(started.error);
    await launch();
    const deadline = Date.now() + 10000;
    while (getLatestFlowRunForTask(taskId)?.status === "running") {
      if (Date.now() > deadline) throw new Error("Explicit node did not respect flow timeout");
      await Bun.sleep(50);
    }
    expect(getLatestFlowRunForTask(taskId)?.status).toBe("halted");
    expect(getSqlite().query("SELECT status FROM tasks WHERE id=?").get(taskId)).toEqual({
      status: "paused",
    });
  }, 15000);
  test("should preserve disabled worker auto-approval in runtime options and session state", async () => {
    process.env.ORC_AGENT_LOOP_AUTO_APPROVE = "false";
    resetConfig();
    const taskId = ulid();
    await getDb().insert(tasks).values({
      id: taskId,
      title: "Restricted worker",
      agent_backend: backendName,
      flow_name: "orc-default",
      required_review: false,
    });
    const started = await startFlowForTask(taskId);
    if (!started.ok) throw new Error(started.error);
    const worker = await launch();
    expect(permissions.at(-1)).toBe(false);
    expect(
      getSqlite().query("SELECT auto_approve FROM gateway_sessions WHERE task_id=?").get(taskId),
    ).toEqual({ auto_approve: 0 });
    await finish(taskId, "build", "submitted", worker);
    if (environment.ORC_AGENT_LOOP_AUTO_APPROVE === undefined)
      delete process.env.ORC_AGENT_LOOP_AUTO_APPROVE;
    else process.env.ORC_AGENT_LOOP_AUTO_APPROVE = environment.ORC_AGENT_LOOP_AUTO_APPROVE;
    resetConfig();
  });
  test("fresh workers, reviewers and resumed workers get scoped current knowledge; human feedback and approval route correctly", async () => {
    const projectId = ulid();
    const taskId = ulid();
    const projectName = `sdlc-${projectId}`;
    await getDb().insert(projects).values({ id: projectId, name: projectName });
    await getDb().insert(tasks).values({
      id: taskId,
      project_id: projectId,
      title: "Change a shared component",
      body: "Preserve its callers and validate the result",
      author: "human",
      agent_backend: backendName,
      flow_name: "orc-human-review",
      skill_name: null,
      required_review: false,
      max_review_rounds: 3,
    });
    const history = new SkillHistory(getSqlite());
    const original = readSkill("orc-memory-review", "SKILL.md") as SkillRefContent;
    const firstInstructions = `${original.content}\nProject delivery procedure: inspect shared-component storage.\n`;
    history.update({
      project_id: projectId,
      skill_name: "orc-memory-review",
      content: firstInstructions,
      expected_content: original.content,
      reason: "Project-specific procedure",
    });
    const started = await startFlowForTask(taskId);
    expect(started).toMatchObject({ ok: true });
    try {
      const worker = await launch();
      expect(worker.resumed).toBe(false);
      expect(worker.prompt).toContain("## Workflow: orc-coder");
      expect(worker.prompt).toContain(`Project: ${JSON.stringify(projectName)}`);
      const workerSession = getSqlite()
        .query("SELECT gateway_session_id FROM flow_node_runs WHERE task_id=? AND node_id='build'")
        .get(taskId) as { gateway_session_id: string };
      expect(worker.prompt).toContain(`Session ID: ${workerSession.gateway_session_id}`);
      expect(worker.prompt).toContain("call context first; its Memories section lists");
      expect(worker.prompt).toContain("memory_read, and use memory_list (q) and kb_search");
      expect(worker.prompt).toContain(
        "Project delivery procedure: inspect shared-component storage.",
      );
      await finish(taskId, "build", "submitted", worker);

      const reviewer = await launch(false);
      expect(reviewer.prompt).toContain("## Workflow: orc-reviewer");
      expect(reviewer.prompt).not.toContain("# Work within an ORC flow");
      expect(reviewer.prompt).toContain(
        "Project delivery procedure: inspect shared-component storage.",
      );
      await finish(taskId, "review", "approved", reviewer);
      expect(
        getLatestFlowRunForTask(taskId)?.nodes.some(
          (node) => node.node_id === "signoff" && node.status === "awaiting_human",
        ),
      ).toBe(true);
      expect(getLatestFlowRunForTask(taskId)?.status).toBe("running");

      expect(
        await resumeHumanNode({
          taskId,
          outcome: "changes_requested",
          summary: "Check the existing consumer too",
          author: "human",
        }),
      ).toMatchObject({ ok: true });
      const refreshed = `${original.content}\nProject delivery procedure: validate shared-component consumers.\n`;
      history.update({
        project_id: projectId,
        skill_name: "orc-memory-review",
        content: refreshed,
        expected_content: firstInstructions,
        reason: "Updated project procedure",
      });
      await addTaskComment(taskId, "Same-second consumer feedback", "human");
      getSqlite()
        .query(
          "UPDATE comments SET created_at = (SELECT updated_at FROM gateway_sessions WHERE id = ?) WHERE resource_id = ? AND content = ?",
        )
        .run(workerSession.gateway_session_id, taskId, "Same-second consumer feedback");
      const rework = await launch();
      expect(rework.resumed).toBe(true);
      expect(rework.prompt).toContain("Check the existing consumer too");
      expect(rework.prompt).toContain("Same-second consumer feedback");
      expect(rework.prompt).toContain(
        "Project delivery procedure: validate shared-component consumers.",
      );
      expect(rework.prompt).not.toContain(
        "Project delivery procedure: inspect shared-component storage.",
      );
      expect(rework.prompt).toContain(`Project: ${JSON.stringify(projectName)}`);
      await finish(taskId, "build", "submitted", rework);
      const finalReview = await launch(false);
      await finish(taskId, "review", "approved", finalReview);
      expect(await resumeHumanNode({ taskId, outcome: "approved", author: "human" })).toMatchObject(
        { ok: true },
      );
      expect(getLatestFlowRunForTask(taskId)?.status).toBe("completed");
      const task = getSqlite().query("SELECT status FROM tasks WHERE id=?").get(taskId) as {
        status: string;
      };
      expect(task.status).toBe("done");
    } finally {
      if (started.ok) await cancelFlowRun(started.flowRunId, "test finished");
    }
  });
});
