/** Paid real-agent flow validation. Uses a private API and retained isolated database. */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../packages/api/src/server.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { closeLiveSession } from "../packages/runner/src/flow-runner.js";

const directory = resolve(import.meta.dir, "../.claude/tooling/sdlc-runtime", String(Date.now()));
mkdirSync(directory, { recursive: true });
process.env.ORC_LOG_DIR = join(directory, "logs");
const secret = randomUUID();
const initial = loadConfig();
loadConfig({
  activeProject: "",
  db: { path: join(directory, "orc.db") },
  api: { host: "127.0.0.1", port: 7711, secret },
  rules: { enabled: true },
  knowledge: {
    ...initial.knowledge,
    root: join(directory, "knowledge"),
    default_limit: 10,
  },
  agent_loop: {
    ...initial.agent_loop,
    enabled: false,
    default_backend: "claude",
    max_workers: 1,
    worker_auto_approve: true,
    max_node_retries: 0,
  },
});
const app = createApp();
const calls: {
  at: number;
  tool: string;
  project?: string | undefined;
  session_id?: string | undefined;
  owner_session?: string | undefined;
}[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7711,
  fetch: async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/mcp")) {
      const message = (await request
        .clone()
        .json()
        .catch(() => null)) as {
        method?: string;
        params?: { name?: string; arguments?: { project?: string; session_id?: string } };
      } | null;
      if (message?.method === "tools/call" && message.params?.name) {
        calls.push({
          at: Date.now(),
          tool: message.params.name,
          project: message.params.arguments?.project,
          session_id: message.params.arguments?.session_id,
          owner_session: (
            getSqlite()
              .query(
                "SELECT id FROM gateway_sessions WHERE status='running' ORDER BY created_at DESC LIMIT 1",
              )
              .get() as { id: string } | null
          )?.id,
        });
      }
    }
    return app.fetch(request);
  },
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
const MEMORY_LOOKUP = ["memory_list", "memory_read"];
const results: unknown[] = [];
const durable = process.env.ORC_VALIDATE_DURABLE === "1";
const backends = (process.env.ORC_VALIDATE_BACKENDS ?? "claude,codex-cli").split(",");
if (backends.some((backend) => !["claude", "codex-cli"].includes(backend)))
  throw new Error("Validation supports only claude and codex-cli");
