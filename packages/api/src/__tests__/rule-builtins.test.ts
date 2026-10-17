import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuleTemplate } from "@orc/core/rule-catalog";
import { getSqlite } from "@orc/db/client";
import { MemoryStore } from "@orc/db/memories";
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

const nativeMemory = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\ntype: feedback\n---\n\n${body}\n`;

test("should import native topic memory once, update the same record and expose it through shared MCP search", async () => {
  const topic = join(source, "feedback_testing.md");
  writeFileSync(join(source, "MEMORY.md"), "Native index links only");
  writeFileSync(
    topic,
    nativeMemory(
      "feedback_testing",
      "crossagentneedle reopen saved artifacts",
      "Validate saved artifacts by reopening them.",
    ),
  );
  const written = event("memory-write", "post_tool", { file_path: topic });
  expect((await run("claude-share-memory", written)).status).toBe(200);
  expect((await run("claude-share-memory", written)).status).toBe(200);
  const rows = () =>
    getSqlite()
      .query<{ project_id: string; name: string; content: string; author: string }, []>(
        "SELECT project_id,name,content,author FROM memories",
      )
      .all();
  expect(rows()).toEqual([
    {
      project_id: projectId,
      name: "feedback-testing",
      content: "Validate saved artifacts by reopening them.",
      author: "claude-memory-sync",
    },
  ]);
  writeFileSync(
    topic,
    nativeMemory(
      "feedback_testing",
      "crossagentneedle reopen saved artifacts",
      "Validate saved artifacts by reopening and measuring them.",
    ),
  );
  expect(
    (await run("claude-share-memory", event("memory-update", "post_tool", { file_path: topic })))
      .status,
  ).toBe(200);
  expect(rows().map((row) => [row.name, row.content])).toEqual([
    ["feedback-testing", "Validate saved artifacts by reopening and measuring them."],
  ]);
  const history = new MemoryStore(getSqlite()).history(projectId, "feedback-testing");
  expect(history.map((change) => [change.action, change.session_id])).toEqual([
    ["memory.updated", "native-session"],
    ["memory.created", "native-session"],
  ]);
  const result = await executeTool("search", {
    query: "crossagentneedle",
    resources: ["memories"],
    project: "builtin-project",
    limit: 10,
  });
  expect(result).toContain("[memory] feedback-testing (project: builtin-project)");
  expect(JSON.stringify(new RuleStore(getSqlite()).decisions())).not.toContain("crossagentneedle");
});

test("should skip a native memory without a description and say why", async () => {
  const topic = join(source, "no_description.md");
  writeFileSync(topic, "---\nname: no_description\n---\n\nBody only.\n");
  const response = await run(
    "claude-share-memory",
    event("memory-no-description", "post_tool", { file_path: topic }),
  );
  expect(response.status).toBe(200);
  const body = await response.json<{ context: string[] }>();
  expect(body.context.join("\n")).toContain("Frontmatter description is required");
  expect(getSqlite().query("SELECT 1 FROM memories WHERE name='no-description'").get()).toBeNull();
});

test("should rescan native memory at session end", async () => {
  writeFileSync(
    join(source, "project-notes.md"),
    nativeMemory(
      "project_notes",
      "Project notes",
      "sessionendneedle retained from a non-tool write.",
    ),
  );
  expect((await run("claude-share-memory", event("session-end-sync", "session_end"))).status).toBe(
    200,
  );
  expect(new MemoryStore(getSqlite()).get(projectId, "project-notes").content).toContain(
    "sessionendneedle",
  );
});
