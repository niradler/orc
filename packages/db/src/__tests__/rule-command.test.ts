import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { RuleEventSchema } from "@orc/core/rules";
import { RuleStore } from "../rules.js";

test("should dry-run routing without execution, recheck all policies and scripts, and retain only input hashes", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,command TEXT,enabled INTEGER)",
  );
  const store = new RuleStore(db);
  const filter = (value: string) => ({
    match: "all",
    conditions: [{ predicate: { field: "input.command", operator: "contains", value } }],
  });
  const base = {
    kind: "event",
    enabled: true,
    reason: "Routing validation",
    scope: { agents: ["claude"], events: ["pre_tool"] },
  };
  store.activate(
    {
      workspace: process.cwd(),
      project_id: null,
      rules: [
        {
          ...base,
          id: "route",
          filter: filter("original"),
          target: {
            type: "rewrite_command",
            argv: [
              process.execPath,
              "-e",
              "const e=JSON.parse(await Bun.stdin.text());console.log(e.input.command.replace('original','replacement'))",
            ],
            timeout_ms: 1000,
          },
        },
        {
          ...base,
          id: "replacement-guard",
          filter: filter("replacement-private-command"),
          target: {
            type: "script",
            mode: "sync",
            argv: [
              process.execPath,
              "-e",
              "console.log(JSON.stringify({decision:'deny',reason:'replacement denied'}))",
            ],
            timeout_ms: 1000,
          },
        },
      ],
    },
    null,
    "Enable",
  );
  const event = RuleEventSchema.parse({
    id: "input",
    session_id: "session",
    backend: "claude",
    cwd: process.cwd(),
    phase: "pre_tool",
    tool: "Bash",
    input: { command: "original-private-command" },
  });
  const preview = store.evaluate(event, false);
  expect(preview.command_processors).toHaveLength(1);
  expect(preview.updated_input).toBeUndefined();
  expect(store.decisions()).toHaveLength(0);
  const outcome = store.evaluateCommand(event);
  expect(outcome.decision).toBe("deny");
  expect(outcome.reasons.some((reason) => reason.rule_id === "replacement-guard")).toBe(true);
  const history = JSON.stringify(store.decisions());
  expect(history).not.toContain("original-private-command");
  expect(history).not.toContain("replacement-private-command");
  expect(
    store
      .decisions()
      .some(
        (row) =>
          row.phase === "command_route" &&
          JSON.parse(row.result).command_processing.status === "denied",
      ),
  ).toBe(true);
  db.close();
});
