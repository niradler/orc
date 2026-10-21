import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentSession, registerBackend } from "@orc/agent-runtime";
import { createFlow, reloadFlows } from "@orc/core/flow-service";
import { getDb, getSqlite } from "@orc/db/client";
import { tasks } from "@orc/db/schema";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
let fixtureHome: string;
let lastPrompt = "";
let closed = 0;
let mode: "success" | "error" | "hang" = "success";
let permission = "";
beforeAll(() => {
  fixtureHome = mkdtempSync(join(tmpdir(), "orc-job-action-test-"));
  process.env.HOME = fixtureHome;
  process.env.USERPROFILE = fixtureHome;
  reloadFlows();
  app = setupTestApp();
  registerBackend("job-fixture", () => ({
    name: "job-fixture",
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    resumeSession: async () => {
      throw new Error("No resume expected");
    },
    startSession: async (): Promise<AgentSession> => {
      const behavior = mode;
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        id: "fixture-session",
        send: async (prompt) => {
          lastPrompt = prompt;
        },
        alive: () => true,
        respondPermission: (_id, result) => {
          permission = result;
        },
        close: async () => {
          closed++;
          finish();
        },
        events: async function* (): AsyncGenerator<AgentEvent> {
          if (behavior === "hang") {
            await finished;
            return;
          }
          if (behavior === "error") {
            yield { type: "error", data: "fixture backend failed" };
            return;
          }
          yield {
            type: "permission_request",
            data: { requestId: "request", tool: "shell", command: "example" },
          };
          yield { type: "text", data: "Agent action completed" };
          yield { type: "result", data: { runtimeSessionId: "fixture-runtime" } };
        },
      };
    },
  }));
});
afterAll(() => {
  teardownTestApp();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalProfile;
  reloadFlows();
  rmSync(fixtureHome, { recursive: true, force: true });
});

async function waitRun(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = getSqlite()
      .query<
        {
          id: string;
          status: string;
          task_id: string | null;
          session_id: string | null;
          stdout: string | null;
          error_msg: string | null;
        },
        [string]
      >("SELECT id,status,task_id,session_id,stdout,error_msg FROM job_runs WHERE id=?")
      .get(id);
    if (run && !["pending", "running"].includes(run.status)) return run;
    await Bun.sleep(30);
  }
  throw new Error("Run did not finish");
}

test("should create independent sources, fan out by job filters, deduplicate and preserve source after job deletion", async () => {
  const response = await req(app, "POST", "/webhooks", {
    name: "Reusable source",
    provider: "generic",
  });
  expect(response.status).toBe(201);
  const source = await response.json();
  expect(source.subscriptions).toEqual([]);
  const first = await (
    await req(app, "POST", "/jobs", {
      name: "source-command",
      action: { type: "command", command: "echo fanout" },
      trigger_type: "webhook",
      enabled: true,
      webhooks: [{ webhook_id: source.id, events: ["push"] }],
    })
  ).json();
  const second = await (
    await req(app, "POST", "/jobs", {
      name: "source-task",
      action: { type: "task", title: "Handle event", body: "Review this event" },
      trigger_type: "webhook",
      enabled: true,
      webhooks: [{ webhook_id: source.id, events: ["push"] }],
    })
  ).json();
  await req(app, "POST", "/jobs", {
    name: "source-disabled",
    action: { type: "task", title: "Must not run" },
    trigger_type: "webhook",
    webhooks: [{ webhook_id: source.id, events: ["push"] }],
  });
  await req(app, "POST", "/jobs", {
    name: "source-other-event",
    action: { type: "task", title: "Different event" },
    enabled: true,
    trigger_type: "webhook",
    webhooks: [{ webhook_id: source.id, events: ["release"] }],
  });
  const body = JSON.stringify({ repository: { full_name: "example/repo" } });
  const headers = {
    "content-type": "application/json",
    "x-orc-event": "push",
    "x-orc-delivery": "once",
    "x-orc-signature-256": `sha256=${createHmac("sha256", source.secret).update(body).digest("hex")}`,
  };
  const delivery = await app.request(`/webhooks/${source.token}`, {
    method: "POST",
    headers,
    body,
  });
  expect(delivery.status).toBe(202);
  const result = (await delivery.json()) as { run_ids: string[] };
  expect(result.run_ids).toHaveLength(2);
  const runs = await Promise.all(result.run_ids.map((id: string) => waitRun(id)));
  expect(runs.every((run) => run.status === "success")).toBe(true);
  const taskId = runs.find((run) => run.task_id)?.task_id;
  expect(taskId).toBeTruthy();
  if (!taskId) throw new Error("Created task link missing");
  const createdTask = getSqlite()
    .query<{ auto_start: number; body: string }, [string]>(
      "SELECT auto_start,body FROM tasks WHERE id=?",
    )
    .get(taskId);
  expect(createdTask?.auto_start).toBe(0);
  expect(createdTask?.body).toContain("example/repo");
  expect(
    (await app.request(`/webhooks/${source.token}`, { method: "POST", headers, body })).status,
  ).toBe(409);
  const list = await (await req(app, "GET", "/webhooks")).json();
  expect(
    list.webhooks.find((hook: { id: string }) => hook.id === source.id).subscriptions,
  ).toHaveLength(4);
  expect(list.webhooks.every((hook: { secret?: string }) => hook.secret === undefined)).toBe(true);
  const history = await (await req(app, "GET", `/webhooks/${source.id}/deliveries`)).json();
  expect(history.deliveries[0].runs).toHaveLength(2);
  await req(app, "DELETE", `/jobs/${first.id}`);
  await req(app, "PATCH", `/jobs/${second.id}`, { webhooks: [] });
  const kept = await (await req(app, "GET", "/webhooks")).json();
  expect(kept.webhooks.find((hook: { id: string }) => hook.id === source.id).token).toBe(
    source.token,
  );
});

