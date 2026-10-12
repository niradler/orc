import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { sessionRules } from "../rules.js";
import { createRulesHook, sessionStartRuleContext } from "../rules-hook.js";

const root = mkdtempSync(join(tmpdir(), "orc-guard-tests-"));
const originalEnabled = process.env.ORC_RULES_ENABLED;
const originalDb = process.env.ORC_DB_PATH;
test("managed startup and resume deliver context before query and fail closed on unavailable rules", () => {
  for (const source of ["startup", "resume"] as const) {
    expect(
      sessionStartRuleContext(
        {
          context: "",
          evaluate(event) {
            expect(event.phase).toBe("session_start");
            expect(event.payload?.source).toBe(source);
            return { decision: "abstain", reasons: [], context: ["injected"], jobs: [] };
          },
        },
        root,
        "session",
        source,
        source,
      ),
    ).toBe("injected");
  }
  expect(() =>
    sessionStartRuleContext(
      {
        context: "",
        evaluate() {
          throw new Error("unavailable");
        },
      },
      root,
      "session",
      "failed",
      "startup",
    ),
  ).toThrow("unavailable");
});
beforeAll(() => {
  process.env.ORC_RULES_ENABLED = "true";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
});
afterAll(() => {
  closeDb();
  if (originalEnabled === undefined) delete process.env.ORC_RULES_ENABLED;
  else process.env.ORC_RULES_ENABLED = originalEnabled;
  if (originalDb === undefined) delete process.env.ORC_DB_PATH;
  else process.env.ORC_DB_PATH = originalDb;
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

test("sessions created before policy activation pick it up; unsupported adapter refuses", async () => {
  const opts = await sessionRules("claude", { cwd: root, autoApprove: true });
  expect(opts.ruleGuard).toBeDefined();
  const store = new RuleStore(getSqlite());
  const revision = store.activate(
    {
      workspace: root,
      project_id: null,
      rules: [{ id: "shell", kind: "deny_tools", tools: ["Bash"], reason: "No shell" }],
    },
    null,
    "Activate during session",
  );
  const event = {
    id: "tool",
    session_id: "s",
    backend: "claude",
    cwd: tmpdir(),
    phase: "pre_tool" as const,
    tool: "Bash",
    input: {},
    failed: false,
  };
  expect(opts.ruleGuard?.evaluate(event).decision).toBe("deny");
  await expect(sessionRules("codex-cli", { cwd: root })).rejects.toThrow("no verified");
  store.revert(revision.id, "Human revert");
  expect(opts.ruleGuard?.evaluate({ ...event, id: "after-revert" }).decision).toBe("abstain");
  expect((await sessionRules("codex-cli", { cwd: root })).ruleGuard).toBeUndefined();
});

test("SDK pre-tool callback fails closed on evaluator errors and malformed input", async () => {
  const hook = createRulesHook(
    {
      context: "",
      evaluate: () => {
        throw new Error("Storage unavailable");
      },
    },
    root,
    () => {},
  );
  const input = {
    hook_event_name: "PreToolUse" as const,
    session_id: "s",
    cwd: root,
    transcript_path: "",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_use_id: "one",
  };
  const options = { signal: new AbortController().signal };
  const result = await hook(input, "one", options);
  expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(JSON.stringify(result)).toContain("Storage unavailable");
  expect(await hook({ ...input, tool_input: [] }, "two", options)).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  const start = await hook(
    {
      hook_event_name: "SessionStart",
      session_id: "s",
      cwd: root,
      transcript_path: "",
      source: "startup",
    },
    undefined,
    options,
  );
  expect(start).toMatchObject({ continue: false });
});

test("SDK maps failed tools and session context without granting native permission", async () => {
  const phases: string[] = [];
  const hook = createRulesHook(
    {
      context: "",
      evaluate: (event) => {
        phases.push(`${event.phase}:${event.failed}`);
        return { decision: "abstain", reasons: [], jobs: [], context: ["Project context"] };
      },
    },
    root,
    () => {},
  );
  const options = { signal: new AbortController().signal };
  const base = { session_id: "s", cwd: root, transcript_path: "" };
  expect(
    await hook(
      {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "one",
      },
      "one",
      options,
    ),
  ).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "Project context" },
  });
  await hook(
    {
      ...base,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "one",
      error: "Failed",
    },
    "one",
    options,
  );
  expect(
    await hook({ ...base, hook_event_name: "SessionStart", source: "resume" }, undefined, options),
  ).toMatchObject({ hookSpecificOutput: { additionalContext: "Project context" } });
  expect(phases).toEqual(["pre_tool:false", "post_tool_failure:true", "session_start:false"]);
});
