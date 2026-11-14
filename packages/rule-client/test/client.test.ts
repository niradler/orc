import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRuleClient } from "../src/factory.js";
import { RULES_REFRESH_MS } from "../src/gate.js";
import { parseHookOutput } from "../src/hook.js";
import {
  OPENCODE_BLOCKING_EVENTS,
  OPENCODE_NATIVE_PHASES,
  ruleHookGate as opencodeGate,
  planRules as opencodePlanRules,
  runRuleHook as opencodeRunHook,
} from "../src/opencode.js";
import {
  BLOCKING_EVENTS,
  type OrcRule,
  type OrcRuleRevision,
  PI_NATIVE_PHASES,
  type PiNativeEvent,
  planRules,
  ruleHookGate,
  rulesForCwd,
  runRuleHook,
} from "../src/pi.js";
import { removeRule, upsertRule } from "../src/policy.js";

const root = resolve("/work/app");

function rule(overrides: Partial<OrcRule> = {}): OrcRule {
  return {
    id: "no-ssh",
    reason: "No ssh from agents",
    kind: "event",
    enabled: true,
    scope: { agents: "all", events: ["pre_tool"] },
    filter: { match: "all", conditions: [] },
    target: { type: "block" },
    ...overrides,
  };
}

function revision(rules: OrcRule[], overrides: Partial<OrcRuleRevision> = {}): OrcRuleRevision {
  return {
    id: "rev1",
    workspace: root,
    project_id: null,
    policy: { workspace: root, project_id: null, rules },
    current: true,
    ...overrides,
  };
}

describe("rulesForCwd", () => {
  test("keeps enabled current rules for the agent inside the workspace", () => {
    const history = [
      revision([
        rule(),
        rule({ id: "off", enabled: false }),
        rule({ id: "claude-only", scope: { agents: ["claude"], events: ["pre_tool"] } }),
        rule({ id: "pi-only", scope: { agents: ["pi"], events: ["pre_tool"] } }),
      ]),
      revision([rule({ id: "old" })], { id: "rev0", current: false }),
      revision([rule({ id: "elsewhere" })], { id: "rev2", workspace: resolve("/other") }),
    ];
    const ids = rulesForCwd(history, join(root, "src")).map((item) => item.id);
    expect(ids).toEqual(["no-ssh", "pi-only"]);
  });

  test("does not match a sibling folder that shares a prefix", () => {
    expect(rulesForCwd([revision([rule()])], `${root}-two`)).toEqual([]);
  });
});

describe("planRules", () => {
  test("maps ORC phases and native names to Pi events", () => {
    const plan = planRules(
      [
        revision([
          rule(),
          rule({
            id: "ctx",
            scope: { agents: "all", events: ["prompt_submit", "native:tool_result"] },
          }),
          rule({ id: "codex", scope: { agents: "all", events: ["native:PreToolUse"] } }),
        ]),
      ],
      root,
    );
    expect([...plan.events].sort()).toEqual(["input", "tool_call", "tool_result"]);
    expect(plan.count).toBe(3);
    expect(plan.timeoutMs.get("tool_call")).toBe(30_000);
  });

  test("waits for a human on ask_user targets", () => {
    const plan = planRules(
      [
        revision([
          rule({ target: { type: "ask_user", kind: "approval", expires_in_seconds: 60 } }),
        ]),
      ],
      root,
    );
    expect(plan.timeoutMs.get("tool_call")).toBe(90_000);
  });

  test("maps OpenCode plugin hooks and keeps native scopes addressable", () => {
    const plan = opencodePlanRules(
      [
        revision([
          rule(),
          rule({ id: "ctx", scope: { agents: "all", events: ["native:execute.after"] } }),
          rule({ id: "prompt", scope: { agents: ["opencode"], events: ["prompt_submit"] } }),
          rule({ id: "pi-only", scope: { agents: ["pi"], events: ["pre_tool"] } }),
        ]),
      ],
      root,
    );
    expect([...plan.events].sort()).toEqual(["execute.after", "execute.before", "prompt"]);
    expect(plan.count).toBe(3);
  });
});

