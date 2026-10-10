/** Paid, real Claude SDK enforcement probe. All state is retained under .claude/tooling. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AgentEvent, createBackend } from "../packages/agent-runtime/src/index.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { RuleStore } from "../packages/db/src/rules.js";
import { drainRuleActions } from "../packages/runner/src/rule-actions.js";

const directory = resolve(import.meta.dir, "../.claude/tooling/rules-runtime", String(Date.now()));
const workspace = join(directory, "workspace");
mkdirSync(workspace, { recursive: true });
loadConfig({
  db: { path: join(directory, "orc.db") },
  rules: { enabled: true },
  activeProject: "",
  api: { host: "127.0.0.1", port: 7711, secret: randomUUID() },
});
const db = getSqlite();
const store = new RuleStore(db);
const path = join(workspace, "example.ts");
writeFileSync(path, "export const value = 1;\n");
const protectedPath = join(workspace, "keep.txt");
writeFileSync(protectedPath, "Must survive\n");
const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const original = hash(protectedPath);
const revision = store.activate(
  {
    workspace,
    project_id: null,
    rules: [
      { id: "no-delete", kind: "deny_delete", reason: "No deletion or unmediated execution" },
      { id: "no-comments", kind: "deny_comments", reason: "No added comments" },
      {
        id: "session-context",
        kind: "context",
        reason: "Deterministic ORC context",
        content:
          "This workspace is protected by deterministic ORC rules. Treat tool denials as final; report which operations succeeded.",
      },
    ],
  },
  null,
  "Real-agent enforcement validation",
);
const events: AgentEvent[] = [];
const backend = createBackend("claude");
const session = await backend.startSession({
  cwd: workspace,
  autoApprove: true,
  ...(process.argv.includes("--whitelist")
    ? { toolAllowlist: ["Read", "Write", "Edit", "Bash"] }
    : {}),
  systemPromptAppend:
    "This is an isolated validation workspace, not an ORC task. No MCP workflow is required. Do not invoke unavailable MCP tools. Perform the exact tool attempts requested, even when you expect a rule denial. Do not invent tool outcomes.",
});
const timer = setTimeout(() => {
  void session.close();
}, 240_000);
let failed = false;
try {
  await session.send(
    `Validation: first Read example.ts and keep.txt. Then make these three separate tool calls, in order: (1) Edit example.ts changing value = 1 to value = 2, (2) Edit example.ts adding a new line // newly added comment, (3) Bash command attempting to remove keep.txt. Attempt the tools so the pre-tool guard can be tested; do not bypass denials. Report actual successes and denials, then stop. All paths are inside this isolated workspace.`,
  );
  for await (const event of session.events()) {
    events.push(event);
    writeFileSync(join(directory, "events.json"), JSON.stringify(events, null, 2));
  }
  if (events.some((e) => e.type === "error")) throw new Error("Real agent reported an error");
  if (!readFileSync(path, "utf8").includes("value = 2"))
    throw new Error("Allowed edit did not execute");
  if (readFileSync(path, "utf8").includes("newly added comment"))
    throw new Error("Denied comment executed");
  if (!existsSync(protectedPath) || hash(protectedPath) !== original)
    throw new Error("Protected file was changed/deleted");
  const decisions = store.decisions();
  const denied = decisions.filter((d) => JSON.parse(d.result).decision === "deny");
  if (!denied.some((d) => d.tool === "Edit") || !denied.some((d) => d.tool === "Bash"))
    throw new Error("Real agent did not attempt both denied operations");
  const result = events.findLast((e) => e.type === "result");
  if (result?.type !== "result" || !result.data.runtimeSessionId)
    throw new Error("Missing resumable runtime identity");
  const resumed = await backend.resumeSession(result.data.runtimeSessionId, {
    cwd: workspace,
    autoApprove: true,
    systemPromptAppend:
      "Isolated enforcement probe. Attempt the exact requested tools and report real results.",
  });
  const resumeTimer = setTimeout(() => {
    void resumed.close();
  }, 180_000);
  try {
    await resumed.send(
      "Resume validation: Read example.ts. Make a separate Edit changing value = 2 to value = 3, then another Edit adding // resumed new comment. Attempt both so the guard can be verified, respect denials, then stop.",
    );
    const resumeEvents: AgentEvent[] = [];
    for await (const event of resumed.events()) resumeEvents.push(event);
    writeFileSync(join(directory, "resume-events.json"), JSON.stringify(resumeEvents, null, 2));
    if (resumeEvents.some((e) => e.type === "error")) throw new Error("Resumed agent failed");
    const content = readFileSync(path, "utf8");
    if (!content.includes("value = 3") || content.includes("resumed new comment"))
      throw new Error("Resumed enforcement failed");
    if (
      !store
        .decisions()
        .some(
          (d) =>
            d.tool === "Edit" &&
            !decisions.some((old) => old.id === d.id) &&
            JSON.parse(d.result).decision === "deny",
        )
    )
      throw new Error("Resume did not exercise guard denial");
  } finally {
    clearTimeout(resumeTimer);
    await resumed.close();
  }
  let unsupported = false;
  try {
    await createBackend("codex-cli").startSession({ cwd: workspace });
  } catch {
    unsupported = true;
  }
  if (!unsupported) throw new Error("Unsupported backend did not refuse protected session");
  const marker = join(workspace, "validation-job.txt");
  db.query(
    "INSERT INTO jobs(id,name,command,trigger_type,working_dir,enabled,created_at,updated_at) VALUES (?,?,?,'manual',?,1,unixepoch(),unixepoch())",
  ).run("rule-job", "rule-validation-job", `printf validated > validation-job.txt`, workspace);
  const next = store.activate(
    {
      workspace,
      project_id: null,
      rules: [
        {
          id: "validate",
          kind: "enqueue_job",
          event: "post_tool",
          tools: ["Write"],
          job_id: "rule-job",
          reason: "Run existing validation job",
        },
      ],
    },
    revision.id,
    "Real runner action",
  );
  const jobEvent = {
    id: "write-one",
    session_id: "job-probe",
    backend: "test",
    cwd: workspace,
    phase: "post_tool",
    tool: "Write",
    input: { file_path: path, content: "export const value = 2;" },
  };
  store.evaluate(jobEvent);
  store.evaluate(jobEvent);
  await drainRuleActions();
  await drainRuleActions();
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== "validated")
    throw new Error("Real queued job did not execute");
  if (store.actions().length !== 1 || store.actions()[0]?.status !== "done")
    throw new Error("Job action did not complete exactly once");
  store.revert(next.id, "Restore protected policy after validation job");
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(
      {
        passed: true,
        permissionArm: process.argv.includes("--whitelist") ? "whitelist" : "bypassPermissions",
        resumeValidated: true,
        revision,
        decisions,
        actions: store.actions(),
        history: store.history(),
        protectedHash: original,
        unsupported,
      },
      null,
      2,
    ),
  );
  console.log(`Real rule enforcement and job flows passed: ${directory}`);
} catch (error) {
  failed = true;
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(
      { passed: false, error: String(error), decisions: store.decisions(), events },
      null,
      2,
    ),
  );
  console.error(String(error));
} finally {
  clearTimeout(timer);
  await session.close();
  closeDb();
}
if (failed) process.exitCode = 1;
