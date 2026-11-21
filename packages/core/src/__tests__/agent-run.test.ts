import { expect, test } from "bun:test";
import { agentRunSessionOptions, withAgentRunEffort } from "../agent-run.js";
import { ChannelRouteSchema } from "../channels.js";

const bypass = {
  runtime: "claude-sdk" as const,
  options: { permissionMode: "bypassPermissions" as const },
};

test("untrusted senders never get ORC MCP, broader permissions or approving launch options", () => {
  expect(agentRunSessionOptions({ permissions: "ask" }, false)).toMatchObject({
    permissions: "ask",
    orcMcp: false,
  });
  expect(agentRunSessionOptions({ permissions: "auto", options: bypass }, false)).toEqual({
    permissions: "read_only",
    autoApprove: false,
    permissionMode: "default",
    orcMcp: false,
    toolAllowlist: ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"],
  });
  expect(agentRunSessionOptions({ permissions: "ask", options: bypass }, true)).not.toHaveProperty(
    "chatAgentOptions",
  );
  expect(agentRunSessionOptions({ permissions: "auto", options: bypass }, true)).toMatchObject({
    orcMcp: true,
    chatAgentOptions: bypass,
  });
});

test("channel rules reject launch options that approve more than their permissions", () => {
  const rule = (permissions: string, options: unknown) =>
    ChannelRouteSchema.safeParse({
      id: "r",
      name: "r",
      condition: { always: true },
      action: { type: "agent", agent: "claude", project_id: "p", permissions, options },
    }).success;
  expect(rule("ask", bypass)).toBe(false);
  expect(rule("accept_edits", { runtime: "acpx", args: ["--approve-all"] })).toBe(false);
  expect(rule("ask", { runtime: "acpx", args: ["--approve-reads"] })).toBe(false);
  expect(rule("auto", bypass)).toBe(true);
});

test("run effort follows the agent's launch options and stays the source of truth", () => {
  expect(withAgentRunEffort("claude", undefined, "high")).toEqual({
    runtime: "claude-sdk",
    options: { effort: "high" },
  });
  expect(
    withAgentRunEffort(
      "codex-cli",
      { runtime: "codex", args: ["-c", 'model_reasoning_effort="low"', "--enable", "x"] },
      "high",
    ),
  ).toEqual({ runtime: "codex", args: ["--enable", "x", "-c", 'model_reasoning_effort="high"'] });
  // An absent effort leaves a stored one alone (channel defaults rely on it);
  // an explicit empty effort clears it.
  expect(
    withAgentRunEffort("claude", { runtime: "claude-sdk", options: { effort: "max" } }, undefined),
  ).toEqual({ runtime: "claude-sdk", options: { effort: "max" } });
  expect(
    withAgentRunEffort("claude", { runtime: "claude-sdk", options: { effort: "max" } }, ""),
  ).toEqual({ runtime: "claude-sdk", options: {} });
  // Agents without an effort keep their options untouched.
  expect(withAgentRunEffort("a2a", { runtime: "acpx", args: ["--x"] }, undefined)).toEqual({
    runtime: "acpx",
    args: ["--x"],
  });
  expect(withAgentRunEffort("a2a", undefined, "high")).toBeUndefined();
});

test("channel rules accept effort only on agents that take one", () => {
  const rule = (agent: string, effort: string) =>
    ChannelRouteSchema.safeParse({
      id: "r",
      name: "r",
      condition: { always: true },
      action: { type: "agent", agent, project_id: "p", effort },
    }).success;
  expect(rule("claude", "high")).toBe(true);
  expect(rule("codex", "high")).toBe(true);
  expect(rule("claude", "banana")).toBe(false);
  expect(rule("cursor", "high")).toBe(false);
  expect(rule("default", "high")).toBe(true);
});