describe("ruleHookGate", () => {
  const plan = planRules([revision([rule()])], root);

  test("a loaded plan selects exactly its events", () => {
    expect(ruleHookGate({ enabled: true, plan, disabled: false, native: "tool_call" })).toEqual({
      run: true,
      timeoutMs: 30_000,
    });
    expect(ruleHookGate({ enabled: true, plan, disabled: false, native: "tool_result" }).run).toBe(
      false,
    );
  });

  test("without a plan, blocking events still run the hook (fail closed)", () => {
    for (const native of BLOCKING_EVENTS)
      expect(ruleHookGate({ enabled: true, plan: undefined, disabled: false, native }).run).toBe(
        true,
      );
    expect(
      ruleHookGate({ enabled: true, plan: undefined, disabled: false, native: "tool_result" }).run,
    ).toBe(false);
  });

  test("a confirmed global disable or disabled config skips every event", () => {
    expect(
      ruleHookGate({ enabled: true, plan: undefined, disabled: true, native: "tool_call" }).run,
    ).toBe(false);
    expect(ruleHookGate({ enabled: false, plan, disabled: false, native: "tool_call" }).run).toBe(
      false,
    );
  });

  test("OpenCode blocking hooks fail closed without a plan", () => {
    for (const native of OPENCODE_BLOCKING_EVENTS)
      expect(opencodeGate({ enabled: true, plan: undefined, disabled: false, native }).run).toBe(
        true,
      );
    expect(
      opencodeGate({ enabled: true, plan: undefined, disabled: false, native: "execute.after" })
        .run,
    ).toBe(false);
  });

  test("refresh interval is bounded", () => {
    expect(RULES_REFRESH_MS).toBeGreaterThan(0);
    expect(RULES_REFRESH_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("parseHookOutput", () => {
  test("reads a pre-tool deny", () => {
    const out = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no ssh" },
    });
    expect(parseHookOutput(out, 0)).toEqual({ block: true, reason: "no ssh" });
  });

  test("reads a block decision", () => {
    expect(parseHookOutput(JSON.stringify({ decision: "block", reason: "stop" }), 2)).toEqual({
      block: true,
      reason: "stop",
    });
  });

  test("reads context and rewritten input", () => {
    const out = JSON.stringify({
      hookSpecificOutput: { additionalContext: "be careful", updatedInput: { command: "ls" } },
    });
    expect(parseHookOutput(out, 0)).toEqual({
      block: false,
      context: "be careful",
      updatedInput: { command: "ls" },
    });
  });

  test("treats empty success as allow and failures as block", () => {
    expect(parseHookOutput("", 0)).toEqual({ block: false });
    expect(parseHookOutput("", 1).block).toBe(true);
    expect(parseHookOutput("boom", 1)).toEqual({
      block: true,
      reason: "ORC rule hook failed: boom",
    });
  });
});

describe("policy edits", () => {
  test("upsertRule replaces a rule with the same id and keeps the rest", () => {
    const current = revision([rule(), rule({ id: "other" })]).policy;
    const next = upsertRule(current, rule({ reason: "updated" }), "/ignored", "p1");
    expect(next.workspace).toBe(root);
    expect(next.rules.map((item) => [item.id, item.reason])).toEqual([
      ["other", "No ssh from agents"],
      ["no-ssh", "updated"],
    ]);
  });

  test("upsertRule starts a policy for a new workspace", () => {
    expect(upsertRule(null, rule(), root, "p1")).toEqual({
      workspace: root,
      project_id: "p1",
      rules: [rule()],
    });
  });

  test("removeRule reports a missing id", () => {
    const current = revision([rule(), rule({ id: "other" })]).policy;
    if (!current) throw new Error("policy expected");
    expect(removeRule(current, "missing")).toBeUndefined();
    expect(removeRule(current, "no-ssh")?.rules.map((item) => item.id)).toEqual(["other"]);
  });
});

describe("runRuleHook", () => {
  const base = { native: "tool_call" as const, payload: {}, cwd: process.cwd(), env: {} };

  test("fails closed when the ORC command cannot run", async () => {
    const decision = await runRuleHook({
      ...base,
      command: "porc-missing-command-xyz",
      timeoutMs: 10_000,
    });
    expect(decision.block).toBe(true);
  });

  test("fails open for non-blocking events", async () => {
    const decision = await runRuleHook({
      ...base,
      native: "tool_result",
      command: "porc-missing-command-xyz",
      timeoutMs: 10_000,
    });
    expect(decision).toEqual({ block: false });
  });
});

describe("adapter factory spawn protocol", () => {
  const base = { native: "tool_call" as const, payload: {}, cwd: process.cwd(), env: {} };
  const directory = mkdtempSync(join(tmpdir(), "orc-rule-client-"));
  const log = join(directory, "calls.jsonl");
  const stubSource = `import { appendFileSync } from "node:fs";
const payload = JSON.parse(await Bun.stdin.text());
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, payload }) + "\\n");
const command = String(payload.tool_input?.command ?? payload.prompt ?? "");
if (command.includes("blocked")) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: args[3], permissionDecision: "deny", permissionDecisionReason: "guard: denied" } }));
} else if (command.includes("exit2")) {
  process.exit(2);
} else {
  console.log("{}");
}
`;
  let command: string;
  if (process.platform === "win32") {
    const source = join(directory, "stub-orc.ts");
    writeFileSync(source, stubSource);
    command = join(directory, "stub-orc.cmd");
    writeFileSync(command, `@bun "${source}" %*\r\n`);
  } else {
    command = join(directory, "stub-orc");
    writeFileSync(command, `#!/usr/bin/env bun\n${stubSource}`, { mode: 0o755 });
  }
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  test("Pi and OpenCode clients call their own backend adapter", async () => {
    const pi = await runRuleHook({
      ...base,
      command,
      payload: { session_id: "s", tool_call_id: "t1", tool_input: { command: "blocked" } },
      timeoutMs: 15_000,
    });
    expect(pi).toEqual({ block: true, reason: "guard: denied" });
    const opencode = await opencodeRunHook({
      native: "execute.before",
      command,
      payload: { session_id: "s", tool_call_id: "t2", tool_input: { command: "blocked" } },
      cwd: process.cwd(),
      env: {},
      timeoutMs: 15_000,
    });
    expect(opencode).toEqual({ block: true, reason: "guard: denied" });
    const calls = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0].args).toEqual(["rules", "hook", "pi", "tool_call"]);
    expect(calls[1].args).toEqual(["rules", "hook", "opencode", "execute.before"]);
    expect(calls[1].payload.tool_call_id).toBe("t2");
  });

  test("nonzero exit fails closed on blocking events only", async () => {
    const blocked = await opencodeRunHook({
      native: "prompt",
      command,
      payload: { prompt: "exit2" },
      cwd: process.cwd(),
      env: {},
      timeoutMs: 15_000,
    });
    expect(blocked.block).toBe(true);
    const observed = await opencodeRunHook({
      native: "execute.after",
      command,
      payload: { prompt: "exit2" },
      cwd: process.cwd(),
      env: {},
      timeoutMs: 15_000,
    });
    expect(observed).toEqual({ block: false });
  });

  test("a custom factory adapter keeps its own blocking set", async () => {
    const client = createRuleClient<PiNativeEvent>({
      backend: "pi",
      phases: PI_NATIVE_PHASES,
      blocking: ["tool_call"],
    });
    expect(client.blocking.has("input")).toBe(false);
    expect(client.phases).toEqual(PI_NATIVE_PHASES);
    expect(OPENCODE_NATIVE_PHASES["execute.before"]).toBe("pre_tool");
  });
});
