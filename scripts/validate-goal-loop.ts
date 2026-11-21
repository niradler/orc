/**
 * Bounded paid real-agent goal validation (#173, Nir-approved). Private API +
 * isolated retained database, one real worker, hard budget: 4 iterations,
 * 0.5h flow ceiling, 20-minute probe deadline, zero infrastructure retries.
 * The goal is real: a failing bun test the worker must fix; the external check
 * is the test itself. Evidence lands in .claude/tooling/goal-loop/<ts>/.
 *
 * Run: bun scripts/validate-goal-loop.ts
 * Backend: ORC_GOAL_PROBE_BACKEND=claude (default) or codex-cli.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/api/src/server.js";
import { loadConfig, OrcConfigSchema } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { closeLiveSession } from "../packages/runner/src/flow-runner.js";

const backend = process.env.ORC_GOAL_PROBE_BACKEND ?? "claude";
if (!["claude", "codex-cli"].includes(backend))
  throw new Error("Goal probe supports claude and codex-cli");
const directory = resolve(
  import.meta.dir,
  "../.claude/tooling/goal-loop",
  `${backend}-${Date.now()}`,
);
mkdirSync(directory, { recursive: true });
process.env.ORC_LOG_DIR = join(directory, "logs");
const secret = randomUUID();
const initial = loadConfig();
loadConfig({
  activeProject: "",
  db: { path: join(directory, "orc.db") },
  api: { ...OrcConfigSchema.parse({}).api, host: "127.0.0.1", port: 7712, secret },
  rules: { enabled: true },
  knowledge: { ...initial.knowledge, root: join(directory, "knowledge"), default_limit: 10 },
  agent_loop: {
    ...initial.agent_loop,
    enabled: false,
    default_backend: backend,
    max_workers: 1,
    worker_auto_approve: true,
    max_node_retries: 0,
  },
});
const app = createApp();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7712,
  fetch: app.fetch,
  idleTimeout: 255,
});
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:7712/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status}: ${JSON.stringify(data)}`);
  return data as T;
}

type GoalBody = {
  goal: {
    id: string;
    task_id: string;
    run: {
      status: string;
      iteration: number;
      stage: number;
      stall: number;
      tokens_used: number;
      halt_reason: string | null;
    } | null;
  };
  history: { outcome: string | null; summary: string | null }[];
};

const scope = mkdtempSync(join(tmpdir(), "orc-goal-probe-"));
writeFileSync(
  join(scope, "subject.ts"),
  "export function active(expires: number | null, now: number): boolean {\n  return false;\n}\n",
);
writeFileSync(
  join(scope, "probe.test.ts"),
  [
    'import { expect, test } from "bun:test";',
    'import { active } from "./subject";',
    'test("expiry contract", () => {',
    "  expect(active(null, 100)).toBe(true);",
    "  expect(active(150, 100)).toBe(true);",
    "  expect(active(100, 100)).toBe(false);",
    "  expect(active(50, 100)).toBe(false);",
    "});",
    "",
  ].join("\n"),
);
writeFileSync(
  join(scope, "CLAUDE.md"),
  "Isolated goal probe. Edit only subject.ts to satisfy probe.test.ts. Verify with `bun test probe.test.ts`. No git, deletes or external effects. Report outcome submitted via flow_report when the check passes or you are blocked.\n",
);
writeFileSync(
  join(scope, "AGENTS.md"),
  "Edit only subject.ts; the success check is `bun test probe.test.ts`. No git or deletes. Use the supplied ORC MCP for outcomes.\n",
);

let goalId = "";
const startedAt = Date.now();
try {
  const project = await request<{ id: string }>("/projects", {
    name: `goal-probe-${Date.now()}`,
    scope,
  });
  const { goal } = await request<GoalBody>("/goals", {
    objective:
      "Make `bun test probe.test.ts` pass: implement active(expires, now) in subject.ts so null expiry is active, expiry strictly greater than now is active, and expiry equal to or earlier than now is inactive.",
    check: "bun test probe.test.ts",
    agents: [backend],
    project_id: project.id,
    budget: { iterations: 4, hours: 0.5 },
    stall_limit: 3,
  });
  goalId = goal.id;
  console.log(`Goal ${goal.id} started on task ${goal.task_id}; waiting for the verdict…`);

  const deadline = Date.now() + 20 * 60_000;
  let body: GoalBody = { goal, history: [] };
  while (Date.now() < deadline) {
    await Bun.sleep(5_000);
    body = await request<GoalBody>(`/goals/${goalId}`);
    const run = body.goal.run;
    console.log(
      `iteration ${run?.iteration ?? 0}: ${run?.status ?? "unknown"} (tokens ${run?.tokens_used ?? 0})`,
    );
    if (run && run.status !== "active") break;
  }
  const run = body.goal.run;
  if (!run || run.status === "active") {
    await request(`/goals/${goalId}/stop`, {});
    throw new Error("Probe deadline reached before a verdict; goal stopped");
  }

  // Independent artifact verification: the probe runs the check itself.
  const check = Bun.spawn(["bun", "test", "probe.test.ts"], {
    cwd: scope,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const checkOutput = await new Response(check.stdout).text();
  const checkCode = await check.exited;
  const task = await request<{ status: string }>(`/tasks/${body.goal.task_id}`);
  const evidence = {
    backend,
    verdict: run.status,
    iteration: run.iteration,
    tokens_used: run.tokens_used,
    elapsed_ms: Date.now() - startedAt,
    halt_reason: run.halt_reason,
    history: body.history,
    task_status: task.status,
    independent_check: { exit: checkCode, output: checkOutput },
    subject_source: await Bun.file(join(scope, "subject.ts")).text(),
    ledger: getSqlite()
      .query("SELECT node_id,node_kind,attempt,retry,status,outcome,summary FROM flow_node_runs")
      .all(),
    sessions: getSqlite()
      .query(
        "SELECT id,backend,status,runtime_session_id,tokens_used,last_error FROM gateway_sessions",
      )
      .all(),
  };
  writeFileSync(join(directory, "report.json"), JSON.stringify(evidence, null, 2));
  if (run.status !== "passed") throw new Error(`Goal did not pass: ${JSON.stringify(evidence)}`);
  if (checkCode !== 0) throw new Error("Independent check failed after a passed verdict");
  if (task.status !== "done") throw new Error(`Task not done: ${task.status}`);
  if (body.history.at(-1)?.outcome !== "passed") throw new Error("Last check was not passed");
  console.log(`Real goal loop passed in ${run.iteration} iteration(s): ${directory}`);
} finally {
  writeFileSync(
    join(directory, "final-state.json"),
    JSON.stringify(
      {
        goalId,
        scope,
        elapsed_ms: Date.now() - startedAt,
        tasks: getSqlite().query("SELECT id,status FROM tasks").all(),
        goals: getSqlite().query("SELECT id,status,flow_run_id FROM goals").all(),
        ledger: getSqlite()
          .query("SELECT node_id,node_kind,status,outcome,error FROM flow_node_runs")
          .all(),
        sessions: getSqlite()
          .query("SELECT id,backend,status,runtime_session_id,last_error FROM gateway_sessions")
          .all(),
      },
      null,
      2,
    ),
  );
  for (const row of getSqlite()
    .query("SELECT id FROM gateway_sessions WHERE status='running'")
    .all() as { id: string }[])
    closeLiveSession(row.id);
  await server.stop(true);
  closeDb();
  rmSync(scope, { recursive: true, force: true });
}
