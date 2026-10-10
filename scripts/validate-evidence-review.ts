/** Paid real-agent flow validation. Uses a private API and retained isolated database. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/api/src/server.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import {
  closeLiveSession,
  drainPendingNodes,
  startFlowForTask,
} from "../packages/runner/src/flow-runner.js";

const directory = resolve(
  import.meta.dir,
  "../.claude/tooling/evidence-review",
  String(Date.now()),
);
mkdirSync(directory, { recursive: true });
const secret = randomUUID();
const initial = loadConfig();
loadConfig({
  activeProject: "",
  db: { path: join(directory, "orc.db") },
  api: { host: "127.0.0.1", port: 7711, secret },
  rules: { enabled: true },
  knowledge: {
    db_path: join(directory, "knowledge.db"),
    default_limit: 10,
    search_mode: "lexical",
  },
  agent_loop: {
    ...initial.agent_loop,
    enabled: true,
    default_backend: "claude",
    max_workers: 1,
    worker_auto_approve: true,
    max_node_retries: 0,
  },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7711,
  fetch: createApp().fetch,
  idleTimeout: 255,
});
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:7711/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status}: ${JSON.stringify(data)}`);
  return data as T;
}
const results: unknown[] = [];
try {
  for (const defective of [true, false]) {
    const scope = mkdtempSync(join(tmpdir(), "orc-evidence-review-"));
    writeFileSync(
      join(scope, "subject.ts"),
      `export function active(expires:number|null, now:number){return expires===null || expires ${defective ? ">=" : ">"} now;}\n`,
    );
    writeFileSync(
      join(scope, "verify.ts"),
      "import {strict as assert} from 'node:assert'; import {active} from './subject'; assert.equal(active(null,100),true); assert.equal(active(101,100),true); assert.equal(active(100,100),false); assert.equal(active(99,100),false); console.log('Expiry contract passed');\n",
    );
    writeFileSync(
      join(scope, "CLAUDE.md"),
      "Isolated review fixture. Read source and run bun verify.ts. Do not edit files or use git. All workflow interaction uses supplied ORC MCP. Report the declared flow outcome rather than changing task status.\n",
    );
    const project = await request<{ id: string }>("/projects", {
      name: `evidence-review-${defective ? "defect" : "clean"}-${Date.now()}`,
      scope,
    });
    const task = await request<{ id: string }>("/tasks", {
      title: "Verify expiry boundary",
      body: "Review subject.ts and verify.ts. Contract: null expiry remains active; expiry strictly greater than now is active; expiry equal to now or earlier is inactive. Run bun verify.ts and cite its observed result, relevant source file and concrete boundary input in flow_report summary. Do not modify the fixture. Use orc-evidence-review's declared outcomes.",
      project_id: project.id,
      skill_name: "orc-reviewer",
      agent_backend: "claude",
      flow_name: "orc-evidence-review",
      required_review: false,
    });
    const started = await startFlowForTask(task.id);
    if (!started.ok) throw new Error(started.error);
    await drainPendingNodes();
    const deadline = Date.now() + 360000;
    let state: { status: string } = { status: "todo" };
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      state = await request(`/tasks/${task.id}`);
      const running = getSqlite()
        .query("SELECT id FROM gateway_sessions WHERE task_id=? AND status='running'")
        .get(task.id);
      if (!running && ["done", "changes_requested", "paused", "blocked"].includes(state.status))
        break;
    }
    const ledger = getSqlite()
      .query("SELECT node_id,status,outcome,summary,error FROM flow_node_runs WHERE task_id=?")
      .all(task.id);
    const sessions = getSqlite()
      .query("SELECT status,runtime_session_id,last_error FROM gateway_sessions WHERE task_id=?")
      .all(task.id);
    results.push({ defective, scope, task, state, ledger, sessions });
    writeFileSync(join(directory, "report.json"), JSON.stringify({ results }, null, 2));
    const expected = defective ? "changes_requested" : "done";
    if (state.status !== expected)
      throw new Error(`Expected ${expected}, received ${state.status}`);
    if (
      !JSON.stringify(ledger).includes("verify.ts") ||
      !JSON.stringify(ledger).includes("subject.ts")
    )
      throw new Error("Review omitted executable/source evidence");
    console.log(JSON.stringify({ defective, status: state.status, ledger }));
  }
  console.log(`Real defect and clean review flows passed: ${directory}`);
} finally {
  for (const row of getSqlite()
    .query("SELECT id FROM gateway_sessions WHERE status='running'")
    .all() as { id: string }[])
    closeLiveSession(row.id);
  await server.stop(true);
  closeDb();
}
