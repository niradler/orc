import { expect, test } from "bun:test";
import { ChatSettingsSchema } from "../chat";
import {
  type ChatAgentOptions,
  ChatAgentOptionsMapSchema,
  ChatAgentOptionsSchema,
  chatRuntime,
  terminalLaunchArgs,
  withChatEffort,
} from "../chat-options";

test("should accept ACPX permission and timeout arguments without shell parsing", () => {
  const value: ChatAgentOptions = {
    runtime: "acpx",
    args: [
      "--approve-all",
      "--timeout=120",
      "--ttl",
      "0",
      "--policy",
      '{"autoApprove":["echo $(literal) & quoted"]}',
    ],
  };
  expect(ChatAgentOptionsSchema.parse(value)).toEqual(value);
  expect(ChatSettingsSchema.parse({}).agentOptions).toEqual({});
});
test("should validate SDK options and preserve explicit permission choices", () => {
  const value: ChatAgentOptions = {
    runtime: "claude-sdk",
    options: {
      permissionMode: "bypassPermissions",
      maxTurns: 12,
      maxBudgetUsd: 5,
      effort: "high",
      thinking: { type: "adaptive" },
      extraArgs: { verbose: null },
    },
  };
  expect(ChatAgentOptionsSchema.parse(value)).toEqual(value);
  for (const options of [
    { hooks: {} },
    { env: { TOKEN: "secret" } },
    { cwd: "/other" },
    { resume: "other" },
    { extraArgs: { "permission-mode": "bypassPermissions" } },
    { maxTurns: 0 },
    { fallbackModel: "--help" },
  ])
    expect(ChatAgentOptionsSchema.safeParse({ runtime: "claude-sdk", options }).success).toBe(
      false,
    );
});
test("should reject CLI transport and identity overrides and contradictory permissions", () => {
  for (const args of [
    ["--format", "text"],
    ["--agent", "other"],
    ["--cwd", "/elsewhere"],
    ["-s", "other"],
    ["--file", "secret"],
    ["--approve-all", "--deny-all"],
    ["--timeout", "-1"],
    ["--ttl", "bad"],
    ["--verbose=true"],
    ["--ttl", "1\n--help"],
  ])
    expect(ChatAgentOptionsSchema.safeParse({ runtime: "acpx", args }).success).toBe(false);
});
test("should validate Codex config arguments while retaining managed settings", () => {
  expect(
    ChatAgentOptionsSchema.parse({
      runtime: "codex",
      args: ["-c", 'model_reasoning_effort="high"', "--disable", "apps"],
    }),
  ).toHaveProperty("args");
  for (const args of [
    ["--listen", "ws://elsewhere"],
    ["-c", 'approval_policy="never"'],
    ["-c", 'mcp_servers.orc.url="http://elsewhere"'],
    ["--disable", "default_mode_request_user_input"],
  ])
    expect(ChatAgentOptionsSchema.safeParse({ runtime: "codex", args }).success).toBe(false);
  expect(
    ChatAgentOptionsMapSchema.safeParse({ codex: { runtime: "acpx", args: [] } }).success,
  ).toBe(false);
});

test("OpenCode effort options parse and legacy ACPX arguments stay readable", () => {
  expect(chatRuntime("opencode")).toBe("opencode");
  expect(
    ChatAgentOptionsSchema.safeParse({ runtime: "opencode", options: { effort: "high" } }).success,
  ).toBe(true);
  expect(
    ChatAgentOptionsSchema.safeParse({ runtime: "opencode", options: { effort: "not a value!" } })
      .success,
  ).toBe(false);
  expect(
    ChatAgentOptionsMapSchema.safeParse({ opencode: { runtime: "opencode", options: {} } }).success,
  ).toBe(true);
  // Saved ACPX arguments from before direct ACP must not break settings load.
  expect(
    ChatAgentOptionsMapSchema.safeParse({ opencode: { runtime: "acpx", args: [] } }).success,
  ).toBe(true);
  expect(
    ChatAgentOptionsMapSchema.safeParse({ opencode: { runtime: "codex", args: [] } }).success,
  ).toBe(false);
});

test("terminal launch flags cover Cursor and reject what a CLI lacks", () => {
  expect(terminalLaunchArgs("cursor", { model: "gpt-5", permissionMode: "plan" })).toEqual([
    "--model",
    "gpt-5",
    "--mode",
    "plan",
  ]);
  expect(terminalLaunchArgs("cursor", { permissionMode: "bypassPermissions" })).toEqual([
    "--force",
  ]);
  expect(terminalLaunchArgs("pi", {})).toEqual([]);
  expect(() => terminalLaunchArgs("pi", { model: "x" })).toThrow("no model, effort or mode");
  expect(() => terminalLaunchArgs("cursor", { effort: "high" })).toThrow("no effort flag");
  expect(() => terminalLaunchArgs("cursor", { permissionMode: "acceptEdits" })).toThrow(
    "acceptEdits",
  );
});

test("effort lands in each runtime's launch options and clears cleanly", () => {
  expect(withChatEffort("claude", undefined, "high")).toEqual({
    runtime: "claude-sdk",
    options: { effort: "high" },
  });
  expect(withChatEffort("claude", undefined, "")).toEqual({
    runtime: "claude-sdk",
    options: {},
  });
  expect(
    withChatEffort(
      "codex",
      {
        runtime: "codex",
        args: ["-c", 'model_reasoning_effort="low"', "-c", "unrelated=1", "--enable", "foo"],
      },
      "high",
    ),
  ).toEqual({
    runtime: "codex",
    args: ["-c", "unrelated=1", "--enable", "foo", "-c", 'model_reasoning_effort="high"'],
  });
  expect(
    withChatEffort("pi", { runtime: "pi", options: { steeringMode: "all" } }, "max"),
  ).toMatchObject({ runtime: "pi", options: { steeringMode: "all", thinkingLevel: "max" } });
  expect(withChatEffort("opencode", undefined, "high")).toEqual({
    runtime: "opencode",
    options: { effort: "high" },
  });
  expect(withChatEffort("a2a", undefined, "high")).toBeUndefined();
});
