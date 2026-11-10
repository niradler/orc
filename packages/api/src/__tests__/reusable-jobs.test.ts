import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentSession,
  registerBackend,
  type SessionOpts,
} from "@orc/agent-runtime";
import { createFlow, getUserFlowsDir, reloadFlows } from "@orc/core/flow-service";
import { getDb, getSqlite } from "@orc/db/client";
import { tasks } from "@orc/db/schema";
import { executeJob } from "@orc/runner/executor";
import { startScheduler, stopScheduler } from "@orc/runner/scheduler";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
let fixtureHome: string;
let lastPrompt = "";
let lastOptions: SessionOpts | undefined;
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
    startSession: async (options): Promise<AgentSession> => {
      lastOptions = options;
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
          if (options.env?.REDACTION_REGRESSION) {
            const secret = options.env.FIXTURE_SECRET ?? "";
            yield { type: "text", data: secret.slice(0, 20) };
            yield { type: "text", data: secret.slice(20) };
            yield { type: "text", data: "x".repeat(63990) };
          } else {
            yield {
              type: "text",
              data: `Agent action completed${options.env?.FIXTURE_SECRET ?? ""}`,
            };
          }
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
  // Bun's homedir() ignores the fixture HOME, so createFlow wrote into the real
  // user flows directory; remove the owned fixture to keep reruns green.
  rmSync(join(getUserFlowsDir(), "job-human-fixture"), { recursive: true, force: true });
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
  createFlow(
    {
      name: "job-human-fixture",
      entry: "wait",
      nodes: {
        wait: { kind: "human", prompt: "Review event", task_status: "review" },
        done: { kind: "terminal", task_status: "done" },
      },
      edges: [{ from: "wait", to: "done", when: { outcome: "approved" } }],
    },
    { overwrite: true },
  );
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

test("should execute an agent in an isolated worktree with pinned host, environment and launch options", async () => {
  mode = "success";
  const repository = join(fixtureHome, "job-repository");
  mkdirSync(repository);
  function git(args: string[]): void {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repository,
      timeout: 10000,
      windowsHide: true,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  git(["init"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "fixture.txt"), "base");
  git(["add", "fixture.txt"]);
  git(["commit", "-m", "Fixture"]);
  const options: NonNullable<SessionOpts["chatAgentOptions"]> = {
    runtime: "acpx",
    args: ["--timeout", "120"],
  };
  const response = await req(app, "POST", "/jobs", {
    name: "isolated-agent",
    action: {
      type: "agent",
      backend: "job-fixture",
      prompt: "Inspect only",
      model: "fixture-model",
      options,
    },
    trigger_type: "manual",
    working_dir: repository,
    settings: {
      host: null,
      workspace: { mode: "worktree", base_ref: "HEAD", cleanup_on_success: true },
    },
    environment: [{ name: "FIXTURE_SECRET", value: "private-fixture-value", secret: true }],
  });
  expect(response.status).toBe(201);
  const job = await response.json();
  const trigger = await (await req(app, "POST", `/jobs/${job.id}/trigger`)).json();
  const run = await waitRun(trigger.run_id);
  expect(run.status).toBe("success");
  expect(lastOptions?.executionHost).toBeNull();
  expect(lastOptions?.model).toBe("fixture-model");
  expect(lastOptions?.chatAgentOptions).toEqual(options);
  expect(lastOptions?.env?.FIXTURE_SECRET).toBe("private-fixture-value");
  expect(lastOptions?.cwd.replaceAll("\\", "/")).toContain("/.orc/worktrees/job-");
  expect(lastOptions?.cwd && existsSync(lastOptions.cwd)).toBe(false);
  expect(run.stdout).toContain("[REDACTED]");
  expect(run.stdout).toContain("Clean worktree removed");
  expect(run.stdout).not.toContain("private-fixture-value");
});

test("should run scheduled agent actions and signed HTTP webhook agent actions end to end", async () => {
  mode = "success";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  const send = async <T = unknown>(path: string, body: unknown, method = "POST"): Promise<T> => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  };
  let cronId: string | undefined;
  try {
    expect((await fetch(`${base}/api/jobs/missing/runs/missing/session`)).status).toBe(401);
    await startScheduler();
    const scheduled = await send<{ id: string }>("/jobs", {
      name: "scheduled-agent-e2e",
      action: { type: "agent", backend: "job-fixture", prompt: "Scheduled instructions" },
      trigger_type: "cron",
      cron_expr: "* * * * * *",
      enabled: true,
    });
    cronId = scheduled.id;
    let runId: string | undefined;
    for (let attempt = 0; attempt < 150; attempt++) {
      const runs = (await (
        await fetch(`${base}/api/jobs/${scheduled.id}/runs`, {
          headers: { Authorization: "Bearer test-secret" },
        })
      ).json()) as { runs: { id: string }[] };
      if (runs.runs[0]) {
        runId = runs.runs[0].id;
        break;
      }
      await Bun.sleep(20);
    }
    expect(runId).toBeDefined();
    await send(`/jobs/${scheduled.id}`, { enabled: false }, "PATCH");
    if (!runId) throw new Error("No scheduled run");
    expect((await waitRun(runId)).status).toBe("success");
    expect(lastPrompt).toContain("Scheduled instructions");
    const source = await send<{ id: string; token: string; secret: string }>("/webhooks", {
      name: "Real HTTP source",
      provider: "generic",
    });
    const job = await send<{ id: string }>("/jobs", {
      name: "http-agent-e2e",
      action: { type: "agent", backend: "job-fixture", prompt: "Webhook instructions" },
      trigger_type: "webhook",
      enabled: true,
      webhooks: [{ webhook_id: source.id, events: ["push"] }],
    });
    const payload = JSON.stringify({ fixture: "real-http-body" });
    const headers = {
      "Content-Type": "application/json",
      "X-Orc-Event": "push",
      "X-Orc-Delivery": "http-real-e2e",
      "X-Orc-Signature-256": `sha256=${createHmac("sha256", source.secret).update(payload).digest("hex")}`,
    };
    const denied = await fetch(`${base}/webhooks/${source.token}`, {
      method: "POST",
      headers: { ...headers, "X-Orc-Signature-256": "sha256=invalid" },
      body: payload,
    });
    expect(denied.status).toBe(401);
    const response = await fetch(`${base}/webhooks/${source.token}`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(response.status).toBe(202);
    const delivery = (await response.json()) as { run_ids: string[] };
    const deliveredRunId = delivery.run_ids[0];
    if (!deliveredRunId) throw new Error("Delivery did not start an agent run");
    const completed = await waitRun(deliveredRunId);
    expect(completed.status).toBe("success");
    expect(completed.session_id).toBeTruthy();
    if (!completed.session_id) throw new Error("Missing agent session link");
    expect(lastPrompt).toContain("Webhook instructions");
    expect(lastPrompt).toContain("real-http-body");
    const rows = (await (
      await fetch(`${base}/api/jobs/${job.id}/runs`, {
        headers: { Authorization: "Bearer test-secret" },
      })
    ).json()) as { runs: { session_id: string; native_session_id: string }[] };
    const firstRow = rows.runs[0];
    if (!firstRow) throw new Error("Missing completed run");
    expect(firstRow.session_id).toBe(completed.session_id);
    expect(firstRow.native_session_id).toBe("fixture-runtime");
    const wrongRun = await fetch(`${base}/api/jobs/${scheduled.id}/runs/${completed.id}/session`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(wrongRun.status).toBe(404);
    const absentNative = await fetch(`${base}/api/jobs/${job.id}/runs/${completed.id}/session`, {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(await absentNative.json()).toEqual({ session_id: null });
    const duplicate = await fetch(`${base}/webhooks/${source.token}`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(duplicate.status).toBe(409);
  } finally {
    if (cronId) await send(`/jobs/${cronId}`, { enabled: false }, "PATCH");
    stopScheduler();
    await server.stop(true);
  }
}, 15000);

test("agent output redacts split secrets before rolling trace retention and audit persistence", async () => {
  const secret = "SYNTHETIC_SECRET_BOUNDARY_12345";
  const created = await req(app, "POST", "/jobs", {
    name: "redaction-rolling-regression",
    trigger_type: "manual",
    action: { type: "agent", backend: "job-fixture", prompt: "Inspect fixture" },
    environment: [
      { name: "FIXTURE_SECRET", value: secret, secret: true },
      { name: "REDACTION_REGRESSION", value: "true", secret: false },
    ],
  });
  expect(created.status).toBe(201);
  const job = await created.json();
  const trigger = await (await req(app, "POST", `/jobs/${job.id}/trigger`)).json();
  const run = await waitRun(trigger.run_id);
  expect(run.status).toBe("success");
  const sqlite = getSqlite();
  const persisted = [
    run.stdout,
    sqlite.query("SELECT summary FROM gateway_sessions WHERE id=?").get(run.session_id ?? ""),
    sqlite.query("SELECT summary FROM sessions WHERE id=?").get(run.session_id ?? ""),
    sqlite.query("SELECT line FROM job_run_logs WHERE run_id=?").all(run.id),
  ];
  expect(JSON.stringify(persisted)).not.toContain("DARY_12345");
  expect(run.stdout).toEndWith("x".repeat(63990));
  expect(run.stdout).toHaveLength(64000);
});

test("command redacts secret fragments before stream cap, including split chunks and both output streams", async () => {
  const secret = "SYNTHETIC_COMMAND_SECRET_SECOND_PART";
  const created = await req(app, "POST", "/jobs", {
    name: "redaction-command-regression",
    trigger_type: "manual",
    action: { type: "command", command: "fixture" },
    environment: [{ name: "FIXTURE_SECRET", value: secret, secret: true }],
  });
  expect(created.status).toBe(201);
  const job = await created.json();
  const runId = await executeJob({
    jobId: job.id,
    execution: {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('x'.repeat(65530));process.stdout.write(process.env.FIXTURE_SECRET.slice(0,12));await Bun.sleep(20);process.stdout.write(process.env.FIXTURE_SECRET.slice(12));process.stderr.write(process.env.FIXTURE_SECRET);",
      ],
      stdin: "",
      timeout_ms: 5000,
      cwd: fixtureHome,
    },
  });
  const sqlite = getSqlite();
  const run = sqlite
    .query<{ stdout: string; stderr: string; status: string }, [string]>(
      "SELECT stdout,stderr,status FROM job_runs WHERE id=?",
    )
    .get(runId);
  expect(run?.status).toBe("success");
  expect(run?.stdout).toBe(`${"x".repeat(65530)}[REDAC`);
  expect(run?.stderr).toBe("[REDACTED]");
  const logs = sqlite.query("SELECT line FROM job_run_logs WHERE run_id=?").all(runId);
  expect(JSON.stringify(logs)).not.toContain("SYNTHETIC");
  expect(JSON.stringify(logs)).not.toContain("SECOND_PART");
});
