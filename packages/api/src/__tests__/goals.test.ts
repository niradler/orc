import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentSession, registerBackend } from "@orc/agent-runtime";
import { getDb } from "@orc/db/client";
import { projects } from "@orc/db/schema";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let scope: string;
let turns = 0;

/** The "worker": its second turn produces the artifact the check looks for. */
function workerSession(options: { cwd?: string | undefined }): AgentSession {
  turns += 1;
  const turn = turns;
  if (turn >= 2) writeFileSync(join(options.cwd ?? scope, "goal-marker"), "done");
  return {
    id: `goal-session-${turn}`,
    send: async () => {},
    alive: () => true,
    respondPermission: () => {},
    close: async () => {},
    events: async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: "result",
        data: {
          runtimeSessionId: `goal-native-${turn}`,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
    },
  };
}

beforeAll(() => {
  scope = mkdtempSync(join(tmpdir(), "orc-goal-test-"));
  writeFileSync(
    join(scope, "check.mjs"),
    "import fs from 'node:fs'; process.exit(fs.existsSync('goal-marker') ? 0 : 1);",
  );
  writeFileSync(join(scope, "fail.mjs"), "process.exit(1);");
  app = setupTestApp();
  getDb()
    .insert(projects)
    .values({
      id: "goalproj",
      name: "Goal project",
      scope,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .run();
  registerBackend("goal-fixture", () => ({
    name: "goal-fixture",
    profileCapabilities: { model: true, toolAllowlist: true },
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    resumeSession: async (_id, options) => workerSession(options),
    startSession: async (options) => workerSession(options),
  }));
  registerBackend("goal-hang", () => ({
    name: "goal-hang",
    profileCapabilities: { model: true, toolAllowlist: true },
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    resumeSession: async () => hangSession(),
    startSession: async () => hangSession(),
  }));
});

function hangSession(): AgentSession {
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    id: "goal-hang-session",
    send: async () => {},
    alive: () => true,
    respondPermission: () => {},
    close: async () => {
      release();
    },
    events: async function* (): AsyncGenerator<AgentEvent> {
      await closed;
      yield* [];
    },
  };
}

afterAll(async () => {
  teardownTestApp();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(scope, { recursive: true, force: true });
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
});

async function settled(goalId: string): Promise<{
  goal: { run: { status: string; iteration: number; tokens_used: number } };
  history: { outcome: string | null }[];
}> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const body = await (await req(app, "GET", `/goals/${goalId}`)).json();
    if (body.goal.run && body.goal.run.status !== "active") return body;
    await Bun.sleep(50);
  }
  throw new Error(`goal ${goalId} did not settle`);
}

test("a goal loops worker and check until the check passes", async () => {
  const res = await req(app, "POST", "/goals", {
    objective: "make the marker exist",
    check: "bun check.mjs",
    agents: ["goal-fixture"],
    project_id: "goalproj",
    budget: { iterations: 5, hours: 1 },
  });
  expect(res.status).toBe(201);
  const { goal } = await res.json();
  expect(goal.run.status).toBe("active");
  expect(goal.spec.agents).toEqual(["goal-fixture"]);

  const body = await settled(goal.id);
  expect(body.goal.run.status).toBe("passed");
  expect(body.goal.run.iteration).toBe(2);
  // Two worker turns, 15 tokens each, accumulated from result usage.
  expect(body.goal.run.tokens_used).toBe(30);
  expect(body.history.map((visit) => visit.outcome)).toEqual(["failed", "passed"]);

  const task = await (await req(app, "GET", `/tasks/${goal.task_id}`)).json();
  expect(task.status).toBe("done");
  const taskGoal = await (await req(app, "GET", `/tasks/${goal.task_id}/goal`)).json();
  expect(taskGoal.goal.id).toBe(goal.id);
}, 20_000);

test("goal_stop cancels the flow and marks the goal stopped", async () => {
  const res = await req(app, "POST", "/goals", {
    objective: "never passes",
    check: "bun fail.mjs",
    agents: ["goal-hang"],
    project_id: "goalproj",
  });
  expect(res.status).toBe(201);
  const { goal } = await res.json();
  expect(goal.run.status).toBe("active");

  const stopped = await (await req(app, "POST", `/goals/${goal.id}/stop`)).json();
  expect(stopped.goal.status).toBe("stopped");
  expect(stopped.goal.run.status).toBe("stopped");
});

test("a goal can attach to an existing task", async () => {
  const taskRes = await req(app, "POST", "/tasks", {
    title: "Existing task for a goal",
    project_id: "goalproj",
  });
  expect(taskRes.status).toBe(201);
  const task = await taskRes.json();
  const res = await req(app, "POST", "/goals", {
    objective: "finish the existing task",
    check: "bun check.mjs",
    agents: ["goal-fixture"],
    task_id: task.id,
    project_id: "goalproj",
  });
  expect(res.status).toBe(201);
  const { goal } = await res.json();
  expect(goal.task_id).toBe(task.id);
  // The marker already exists from the first test: one iteration suffices.
  const body = await settled(goal.id);
  expect(body.goal.run.status).toBe("passed");
  expect(body.goal.run.iteration).toBe(1);
}, 20_000);

test("an invalid goal spec is rejected", async () => {
  const res = await req(app, "POST", "/goals", { objective: "", check: "bun check.mjs" });
  expect(res.status).toBe(400);
});
