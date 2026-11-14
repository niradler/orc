import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { HumanRequestSchema } from "@orc/core/human-requests";
import { RuleAskUserSchema } from "@orc/core/rule-types";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { SessionMessageStore } from "@orc/db/session-messages";
import { sessionRules } from "../rules.js";
import {
  createRulesHook,
  createSessionMessagesHook,
  sessionStartRuleContext,
} from "../rules-hook.js";

const root = mkdtempSync(join(tmpdir(), "orc-guard-tests-"));
const originalEnabled = process.env.ORC_RULES_ENABLED;
const originalDb = process.env.ORC_DB_PATH;

test("should retain parallel human waits when another hook or human response completes", async () => {
  const oldBase = process.env.ORC_API_BASE;
  const answered = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const id =
        request.method === "POST"
          ? ((await request.json()) as { event: { id: string } }).event.id
          : (new URL(request.url).pathname.split("/").at(-1) ?? "");
      const ready = answered.has(id);
      return Response.json(
        HumanRequestSchema.parse({
          id,
          input: {
            origin: { session_id: "session", backend: "claude", request_id: id },
            kind: "approval",
            prompt: "Review",
            action: { tool: "Bash", input: { command: "pwd" }, cwd: root, host: "local" },
          },
          status: ready ? "answered" : "pending",
          version: ready ? 2 : 1,
          response: ready ? { kind: "approval", approved: true } : null,
          created_at: Date.now(),
          expires_at: Date.now() + 30000,
          responded_at: ready ? Date.now() : null,
          delivered_at: null,
        }),
      );
    },
  });
  process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
  let waits = 0;
  const hook = createRulesHook(
    {
      context: "",
      builtinActions: false,
      evaluate(event) {
        return {
          decision: "abstain",
          context: [],
          jobs: [],
          reasons: [],
          ...(event.phase === "pre_tool"
            ? {
                human_requests: [
                  {
                    rule_id: "ask",
                    revision_id: "revision",
                    target: RuleAskUserSchema.parse({
                      type: "ask_user",
                      kind: "approval",
                      prompt: "Review",
                    }),
                  },
                ],
              }
            : {}),
        };
      },
    },
    root,
    () => {},
    (waiting) => {
      waits += waiting ? 1 : -1;
    },
  );
  const event = {
    hook_event_name: "PreToolUse" as const,
    session_id: "session",
    transcript_path: "",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "pwd" },
    tool_use_id: "one",
  };
  const signal = new AbortController().signal;
  try {
    const first = hook(event, "one", { signal });
    const second = hook({ ...event, tool_use_id: "two" }, "two", { signal });
    expect(waits).toBe(2);
    await hook({ ...event, hook_event_name: "PostToolUse", tool_response: "ok" }, "unrelated", {
      signal,
    });
    expect(waits).toBe(2);
    answered.add("one");
    await first;
    expect(waits).toBe(1);
    answered.add("two");
    await second;
    expect(waits).toBe(0);
  } finally {
    server.stop(true);
    if (oldBase === undefined) delete process.env.ORC_API_BASE;
    else process.env.ORC_API_BASE = oldBase;
  }
});
test("managed startup and resume deliver context before query and fail closed on unavailable rules", async () => {
  for (const source of ["startup", "resume"] as const) {
    expect(
      await sessionStartRuleContext(
        {
          context: "",
          evaluate(event) {
            expect(event.phase).toBe("session_start");
            expect(event.payload?.source).toBe(source);
            return {
              decision: "abstain",
              reasons: [],
              context: ["injected"],
              jobs: [],
            };
          },
        },
        root,
        "session",
        source,
        source,
      ),
    ).toBe("injected");
  }
  await expect(
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
  ).rejects.toThrow("unavailable");
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

test("sessions created before policy activation pick it up; unsupported adapters report a gap", async () => {
  const opts = await sessionRules("claude", { cwd: root, autoApprove: true });
  expect(opts.ruleGuard).toBeDefined();
  const store = new RuleStore(getSqlite());
  const revision = store.activate(
    {
      workspace: root,
      project_id: null,
      rules: [
        {
          id: "shell",
          kind: "event",
          enabled: true,
          reason: "No shell",
          scope: { agents: "all", events: ["pre_tool"] },
          filter: {
            match: "all",
            conditions: [{ predicate: { field: "tool", operator: "in", value: ["Bash"] } }],
          },
          target: { type: "block" },
        },
      ],
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
  const codex = await sessionRules("codex-cli", { cwd: root });
  expect(codex.ruleGuard).toBeUndefined();
  expect(codex.ruleGap).toMatchObject({
    backend: "codex-cli",
    agent: "codex",
    policies: [revision.id],
    reason: "no_blocking_pre_tool_hook",
  });
  expect(codex.ruleGap?.message).toContain("cannot be enforced");
  store.revert(revision.id, "Human revert");
  expect(opts.ruleGuard?.evaluate({ ...event, id: "after-revert" }).decision).toBe("abstain");
  expect((await sessionRules("codex-cli", { cwd: root })).ruleGap).toBeUndefined();
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
  expect(result).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
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
        return {
          decision: "abstain",
          reasons: [],
          jobs: [],
          context: ["Project context"],
        };
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
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Project context",
    },
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
  ).toMatchObject({
    hookSpecificOutput: { additionalContext: "Project context" },
  });
  expect(phases).toEqual(["pre_tool:false", "post_tool_failure:true", "session_start:false"]);
});

test("delivers a queued session message at the pre-tool safe point", async () => {
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id) VALUES ('session-message-test', 'test', 'session-message-test')",
  );
  sqlite
    .query(
      "INSERT OR REPLACE INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, status) VALUES ('managed', 'session-message-test', 'claude', 'direct', 's', 'idle')",
    )
    .run();
  const store = new SessionMessageStore(sqlite);
  const message = store.create(
    { session_id: "s", body: "Change the retry count to five." },
    { kind: "human", label: "human relay (web)" },
  );
  const hook = createRulesHook(
    {
      context: "",
      evaluate: () => ({ decision: "abstain", reasons: [], jobs: [], context: [] }),
    },
    root,
    () => {},
  );
  const output = await hook(
    {
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: root,
      transcript_path: "",
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "message-one",
    },
    "message-one",
    { signal: new AbortController().signal },
  );
  expect(JSON.stringify(output)).toContain("Change the retry count to five.");
  expect(JSON.stringify(output)).toContain("Delivery is not approval");
  expect(store.get(message.id)).toMatchObject({
    state: "delivered",
    delivered_via: "hook",
  });
});

test("delivers session messages without enabling the rules engine", async () => {
  const sqlite = getSqlite();
  sqlite
    .query(
      "INSERT OR REPLACE INTO gateway_sessions (id, chat_id, backend, mode, runtime_session_id, status) VALUES ('managed-sdk', 'session-message-test', 'claude', 'direct', 'sdk-native', 'idle')",
    )
    .run();
  const store = new SessionMessageStore(sqlite);
  const message = store.create(
    { session_id: "sdk-native", body: "Use the compact layout." },
    { kind: "human", label: "human relay (web)" },
  );
  const output = await createSessionMessagesHook("sdk-native")(
    {
      hook_event_name: "PreToolUse",
      session_id: "sdk-native",
      cwd: root,
      transcript_path: "",
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "message-two",
    },
    "message-two",
    { signal: new AbortController().signal },
  );
  expect(output).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse" },
  });
  expect(JSON.stringify(output)).toContain("Use the compact layout.");
  expect(store.get(message.id)).toMatchObject({ state: "delivered", delivered_via: "hook" });
});
