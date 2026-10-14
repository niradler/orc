import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { type AgentEvent, createBackend } from "../packages/agent-runtime/src/index.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { RuleStore } from "../packages/db/src/rules.js";

const rtk = process.argv[2];
if (!rtk) throw new Error("Usage: bun scripts/validate-command-processors.ts <rtk-executable>");
const executable = resolve(rtk);
const directory = resolve(".claude/tooling/command-processors", `runtime-${Date.now()}`);
const workspace = join(directory, "workspace");
mkdirSync(workspace, { recursive: true });
process.env.PATH = `${dirname(executable)}${delimiter}${process.env.PATH ?? ""}`;
loadConfig({
  db: { path: join(directory, "orc.db") },
  rules: { enabled: true },
  activeProject: "",
});
const store = new RuleStore(getSqlite());
const token = `ROUTED_${randomUUID().replaceAll("-", "")}`;
const script = join(workspace, "processor.ts");
const capture = join(workspace, "capture.ts");
writeFileSync(
  capture,
  "import {appendFileSync} from 'node:fs';const event=JSON.parse(await Bun.stdin.text());appendFileSync('tool-outputs.jsonl',JSON.stringify(event)+'\\n');console.log('{}');\n",
);
writeFileSync(
  script,
  `const event=JSON.parse(await Bun.stdin.text());const command=event.input.command;await Bun.write('processor-called.txt',command);console.log(command.includes('replacement-source') ? 'printf replacement-forbidden' : 'printf ${token}; exit 7');\n`,
);
writeFileSync(join(workspace, "example.ts"), "export const value = 42;\n");
const initialized = spawnSync("git", ["init", "--quiet"], {
  cwd: workspace,
  timeout: 10000,
  windowsHide: true,
});
if (initialized.status !== 0) throw new Error("Git initialization failed");
const base = {
  kind: "event",
  enabled: true,
  reason: "Real command routing validation",
  scope: { agents: ["claude"], events: ["pre_tool"] },
};
const filter = (command: string) => ({
  match: "all",
  conditions: [{ predicate: { field: "input.command", operator: "equals", value: command } }],
});
store.activate(
  {
    workspace,
    project_id: null,
    rules: [
      {
        kind: "event",
        enabled: true,
        reason: "Capture actual host responses",
        scope: { agents: ["claude"], events: ["post_tool", "post_tool_failure"] },
        id: "capture-host-output",
        filter: { match: "all", conditions: [] },
        target: {
          type: "script",
          mode: "sync",
          argv: [process.execPath, capture],
          timeout_ms: 1000,
        },
      },
      {
        ...base,
        id: "rtk-route",
        filter: filter("git status"),
        target: {
          type: "rewrite_command",
          argv: [executable, "rewrite", "{command}"],
          timeout_ms: 1000,
          rewrite_exit_codes: [0, 3],
          passthrough_exit_codes: [1],
        },
      },
      {
        ...base,
        id: "custom-route",
        filter: filter("printf original-source"),
        target: { type: "rewrite_command", argv: [process.execPath, script], timeout_ms: 1000 },
      },
      {
        ...base,
        id: "replacement-route",
        filter: filter("printf replacement-source"),
        target: { type: "rewrite_command", argv: [process.execPath, script], timeout_ms: 1000 },
      },
      {
        ...base,
        id: "replacement-block",
        filter: filter("printf replacement-forbidden"),
        target: { type: "block" },
      },
      {
        ...base,
        id: "original-block",
        filter: filter("printf original-denied"),
        target: { type: "block" },
      },
      {
        ...base,
        id: "never-run-route",
        filter: filter("printf original-denied"),
        target: { type: "rewrite_command", argv: [process.execPath, script], timeout_ms: 1000 },
      },
    ],
  },
  null,
  "Isolated real-agent proof",
);
const backend = createBackend("claude");
const events: AgentEvent[] = [];
const session = await backend.startSession({
  cwd: workspace,
  model: "haiku",
  autoApprove: true,
  systemPromptAppend:
    "This is an authorized isolated command-routing probe. No ORC task or MCP workflow is required. Use only Bash, make each exact requested command once, and never work around a denial. Report actual tool output and failures.",
});
const timer = setTimeout(() => {
  void session.close();
}, 150000);
try {
  await session.send(
    "Make four separate Bash calls in order, each exactly once: (1) git status (2) printf original-source (3) printf replacement-source (4) printf original-denied. The hooks deliberately route or deny these harmless calls. Respect denials and do not retry. Report the actual results including any output from call 2 and its exit status.",
  );
  for await (const event of session.events()) {
    events.push(event);
    writeFileSync(join(directory, "events.json"), JSON.stringify(events, null, 2));
  }
  const text = JSON.stringify(events);
  const decisions = store.decisions();
  const routes = decisions
    .filter((decision) => decision.phase === "command_route")
    .map((decision) => JSON.parse(decision.result));
  const hostOutputs = readFileSync(join(workspace, "tool-outputs.jsonl"), "utf8");
  const report = {
    passed:
      events.some((event) => event.type === "result") &&
      text.includes(token) &&
      hostOutputs.includes(token) &&
      /(?:Exit code 7|exitCode":7|exit_code":7)/.test(hostOutputs) &&
      routes.some(
        (route) =>
          route.command_processing.rule_ids.includes("rtk-route") &&
          route.command_processing.status === "rewritten",
      ) &&
      routes.filter((route) => route.decision === "deny").length === 2 &&
      readFileSync(join(workspace, "processor-called.txt"), "utf8") === "printf replacement-source",
    token,
    decisions,
    events,
    hostOutputs: hostOutputs
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error(`Real-agent routing validation failed: ${directory}`);
  console.log(
    JSON.stringify({
      passed: true,
      tokenObserved: true,
      rtkRouted: true,
      deniedOriginalAndReplacement: true,
      directory,
    }),
  );
} finally {
  clearTimeout(timer);
  await session.close();
  closeDb();
}
