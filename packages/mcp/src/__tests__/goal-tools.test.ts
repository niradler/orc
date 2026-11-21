import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentSession, registerBackend } from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getDb } from "@orc/db/client";
import { projects, tasks } from "@orc/db/schema";
import { executeTool } from "../tools.js";

let scope: string;
let turns = 0;

function workerSession(options: { cwd?: string | undefined }): AgentSession {
  turns += 1;
  const turn = turns;
  if (turn >= 2) writeFileSync(join(options.cwd ?? scope, "goal-marker"), "done");
  return {
    id: `mcp-goal-session-${turn}`,
    send: async () => {},
    alive: () => true,
    respondPermission: () => {},
    close: async () => {},
    events: async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "result", data: { runtimeSessionId: `mcp-goal-native-${turn}` } };
    },
  };
}

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  scope = mkdtempSync(join(tmpdir(), "orc-mcp-goal-test-"));
  writeFileSync(
    join(scope, "check.mjs"),
    "import fs from 'node:fs'; process.exit(fs.existsSync('goal-marker') ? 0 : 1);",
  );
  getDb()
    .insert(projects)
    .values({ id: "mcp-goal-project", name: "mcp-goal-project", scope })
    .run();
  getDb()
    .insert(tasks)
    .values({ id: "outside-task", title: "Outside the scope", status: "todo" })
    .run();
  registerBackend("mcp-goal-fixture", () => ({
    name: "mcp-goal-fixture",
    profileCapabilities: { model: true, toolAllowlist: true },
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    resumeSession: async (_id, options) => workerSession(options),
    startSession: async (options) => workerSession(options),
  }));
});

afterAll(async () => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  resetConfig();
  // Bun's rmSync ignores maxRetries; Windows releases the cwd handle of exited
  // check children asynchronously, so retry the removal ourselves.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(scope, { recursive: true, force: true });
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
});

test("goal_create loops to a pass and goal_status reports the history", async () => {
  const created = await executeTool("goal_create", {
    objective: "make the marker exist",
    check: "bun check.mjs",
    agents: ["mcp-goal-fixture"],
    project: "mcp-goal-project",
    iterations: 5,
  });
  const match = /Goal (\w+) started on task (\w+)/.exec(created);
  expect(match).not.toBeNull();
  const goalId = match?.[1] as string;

  const deadline = Date.now() + 15_000;
  let status = "";
  while (Date.now() < deadline) {
    status = await executeTool("goal_status", { id: goalId });
    if (JSON.parse(status).goal.run?.status !== "active") break;
    await Bun.sleep(50);
  }
  const body = JSON.parse(status);
  expect(body.goal.run.status).toBe("passed");
  expect(body.goal.run.iteration).toBe(2);
  expect(body.history.map((visit: { outcome: string }) => visit.outcome)).toEqual([
    "failed",
    "passed",
  ]);

  const byTask = JSON.parse(await executeTool("goal_status", { task: body.goal.task_id }));
  expect(byTask.id).toBe(goalId);
}, 20_000);

test("goal_stop stops a running goal", async () => {
  const created = await executeTool("goal_create", {
    objective: "stop me",
    check: "bun check.mjs",
    agents: ["mcp-goal-fixture"],
    project: "mcp-goal-project",
  });
  const goalId = /Goal (\w+) started/.exec(created)?.[1] as string;
  const stopped = await executeTool("goal_stop", { id: goalId });
  expect(stopped).toContain("stopped");
  const body = JSON.parse(await executeTool("goal_status", { id: goalId }));
  expect(body.goal.status).toBe("stopped");
});

test("goal tools respect project scopes", async () => {
  const scoped = { projectScopes: [{ id: "mcp-goal-project", name: "mcp-goal-project" }] };
  await expect(
    executeTool(
      "goal_create",
      {
        objective: "escape the scope",
        check: "bun check.mjs",
        task: "outside-task",
      },
      scoped,
    ),
  ).rejects.toThrow();
  await expect(executeTool("goal_status", { task: "outside-task" }, scoped)).rejects.toThrow();
});
