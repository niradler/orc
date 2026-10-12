import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleStore } from "../rules.js";

const root = mkdtempSync(join(tmpdir(), "orc-script-decisions-"));
const db = new Database(":memory:");
db.exec(
  "CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,command TEXT,enabled INTEGER)",
);
const store = new RuleStore(db);
const event = {
  id: "attempt-1",
  session_id: "session",
  cwd: root,
  backend: "claude",
  phase: "pre_tool",
  tool: "Bash",
  input: { command: "block-me", private: "input-secret" },
};
const makePolicy = (argv: string[], timeout_ms = 1000) => ({
  workspace: root,
  project_id: null,
  rules: [
    {
      id: "script",
      reason: "Script decision",
      kind: "event",
      enabled: true,
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [
          { predicate: { field: "input.command", operator: "equals", value: "block-me" } },
        ],
      },
      target: { type: "script", mode: "sync", argv, timeout_ms },
    },
  ],
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("should execute synchronous scripts once, pass stdin, retain the result, and keep dry runs side-effect free", () => {
  const code =
    "const e=JSON.parse(await Bun.stdin.text()); await Bun.write('marker.txt',e.input.command); console.log(JSON.stringify({decision:'deny',reason:'Matched command',context:['Use an ordinary edit']}));";
  const first = store.activate(makePolicy([process.execPath, "-e", code]), null, "Enable script");
  expect(store.evaluate(event, false).scripts?.length).toBe(1);
  expect(existsSync(join(root, "marker.txt"))).toBe(false);
  expect(
    store.evaluate({ ...event, id: "ordinary", input: { command: "bun test" } }).decision,
  ).toBe("abstain");
  expect(existsSync(join(root, "marker.txt"))).toBe(false);
  const result = store.evaluate(event);
  expect(result.decision).toBe("deny");
  expect(result.context).toEqual(["Use an ordinary edit"]);
  expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("block-me");
  expect(store.evaluate(event)).toEqual(result);
  expect(store.decisions().length).toBe(2);
  expect(JSON.stringify(store.decisions())).not.toContain("input-secret");
  expect(() => store.evaluate({ ...event, input: { command: "changed" } })).toThrow(
    "identity reused",
  );
  expect(store.revert(first.id, "Disable").policy).toBeNull();
});

test("should fail closed on timeout, malformed result, and unsupported injection without retrying", () => {
  let head = store.history().find((row) => row.current)?.id ?? null;
  for (const [code, timeout] of [
    ["await Bun.sleep(10000)", 100],
    ["console.log('invalid-json')", 1000],
    ["console.log(JSON.stringify({allow:true}))", 1000],
  ] as const) {
    const revision = store.activate(
      makePolicy([process.execPath, "-e", code], timeout),
      head,
      "Failure probe",
    );
    head = revision.id;
    const start = performance.now();
    const result = store.evaluate({ ...event, id: `failure-${timeout}` });
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]?.reason).toContain("failed");
    expect(performance.now() - start).toBeLessThan(2000);
  }
});
