import { expect, test } from "bun:test";
import { agentRunSessionOptions } from "../agent-run.js";
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