test("should validate typed actions and reject cross-project subscriptions without creating a partial job", async () => {
  const project = await (await req(app, "POST", "/projects", { name: "source-project" })).json();
  const hook = await (
    await req(app, "POST", "/webhooks", {
      name: "Scoped",
      provider: "github",
      project_id: project.id,
    })
  ).json();
  const before = getSqlite()
    .query<{ count: number }, []>("SELECT count(*) AS count FROM jobs")
    .get()?.count;
  expect(
    (
      await req(app, "POST", "/jobs", {
        name: "wrong-project",
        command: "echo no",
        trigger_type: "webhook",
        webhooks: [{ webhook_id: hook.id }],
      })
    ).status,
  ).toBe(400);
  expect(
    getSqlite().query<{ count: number }, []>("SELECT count(*) AS count FROM jobs").get()?.count,
  ).toBe(before);
  expect(
    (
      await req(app, "POST", "/jobs", {
        name: "missing-command",
        trigger_type: "manual",
        action: { type: "command" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/jobs", {
        name: "bad-kind",
        trigger_type: "manual",
        action: { type: "unknown" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/jobs", {
        name: "bad-flow",
        trigger_type: "manual",
        action: { type: "task", title: "Task", flow_name: "does-not-exist" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/jobs", {
        name: "no-command-task",
        trigger_type: "manual",
        action: { type: "task", title: "Task" },
      })
    ).status,
  ).toBe(201);
});

test("should run an agent through the backend registry, link its session and bound errors and timeout", async () => {
  const response = await req(app, "POST", "/jobs", {
    name: "agent-action",
    trigger_type: "manual",
    timeout_secs: 1,
    action: { type: "agent", backend: "job-fixture", prompt: "Follow configured instructions" },
  });
  expect(response.status).toBe(201);
  const job = await response.json();
  const before = closed;
  const result = await (await req(app, "POST", `/jobs/${job.id}/trigger`)).json();
  const run = await waitRun(result.run_id);
  expect(run.status).toBe("success");
  expect(run.session_id).toBeTruthy();
  expect(run.stdout).toContain("Agent action completed");
  expect(lastPrompt).toContain("Follow configured instructions");
  expect(permission).toBe("denied");
  expect(closed).toBe(before + 1);
  mode = "error";
  const error = await (await req(app, "POST", `/jobs/${job.id}/trigger`)).json();
  expect((await waitRun(error.run_id)).status).toBe("failed");
  mode = "hang";
  const timeout = await (await req(app, "POST", `/jobs/${job.id}/trigger`)).json();
  expect((await waitRun(timeout.run_id)).error_msg).toContain("timed out");
  mode = "success";
  expect(await getDb().select().from(tasks)).toHaveLength(1);
});

test("should keep generated backlog tasks out of the loop and start only explicitly opted-in flows", async () => {
  createFlow({
    name: "job-human-fixture",
    entry: "wait",
    nodes: {
      wait: { kind: "human", prompt: "Review event", task_status: "review" },
      done: { kind: "terminal", task_status: "done" },
    },
    edges: [{ from: "wait", to: "done", when: { outcome: "approved" } }],
  });
  for (const automatic of [false, true]) {
    const job = await (
      await req(app, "POST", "/jobs", {
        name: `task-auto-${automatic}`,
        trigger_type: "manual",
        action: {
          type: "task",
          title: "Review event",
          flow_name: "job-human-fixture",
          start_automatically: automatic,
        },
      })
    ).json();
    const result = await (await req(app, "POST", `/jobs/${job.id}/trigger`)).json();
    const run = await waitRun(result.run_id);
    expect(run.status).toBe("success");
    const task = await getDb().query.tasks.findFirst({
      where: (table, { eq }) => eq(table.id, run.task_id ?? "missing"),
    });
    expect(task?.auto_start).toBe(automatic);
    expect(task?.status).toBe(automatic ? "review" : "todo");
  }
});

test("should report partial fan-out failure while allowing another subscribed job to finish", async () => {
  const hook = await (
    await req(app, "POST", "/webhooks", { name: "Partial failure", provider: "generic" })
  ).json();
  for (const [name, command] of [
    ["fanout-ok", "echo success"],
    ["fanout-fail", "exit 7"],
  ]) {
    await req(app, "POST", "/jobs", {
      name,
      command,
      trigger_type: "webhook",
      enabled: true,
      webhooks: [{ webhook_id: hook.id }],
    });
  }
  const body = "{}";
  const delivery = await app.request(`/webhooks/${hook.token}`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-orc-delivery": "partial",
      "x-orc-signature-256": `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`,
    },
  });
  expect(delivery.status).toBe(202);
  const result = (await delivery.json()) as { run_ids: string[] };
  const runs = await Promise.all(result.run_ids.map((id: string) => waitRun(id)));
  expect(runs.map((run) => run.status).sort()).toEqual(["failed", "success"]);
  await Bun.sleep(30);
  const history = await (await req(app, "GET", `/webhooks/${hook.id}/deliveries`)).json();
  expect(history.deliveries[0].status).toBe("failed");
  expect(history.deliveries[0].runs).toHaveLength(2);
});