try {
  for (const backend of backends) {
    const callStart = calls.length;
    const scope = mkdtempSync(join(tmpdir(), "orc-sdlc-runtime-"));
    writeFileSync(
      join(scope, "subject.ts"),
      "export function active(expires:number|null, now:number){return false;}\n",
    );
    writeFileSync(
      join(scope, "verify.ts"),
      "import {strict as assert} from 'node:assert'; import {active} from './subject'; assert.equal(active(null,100),true); assert.equal(active(101,100),true); assert.equal(active(100,100),false); assert.equal(active(99,100),false); console.log('Expiry contract passed');\n",
    );
    writeFileSync(
      join(scope, "CLAUDE.md"),
      "Isolated development project. Edit only subject.ts and verify.ts. Run bun verify.ts. No git, deletes or external effects. All workflow interaction uses supplied ORC MCP. Report declared outcomes without status mutations.\n",
    );
    writeFileSync(
      join(scope, "AGENTS.md"),
      "Read scoped ORC memory and wiki before implementation. Edit only subject.ts and verify.ts; run bun verify.ts. No git or deletes. Use supplied ORC MCP for progress and outcomes.\n",
    );
    const project = await request<{ id: string; name: string }>("/projects", {
      name: `sdlc-runtime-${backend}-${Date.now()}`,
      scope,
    });
    await request("/memories", {
      project_id: project.id,
      name: "expiry-convention",
      description: "Check before changing or verifying expiry comparisons",
      content:
        "Expiry convention: null means indefinitely active; equality with now is expired. Reuse the documented strictly-greater comparison.",
      priority: 90,
    });
    await request("/wiki", {
      project_id: project.id,
      slug: "expiry-contract",
      kind: "procedure",
      title: "Expiry verification",
      summary: "Verify the expiry boundary with bun verify.ts",
      content:
        "The expiry convention is null or strictly greater than now. Run bun verify.ts for executable null/equal/past/future checks.",
      note: "Seed existing project knowledge",
      expected_revision: 0,
      sources: ["verify.ts"],
    });
    const task = await request<{ id: string }>("/tasks", {
      title: "Implement expiry boundary",
      body: "Implement active() in subject.ts. Read and reuse existing scoped expiry knowledge before implementation; cite that reuse in a progress task comment. Record acceptance criteria, plan/progress and artifact/check evidence through task comments. Contract: null expiry remains active; expiry strictly greater than now is active; expiry equal to now or earlier is inactive. Run bun verify.ts. Review durable knowledge using audit_list and session_log before flow_report. Do not invent knowledge for quiet work units.\nReview subject.ts and verify.ts. Contract: null expiry remains active; expiry strictly greater than now is active; expiry equal to now or earlier is inactive. Run bun verify.ts and cite its observed result, relevant source file and concrete boundary input in flow_report summary. Workers may edit subject.ts; reviewers inspect and execute verification. Use orc-human-review's declared outcomes and complete the knowledge lifecycle with the supplied project and session ID.",
      project_id: project.id,
      skill_name: "orc-sdlc",
      agent_backend: backend,
      flow_name: "orc-human-review",
      required_review: true,
      max_review_rounds: 4,
    });
    const started = await request<{ started: boolean; error: string | null }>(
      `/tasks/${task.id}/flow`,
      { name: "orc-human-review", start: true },
    );
    if (!started.started) throw new Error(started.error ?? "Workflow failed to start");
    const deadline = Date.now() + 360000;
    let state: { status: string } = { status: "todo" };
    while (Date.now() < deadline) {
      await Bun.sleep(2000);
      state = await request(`/tasks/${task.id}`);
      const running = getSqlite()
        .query("SELECT id FROM gateway_sessions WHERE task_id=? AND status='running'")
        .get(task.id);
      if (
        !running &&
        ["done", "review", "changes_requested", "paused", "blocked"].includes(state.status)
      )
        break;
    }
    writeFileSync(
      join(directory, "checkpoint.json"),
      JSON.stringify(
        {
          backend,
          scope,
          task,
          state,
          calls,
          ledger: getSqlite().query("SELECT * FROM flow_node_runs").all(),
          sessions: getSqlite()
            .query("SELECT id,backend,status,runtime_session_id,last_error FROM gateway_sessions")
            .all(),
        },
        null,
        2,
      ),
    );
    if (state.status !== "review")
      throw new Error(`Initial delivery failed: ${JSON.stringify(state)}`);
    if (
      calls
        .slice(callStart)
        .some((call) => ["memory_create", "memory_update", "wiki_write"].includes(call.tool))
    )
      throw new Error("Quiet initial work unit invented knowledge writes");
    await request(`/tasks/${task.id}/flow/resume`, {
      outcome: "changes_requested",
      summary:
        "Add a zero-time boundary assertion to verify.ts: active(0,0) must be false. Run it and cite the added check. Keep subject.ts behavior unchanged." +
        (durable
          ? " Also update numeric task progress via task_update (80 after verification). After observing this new validation, record one project/session-scoped discovery about the expanded verification coverage with verify.ts as evidence, and revise expiry-contract to include the observed zero-time check. Use expected_revision and cite the actual check result; perform audit review of your writes and session_log before flow_report. This task explicitly requests the coverage record, not a new behavioral convention."
          : ""),
      author: "human",
    });
    const reworkDeadline = Date.now() + 360000;
    while (Date.now() < reworkDeadline) {
      await Bun.sleep(2000);
      const waiting = getSqlite()
        .query("SELECT id FROM flow_node_runs WHERE task_id=? AND status='awaiting_human'")
        .get(task.id);
      if (waiting) break;
      const current = await request<{ status: string }>(`/tasks/${task.id}`);
      if (["blocked", "paused"].includes(current.status))
        throw new Error(`Rework failed: ${JSON.stringify(current)}`);
    }
    const check = Bun.spawn(["bun", "verify.ts"], {
      cwd: scope,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const checkOutput = await new Response(check.stdout).text();
    if ((await check.exited) !== 0) throw new Error("Artifact verification failed");
    const independentCheck = join(directory, `verify-${backend}.ts`);
    writeFileSync(
      independentCheck,
      `import {strict as assert} from 'node:assert'; import {active} from ${JSON.stringify(pathToFileURL(join(scope, "subject.ts")).href)}; for(const [expiry,now,expected] of [[null,100,true],[101,100,true],[100,100,false],[99,100,false],[0,0,false],[-1,-1,false],[-1,-2,true],[100.1,100,true]]) assert.equal(active(expiry,now),expected); console.log('Independent acceptance checks passed');`,
    );
    const independent = Bun.spawn(["bun", independentCheck], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const independentOutput = await new Response(independent.stdout).text();
    if ((await independent.exited) !== 0)
      throw new Error("Independent predicate acceptance checks failed");
    const verifySource = await Bun.file(join(scope, "verify.ts")).text();
    if (!/active\(\s*0\s*,\s*0\s*\)/.test(verifySource))
      throw new Error("Human feedback was not implemented");
    await request(`/tasks/${task.id}/flow/resume`, {
      outcome: "approved",
      summary: "Artifact and zero-time boundary verified",
      author: "human",
    });
    state = await request(`/tasks/${task.id}`);
    const ledger = getSqlite()
      .query("SELECT node_id,status,outcome,summary,error FROM flow_node_runs WHERE task_id=?")
      .all(task.id);
    const sessions = getSqlite()
      .query("SELECT id,status,runtime_session_id,last_error FROM gateway_sessions WHERE task_id=?")
      .all(task.id);
    const knowledgeCalls = calls.slice(callStart);
    for (const session of sessions as { id: string }[]) {
      const unitCalls = knowledgeCalls.filter((call) => call.owner_session === session.id);
      const names = unitCalls.map((call) => call.tool);
      for (const required of ["context", "wiki_search", "audit_list", "session_log", "flow_report"])
        if (!names.includes(required))
          throw new Error(`${backend}/${session.id} skipped ${required}`);
      const memoryLookup = names.findIndex((name) => MEMORY_LOOKUP.includes(name));
      if (memoryLookup < 0) throw new Error(`${backend}/${session.id} skipped memory lookup`);
      if (
        names.indexOf("context") > memoryLookup ||
        names.indexOf("session_log") > names.indexOf("flow_report")
      )
        throw new Error("Work-unit lifecycle order violated");
      if (
        !unitCalls.some(
          (call) =>
            call.tool === "audit_list" &&
            call.project === project.name &&
            call.session_id === session.id,
        )
      )
        throw new Error("Work-unit audit used wrong scope/session");
    }
    if (durable) {
      const page = await request<{ revision: number; content: string }>(
        `/wiki/expiry-contract?project_id=${project.id}`,
      );
      if (page.revision < 2 || !page.content.includes("0"))
        throw new Error("Observed coverage was not saved to wiki");
      const discoveries = getSqlite()
        .query("SELECT id,content FROM memories WHERE project_id=? AND type='discovery'")
        .all(project.id);
      if (!discoveries.length) throw new Error("Requested coverage discovery absent");
      const progress = getSqlite().query("SELECT progress FROM tasks WHERE id=?").get(task.id) as {
        progress: number;
      };
      if (progress.progress < 80) throw new Error("Numeric task progress was not tracked");
    }
    const beforeReopen = {
      task: await request(`/tasks/${task.id}`),
      wiki: await request(`/wiki/expiry-contract?project_id=${project.id}`),
      memories: await request(`/memories?project_id=${project.id}`),
    };
    closeDb();
    const afterReopen = {
      task: await request(`/tasks/${task.id}`),
      wiki: await request(`/wiki/expiry-contract?project_id=${project.id}`),
      memories: await request(`/memories?project_id=${project.id}`),
    };
    if (JSON.stringify(beforeReopen) !== JSON.stringify(afterReopen))
      throw new Error("Saved task/knowledge did not survive DB close/reopen");
    results.push({
      backend,
      scope,
      task,
      state,
      ledger,
      sessions,
      knowledgeCalls,
      checkOutput,
      independentOutput,
      verifySource,
      comments: await request(`/tasks/${task.id}/comments`),
      wiki: await request(`/wiki/expiry-contract?project_id=${project.id}`),
    });
    writeFileSync(join(directory, "report.json"), JSON.stringify({ results }, null, 2));
    const expected = "done";
    if (state.status !== expected)
      throw new Error(`Expected ${expected}, received ${state.status}`);
    if (
      !JSON.stringify(ledger).includes("verify.ts") ||
      !JSON.stringify(ledger).includes("subject.ts")
    )
      throw new Error("Review omitted executable/source evidence");
    const names = knowledgeCalls.map((call) => call.tool);
    for (const required of ["context", "wiki_search", "audit_list", "session_log", "flow_report"]) {
      if (!names.includes(required))
        throw new Error(`Review skipped knowledge lifecycle tool: ${required}`);
    }
    const memoryLookup = names.findIndex((name) => MEMORY_LOOKUP.includes(name));
    if (memoryLookup < 0) throw new Error("Review skipped memory lookup (memory_list/memory_read)");
    if (names.indexOf("context") > memoryLookup)
      throw new Error("Knowledge search preceded context");
    if (names.indexOf("flow_report") < names.indexOf("session_log"))
      throw new Error("Flow outcome preceded knowledge review");
    const session = getSqlite()
      .query("SELECT id FROM gateway_sessions WHERE task_id=?")
      .get(task.id) as { id: string };
    if (
      !knowledgeCalls.some(
        (call) =>
          call.tool === "audit_list" &&
          call.project === project.name &&
          call.session_id === session.id,
      )
    ) {
      throw new Error("Memory audit used the wrong project or work-unit session");
    }
    console.log(JSON.stringify({ backend, status: state.status, ledger }));
  }
  console.log(`Real SDLC lifecycle, artifact and save/reopen checks passed: ${directory}`);
} finally {
  writeFileSync(
    join(directory, "final-state.json"),
    JSON.stringify(
      {
        results,
        calls,
        tasks: getSqlite().query("SELECT id,status,progress FROM tasks").all(),
        ledger: getSqlite()
          .query(
            "SELECT node_id,status,outcome,summary,error,gateway_session_id FROM flow_node_runs",
          )
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
}
