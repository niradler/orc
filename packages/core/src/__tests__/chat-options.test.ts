import { expect, test } from "bun:test";
import { ChatSettingsSchema } from "../chat";
import {
  type ChatAgentOptions,
  ChatAgentOptionsMapSchema,
  ChatAgentOptionsSchema,
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
