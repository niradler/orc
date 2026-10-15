import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AgentEvent, createBackend } from "../packages/agent-runtime/src/index.js";
import { createApp } from "../packages/api/src/server.js";
import { loadConfig, resetConfig } from "../packages/core/src/config.js";
import { copyRuleTemplate } from "../packages/core/src/rule-catalog.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { DigestStore } from "../packages/db/src/digest.js";
import { RuleStore } from "../packages/db/src/rules.js";
import { executeTool } from "../packages/mcp/src/tools.js";
import { drainRuleActions } from "../packages/runner/src/rule-actions.js";

const directory = resolve(".claude/tooling/command-processors", `builtin-runtime-${Date.now()}`);
const workspace = join(directory, "workspace");
const source = join(workspace, "claude-memory");
mkdirSync(source, { recursive: true });
Object.assign(process.env, {
  ORC_DB_PATH: join(directory, "orc.db"),
  ORC_KNOWLEDGE_DB_PATH: join(directory, "knowledge.db"),
  ORC_API_HOST: "127.0.0.1",
  ORC_API_PORT: "7701",
  ORC_API_BASE: "http://127.0.0.1:7701",
  ORC_API_SECRET: randomUUID(),
  ORC_RULES_ENABLED: "true",
  ORC_ACTIVE_PROJECT: "",
  ORC_AGENT_LOOP_ENABLED: "0",
  ORC_AGENT_LOOP_DEFAULT_BACKEND: "claude",
  ORC_SSH_HOST: "",
});
resetConfig();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 7701,
  idleTimeout: 255,
  fetch: createApp().fetch,
});
const db = getSqlite();
const store = new RuleStore(db);
const headers = {
  Authorization: `Bearer ${loadConfig().api.secret}`,
  "Content-Type": "application/json",
};
const projectResponse = await fetch("http://127.0.0.1:7701/api/projects", {
  method: "POST",
  headers,
  body: JSON.stringify({ name: "builtin-runtime", scope: workspace }),
});
const project = (await projectResponse.json()) as { id: string };
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
store.activate({ workspace, project_id: project.id, rules }, null, "Native continuity validation");
const token = `SHARED_${randomUUID().replaceAll("-", "")}`;
const topic = join(source, "feedback-testing.md");
const trace: unknown[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function hook(
  event: string,
  input: Record<string, unknown>,
  legacy?: string,
): Promise<Record<string, unknown>> {
  const command = legacy
    ? [process.execPath, resolve("hooks", legacy)]
    : [process.execPath, resolve("packages/cli/src/index.ts"), "rules", "hook", "claude", event];
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
    windowsHide: true,
  });
  child.stdin.write(
    JSON.stringify({
      session_id: "native-proof",
      cwd: workspace,
      hook_event_name: event,
      ...input,
    }),
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  trace.push({ event, legacy, stdout, stderr, exit });
  assert(exit === 0 && !stderr.includes("unavailable"), `Native hook failed: ${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}
const events: AgentEvent[] = [];
let session: Awaited<ReturnType<ReturnType<typeof createBackend>["startSession"]>> | undefined;
const deadline = setTimeout(() => {
  void session?.close();
  server.stop(true);
}, 240000);
try {
  await hook("SessionStart", { source: "startup", event_id: "start" }, "session-start.ts");
  session = await createBackend("claude").startSession({
    cwd: workspace,
    model: "haiku",
    autoApprove: true,
    systemPromptAppend:
      "Authorized isolated rule integration probe. Use only the exact Write tool call requested. No task, workflow or memory-management tools are needed. Do not use Bash.",
  });
  await session.send(
    `Use Write once to save this exact memory topic to ${topic}: "${token}: Verified memory update procedure: match the configured Markdown source directory, preserve source identity on update, and verify the saved shared note by retrieving it through ORC. This observation is specific to this integration probe." Then report success.`,
  );
  for await (const event of session.events()) events.push(event);
  await session.close();
  session = undefined;
  assert(
    readFileSync(topic, "utf8").includes(token),
    "Actual agent did not write the source memory",
  );
  const captured = db
    .query<{ id: string; content: string }, [string]>(
      "SELECT id,content FROM memories WHERE project_id=?",
    )
    .all(project.id);
  const capturedMemory = captured[0];
  assert(
    captured.length === 1 && capturedMemory !== undefined && capturedMemory.content.includes(token),
    "Write hook did not share the memory",
  );
  const id = capturedMemory.id;
  writeFileSync(
    topic,
    `${readFileSync(topic, "utf8")}\nUpdate: keep a single shared record for this file.`,
  );
  await hook(
    "PostToolUse",
    {
      tool_use_id: "updated-topic",
      tool_name: "Edit",
      tool_input: { file_path: topic },
      tool_response: {},
    },
    "post-tool-use.ts",
  );
  assert(
    db
      .query<{ id: string }, [string]>("SELECT id FROM memories WHERE project_id=?")
      .all(project.id)
      .at(0)?.id === id,
    "Source update created a duplicate memory",
  );
  const fetched = await executeTool("memory_search", {
    query: token,
    project: "builtin-runtime",
    limit: 10,
  });
  assert(fetched.includes(id), "Shared MCP retrieval did not expose captured memory");
  await hook("PreCompact", { event_id: "compact", trigger: "manual" }, "pre-compact.ts");
  const restored = await hook("SessionStart", { event_id: "restore", source: "compact" });
  assert(
    JSON.stringify(restored).includes("Session Restored"),
    "Snapshot did not return through native context response",
  );
  await hook("SessionEnd", { event_id: "end" });
  assert(
    store.actions().some((action) => action.status === "pending"),
    "Learning hook did not queue the existing digest",
  );
  if (process.argv.includes("--real-digest")) {
    await drainRuleActions();
    assert(
      store.actions().every((action) => action.status === "done"),
      "Real digest dispatch failed",
    );
    assert(
      new DigestStore(db).claim(project.id) === null,
      "Real digest did not advance its scoped watermark",
    );
    const agents = db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM gateway_sessions WHERE mode='knowledge-digest'",
      )
      .get()?.count;
    await hook("SessionEnd", { event_id: "idle-end" });
    assert(
      db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM gateway_sessions WHERE mode='knowledge-digest'",
        )
        .get()?.count === agents,
      "Idle hook started a new agent",
    );
  }
  const report = {
    passed: true,
    nativeHooks: trace,
    sourceCaptured: true,
    stableMemoryId: id,
    sharedRetrieval: fetched,
    actualWriteEvents: events,
    actions: store.actions(),
    decisions: store.decisions(),
    realDigest: process.argv.includes("--real-digest"),
    wiki: db.query("SELECT slug,title,summary FROM wiki_pages WHERE project_id=?").all(project.id),
  };
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      sourceCaptured: true,
      stableSourceUpdate: true,
      nativeSnapshotRestore: true,
      sharedMemoryRetrievable: true,
      realDigest: report.realDigest,
      wikiPages: report.wiki.length,
      directory,
    }),
  );
} catch (error) {
  writeFileSync(
    join(directory, "failure.json"),
    JSON.stringify(
      {
        error: String(error),
        trace,
        events,
        decisions: store.decisions(),
        actions: store.actions(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  clearTimeout(deadline);
  await session?.close();
  server.stop(true);
  closeDb();
}
