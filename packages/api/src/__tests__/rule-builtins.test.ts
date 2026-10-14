import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuleTemplate } from "@orc/core/rule-catalog";
import { getSqlite } from "@orc/db/client";
import { DIGEST_JOB_NAME } from "@orc/db/digest";
import { RuleStore } from "@orc/db/rules";
import { executeTool } from "@orc/mcp/tools";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const workspace = mkdtempSync(join(tmpdir(), "orc-builtins-"));
const source = join(workspace, "native-memory");
let revision: string;
let projectId: string;
beforeAll(async () => {
  app = setupTestApp();
  mkdirSync(source);
  const project = await (await req(app, "POST", "/projects", { name: "builtin-project" })).json<{
    id: string;
  }>();
  projectId = project.id;
  const rules = [
    "orc-load-context",
    "orc-record-events",
    "orc-snapshot",
    "orc-restore",
    "claude-share-memory",
    "orc-wiki-learning",
  ].map(copyRuleTemplate);
  const memory = rules.find((rule) => rule.id === "claude-share-memory");
  if (memory?.target.type === "orc_action") memory.target.memory_directory = source;
  revision = new RuleStore(getSqlite()).activate(
    { workspace, project_id: projectId, rules },
    null,
    "Builtin validation",
  ).id;
});
afterAll(teardownTestApp);
const event = (
  id: string,
  phase: string,
  input: Record<string, unknown> = {},
  payload?: Record<string, unknown>,
) => ({
  id,
  session_id: "native-session",
  backend: "claude",
  cwd: workspace,
  phase,
  input,
  tool: "Write",
  ...(payload ? { payload } : {}),
});
const run = (rule_id: string, input: ReturnType<typeof event>) =>
  req(app, "POST", "/rules/actions/run", { revision_id: revision, rule_id, event: input });

test("should authenticate builtins and reject stale, mismatched and outside-workspace actions", async () => {
  expect(
    (
      await app.request("/api/rules/actions/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision_id: revision,
          rule_id: "orc-load-context",
          event: event("unauth", "session_start"),
        }),
      })
    ).status,
  ).toBe(401);
  expect((await run("orc-load-context", event("wrong-phase", "post_tool"))).status).toBe(400);
  expect(
    (await run("orc-load-context", { ...event("outside", "session_start"), cwd: tmpdir() })).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/rules/actions/run", {
        revision_id: "stale",
        rule_id: "orc-load-context",
        event: event("stale", "session_start"),
      })
    ).status,
  ).toBe(400);
});

test("should record once, create one scoped snapshot, restore it and keep fetched context out of rule history", async () => {
  const scoped = await (
    await req(app, "POST", "/tasks", { title: "continuity-private-title", project_id: projectId })
  ).json();
  await req(app, "POST", "/tasks", { title: "other-project-hidden-title" });
  const started = await run(
    "orc-load-context",
    event("startup", "session_start", {}, { source: "startup" }),
  );
  expect(started.status).toBe(200);
  expect((await started.json()).context.join("")).toContain(scoped.title);
  const written = event("write", "post_tool", {
    file_path: join(workspace, "changed.ts"),
    content: "not retained",
  });
  expect((await run("orc-record-events", written)).status).toBe(200);
  expect((await run("orc-record-events", written)).status).toBe(200);
  expect(
    getSqlite().query<{ n: number }, []>("SELECT count(*) AS n FROM session_events").get()?.n,
  ).toBe(1);
  const compact = event("compact", "pre_compact");
  expect((await run("orc-snapshot", compact)).status).toBe(200);
  expect((await run("orc-snapshot", compact)).status).toBe(200);
  expect(
    getSqlite().query<{ n: number }, []>("SELECT count(*) AS n FROM session_snapshots").get()?.n,
  ).toBe(1);
  const restored = await run(
    "orc-restore",
    event("resume", "session_start", {}, { source: "compact" }),
  );
  const context = (await restored.json()).context.join("");
  expect(context).toContain(scoped.title);
  expect(context).not.toContain("other-project-hidden-title");
  expect(JSON.stringify(new RuleStore(getSqlite()).decisions())).not.toContain(scoped.title);
});

test("should import native topic memory once, update the same record and expose it through shared MCP search", async () => {
  const topic = join(source, "feedback-testing.md");
  writeFileSync(join(source, "MEMORY.md"), "Native index links only");
  writeFileSync(topic, "crossagentneedle validate saved artifacts by reopening them.");
  const written = event("memory-write", "post_tool", { file_path: topic });
  expect((await run("claude-share-memory", written)).status).toBe(200);
  expect((await run("claude-share-memory", written)).status).toBe(200);
  let notes = getSqlite()
    .query<{ id: string; content: string; source: string }, []>(
      "SELECT id,content,source FROM memories",
    )
    .all();
  expect(notes).toHaveLength(1);
  const id = notes[0]?.id;
  expect(notes[0]?.source).toContain("claude:auto-memory:");
  writeFileSync(
    topic,
    "crossagentneedle validate saved artifacts by reopening and measuring them.",
  );
  expect(
    (await run("claude-share-memory", event("memory-update", "post_tool", { file_path: topic })))
      .status,
  ).toBe(200);
  notes = getSqlite()
    .query<{ id: string; content: string; source: string }, []>(
      "SELECT id,content,source FROM memories",
    )
    .all();
  expect(notes).toHaveLength(1);
  expect(notes[0]?.id).toBe(id);
  const result = await executeTool("memory_search", {
    query: "crossagentneedle",
    project: "builtin-project",
    limit: 10,
  });
  expect(result).toContain(id ?? "missing");
  const history = JSON.stringify(new RuleStore(getSqlite()).decisions());
  expect(history).not.toContain("crossagentneedle");
});

test("should rescan at session end, queue one existing digest and coalesce repeated requests", async () => {
  writeFileSync(
    join(source, "project-notes.md"),
    "sessionendneedle retained from a non-tool memory write.",
  );
  expect((await run("claude-share-memory", event("session-end-sync", "session_end"))).status).toBe(
    200,
  );
  const queued = await run("orc-wiki-learning", event("session-end-digest", "session_end"));
  expect(queued.status).toBe(200);
  expect((await run("orc-wiki-learning", event("next-session-end", "session_end"))).status).toBe(
    200,
  );
  const actions = new RuleStore(getSqlite()).actions();
  expect(actions).toHaveLength(1);
  const job = getSqlite()
    .query<{ name: string }, [string]>("SELECT name FROM jobs WHERE id=?")
    .get(actions[0]?.job_id ?? "");
  expect(job?.name).toBe(DIGEST_JOB_NAME);
  expect(getSqlite().query("SELECT id FROM job_runs").all()).toHaveLength(0);
});
