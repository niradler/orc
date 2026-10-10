/** Real Claude SDK probe of flexible rules; uses isolated DB/workspaces and harmless writes. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AgentEvent, createBackend } from "../packages/agent-runtime/src/index.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { RuleStore } from "../packages/db/src/rules.js";
import { drainRuleActions } from "../packages/runner/src/rule-actions.js";

const directory = resolve(
  import.meta.dir,
  "../.claude/tooling/event-rules-runtime",
  String(Date.now()),
);
mkdirSync(directory, { recursive: true });
loadConfig({
  db: { path: join(directory, "orc.db") },
  rules: { enabled: true },
  activeProject: "",
  api: { host: "127.0.0.1", port: 7711, secret: randomUUID() },
});
const db = getSqlite();
const store = new RuleStore(db);
const reports: unknown[] = [];
function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
try {
  for (const arm of ["bypassPermissions", "whitelist"] as const) {
    const workspace = join(directory, arm);
    mkdirSync(workspace);
    writeFileSync(join(workspace, "fixture.txt"), "Read this harmless fixture.\n");
    const token = `context-${randomUUID()}`;
    const jobId = `validation-${arm}`;
    db.query(
      "INSERT INTO jobs(id,name,command,trigger_type,working_dir,enabled,created_at,updated_at) VALUES (?,?,?,'manual',?,1,unixepoch(),unixepoch())",
    ).run(jobId, jobId, "printf job > job-marker.txt", workspace);
    const filter = (field: string, value: string) => ({
      match: "all",
      conditions: [{ predicate: { field, operator: "contains", value } }],
    });
    const base = { kind: "event", enabled: true, reason: "Real agent validation" };
    const revision = store.activate(
      {
        workspace,
        project_id: null,
        rules: [
          {
            ...base,
            id: "block-command",
            scope: { agents: "all", events: ["pre_tool"] },
            filter: {
              match: "all",
              conditions: [
                {
                  predicate: {
                    field: "input.command",
                    operator: "regex",
                    value: "blocked-marker\\.txt",
                  },
                },
              ],
            },
            target: { type: "block" },
          },
          {
            ...base,
            id: "context",
            scope: { agents: ["claude"], events: ["session_start"] },
            filter: { match: "all", conditions: [] },
            target: {
              type: "inject_context",
              content: `Include this verification token in your final report: ${token}`,
            },
          },
          {
            ...base,
            id: "sync-script",
            scope: { agents: ["claude"], events: ["pre_tool"] },
            filter: filter("input.command", "sync-marker.txt"),
            target: {
              type: "script",
              mode: "sync",
              timeout_ms: 1000,
              argv: [
                process.execPath,
                "-e",
                "const e=JSON.parse(await Bun.stdin.text());await Bun.write('sync-received.txt',e.input.command);console.log(JSON.stringify({decision:'deny',reason:'Synchronous script rejected marker',context:['Synchronous decision script received the real tool event.']}));",
              ],
            },
          },
          {
            ...base,
            id: "job",
            scope: { agents: ["claude"], events: ["post_tool"] },
            filter: filter("input.command", "allowed-marker.txt"),
            target: { type: "job", job_id: jobId },
          },
          {
            ...base,
            id: "background-script",
            scope: { agents: ["claude"], events: ["post_tool"] },
            filter: filter("input.file_path", "fixture.txt"),
            target: {
              type: "script",
              mode: "background",
              timeout_ms: 2000,
              argv: [
                process.execPath,
                "-e",
                "const e=JSON.parse(await Bun.stdin.text());await Bun.write('background-received.txt',e.input.file_path);",
              ],
            },
          },
        ],
      },
      null,
      `Real ${arm} event-rule validation`,
    );
    const events: AgentEvent[] = [];
    const backend = createBackend("claude");
    const session = await backend.startSession({
      cwd: workspace,
      autoApprove: true,
      ...(arm === "whitelist" ? { toolAllowlist: ["Read", "Bash"] } : {}),
      systemPromptAppend:
        "This is an authorized isolated hook validation, not an ORC task. No MCP/CLI workflow is required. Make the exact harmless tool calls requested even if a hook denies them; never bypass a denial or use alternative tools. Report actual outcomes and any verification token provided by hook context.",
    });
    const timer = setTimeout(() => {
      void session.close();
    }, 180000);
    try {
      await session.send(
        "Validate hooks with four separate calls, in order: (1) Read fixture.txt; (2) Bash: printf allowed > allowed-marker.txt; (3) Bash: printf blocked > blocked-marker.txt; (4) Bash: printf sync > sync-marker.txt. Calls 3 and 4 are safe marker writes deliberately meant to trigger hook denials. Attempt each exactly once, respect all denials, do not use any alternative tools. Finally report the actual results and the verification token provided by session hook context.",
      );
      for await (const event of session.events()) {
        events.push(event);
        writeFileSync(join(workspace, "events.json"), JSON.stringify(events, null, 2));
      }
      require(!events.some((event) => event.type === "error"), `${arm}: agent failed`);
      require(events.some((event) => event.type === "result"), `${arm}: agent did not complete`);
      require(readFileSync(join(workspace, "allowed-marker.txt"), "utf8") ===
        "allowed", `${arm}: allowed call did not execute`);
      require(!existsSync(
        join(workspace, "blocked-marker.txt"),
      ), `${arm}: regex-blocked command executed`);
      require(!existsSync(
        join(workspace, "sync-marker.txt"),
      ), `${arm}: sync-denied command executed`);
      require(readFileSync(join(workspace, "sync-received.txt"), "utf8").includes(
        "sync-marker.txt",
      ), `${arm}: script did not receive real tool input`);
      require(events.some(
        (event) => event.type === "text" && event.data.includes(token),
      ), `${arm}: injected context token not observed by agent`);
      const decisions = store.decisions(workspace);
      for (const id of ["block-command", "sync-script"])
        require(decisions.some((decision) => {
          const result = JSON.parse(decision.result);
          return (
            decision.tool === "Bash" &&
            result.decision === "deny" &&
            result.reasons.some((reason: { rule_id: string }) => reason.rule_id === id)
          );
        }), `${arm}: missing real ${id} denial`);
      const beforeReplay = store.actions(workspace).length;
      const uses = events.filter((event) => event.type === "tool_use");
      require(uses.filter((event) => event.data.name === "Bash").length ===
        3, `${arm}: expected three actual Bash attempts`);
      require(beforeReplay === 2, `${arm}: real events did not enqueue both targets exactly once`);
      await drainRuleActions();
      await drainRuleActions();
      require(readFileSync(join(workspace, "job-marker.txt"), "utf8") ===
        "job", `${arm}: ORC job did not execute`);
      require(readFileSync(join(workspace, "background-received.txt"), "utf8").includes(
        "fixture.txt",
      ), `${arm}: background script did not receive real tool input`);
      require(store.actions(workspace).length === 2 &&
        store
          .actions(workspace)
          .every((action) => action.status === "done"), `${arm}: actions incomplete or duplicated`);
      reports.push({
        arm,
        passed: true,
        revision,
        decisions,
        actions: store.actions(workspace),
        tools: uses,
      });
      console.log(`${arm}: real agent block/context/job/sync/background passed`);
    } finally {
      clearTimeout(timer);
      await session.close();
    }
  }
  writeFileSync(join(directory, "report.json"), JSON.stringify({ passed: true, reports }, null, 2));
  console.log(`Real flexible event rule validation passed: ${directory}`);
} catch (error) {
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(
      {
        passed: false,
        error: String(error),
        reports,
        decisions: store.decisions(),
        actions: store.actions(),
      },
      null,
      2,
    ),
  );
  console.error(`${String(error)}; evidence retained at ${directory}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
