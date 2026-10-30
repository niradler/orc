import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HumanRequestStore } from "@orc/db/human-requests";
import { HumanRequestChannels } from "../human-requests.js";
import type { GatewayAdapter, IncomingMessage } from "../types.js";

test("Codex MCP approval previews deduplicate arguments without bypassing secret or size checks", async () => {
  const db = new Database(":memory:");
  try {
    const store = new HumanRequestStore(db);
    const sent: string[] = [];
    const adapter: GatewayAdapter = {
      platform: "telegram",
      start: async () => {},
      stop: async () => {},
      send: async (_id, text) => {
        sent.push(text);
        return "sent";
      },
    };
    const make = (id: string, args: Record<string, unknown>, extra = {}) =>
      store.create({
        origin: { session_id: "s", backend: "codex", request_id: id },
        kind: "approval",
        prompt: "Allow QA question?",
        notify: ["telegram"],
        action: {
          tool: "mcp__orc__tool_invoke",
          cwd: "/tmp",
          host: "local",
          input: {
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_params: args,
              tool_description: "metadata ".repeat(500),
            },
            item: { type: "mcpToolCall", server: "orc", tool: "tool_invoke", arguments: args },
            ...extra,
          },
        },
      });
    const request = make("small", {
      name: "human_request",
      arguments: { prompt: "Blue or Green?" },
    });
    const secret = make("secret", { name: "human_request" }, { password: "private-value" });
    const large = make("large", { text: "x".repeat(4000) });
    const channels = new HumanRequestChannels(store);
    await channels.notify(new Map([["telegram", adapter]]), [
      { platform: "telegram", chat_id: "nir", project_id: null, thread_id: null },
    ]);
    expect(sent.some((text) => text.includes("Blue or Green?"))).toBe(true);
    expect(sent.every((text) => !text.includes("metadata"))).toBe(true);
    const reply = (id: string) =>
      channels.reply({
        platform: "telegram",
        chatId: "nir",
        userId: "nir",
        text: `/attention ${id} 1 approve`,
      });
    expect(reply(request.id)).toContain("Response saved");
    expect(reply(secret.id)).toContain("not offered");
    expect(sent.every((text) => !text.includes("private-value"))).toBe(true);
    expect(reply(large.id)).toContain("not offered");
  } finally {
    db.close();
  }
});

test("sensitive approvals send only an ORC review notice and cannot be approved in-channel", async () => {
  const db = new Database(":memory:");
  try {
    const store = new HumanRequestStore(db);
    const request = store.create({
      origin: { session_id: "s", backend: "codex", request_id: "secret" },
      kind: "approval",
      prompt: "Connect account?",
      notify: ["telegram"],
      action: {
        tool: "connect",
        input: { password: "short", headers: { Authorization: "Bearer private-value" } },
        cwd: "/tmp",
        host: "local",
      },
    });
    const sent: string[] = [];
    const adapter: GatewayAdapter = {
      platform: "telegram",
      start: async () => {},
      stop: async () => {},
      send: async (_id, text) => {
        sent.push(text);
        return "sent";
      },
    };
    const channels = new HumanRequestChannels(store);
    await channels.notify(new Map([["telegram", adapter]]), [
      { platform: "telegram", chat_id: "nir", project_id: null, thread_id: null },
    ]);
    expect(sent[0]).toContain("sensitive input");
    expect(sent[0]).not.toContain("short");
    expect(sent[0]).not.toContain("private-value");
    expect(
      channels.reply({
        platform: "telegram",
        chatId: "nir",
        userId: "nir",
        text: `/attention ${request.id} 1 approve`,
      }),
    ).toContain("not offered");
    expect(store.get(request.id).status).toBe("pending");
  } finally {
    db.close();
  }
});

test("should persist channel bindings, route only matching projects, and reject cross-chat or duplicate decisions", async () => {
  const db = new Database(":memory:");
  try {
    const store = new HumanRequestStore(db);
    const request = store.create({
      origin: { session_id: "s", backend: "claude", request_id: "q" },
      kind: "question",
      prompt: "Which color?",
      project_id: "project-a",
      notify: ["telegram"],
    });
    const sent: string[] = [];
    const adapter: GatewayAdapter = {
      platform: "telegram",
      start: async () => {},
      stop: async () => {},
      send: async (id, text) => {
        sent.push(`${id}:${text}`);
        return "message";
      },
    };
    const adapters = new Map([["telegram", adapter]]);
    const targets = [
      { platform: "telegram", chat_id: "nir", project_id: "project-a", thread_id: null },
      { platform: "telegram", chat_id: "other", project_id: "project-b", thread_id: null },
    ];
    await new HumanRequestChannels(store).notify(adapters, targets);
    await new HumanRequestChannels(new HumanRequestStore(db)).notify(adapters, targets);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`/attention ${request.id} 1 answer`);
    const message: IncomingMessage = {
      platform: "telegram",
      chatId: "other",
      userId: "nir",
      text: `/attention ${request.id} 1 answer Blue`,
    };
    const channels = new HumanRequestChannels(store);
    expect(channels.reply(message)).toContain("not offered");
    expect(store.get(request.id).status).toBe("pending");
    expect(
      channels.reply(
        { ...message, chatId: "nir" },
        { attention: false, project_ids: ["project-a"] },
      ),
    ).toContain("disabled");
    expect(
      channels.reply(
        { ...message, chatId: "nir" },
        { attention: true, project_ids: ["project-b"] },
      ),
    ).toContain("no longer has access");
    expect(store.get(request.id).status).toBe("pending");
    expect(channels.reply({ ...message, chatId: "nir" })).toContain("Response saved");
    expect(channels.reply({ ...message, chatId: "nir" })).toContain("stale");
    expect(store.get(request.id).response).toEqual({ kind: "question", answer: "Blue" });
    expect(channels.reply({ ...message, text: "Blue" })).toBeNull();
  } finally {
    db.close();
  }
});

test("should retry failed sends, bind Slack threads, and require full review for oversized approvals", async () => {
  const db = new Database(":memory:");
  let now = 1000;
  try {
    const store = new HumanRequestStore(db, () => now);
    const create = (id: string, command: string) =>
      store.create({
        origin: { session_id: "s", backend: "codex", request_id: id },
        kind: "approval",
        prompt: "Run?",
        notify: ["slack"],
        action: { tool: "command", input: { command }, cwd: "/tmp", host: "local" },
      });
    const request = create("a", "pwd");
    const oversized = create("b", "x".repeat(4000));
    let attempts = 0;
    const adapter: GatewayAdapter = {
      platform: "slack",
      start: async () => {},
      stop: async () => {},
      send: async () => {
        if (++attempts === 1) throw new Error("offline");
        return "sent";
      },
    };
    const channels = new HumanRequestChannels(store);
    const targets = [
      { platform: "slack", chat_id: "channel", project_id: null, thread_id: "thread" },
    ];
    await channels.notify(new Map([["slack", adapter]]), targets);
    now += 31000;
    await channels.notify(new Map([["slack", adapter]]), targets);
    expect(attempts).toBe(3);
    const message: IncomingMessage = {
      platform: "slack",
      chatId: "channel",
      userId: "nir",
      text: `/attention ${request.id} 1 deny`,
    };
    expect(channels.reply(message)).toContain("not offered");
    expect(
      channels.reply({
        ...message,
        threadId: "thread",
        text: `/attention ${oversized.id} 1 approve`,
      }),
    ).toContain("not offered");
    expect(channels.reply({ ...message, threadId: "thread" })).toContain("Response saved");
    expect(store.get(request.id).response).toEqual({ kind: "approval", approved: false });
    expect(store.get(oversized.id).status).toBe("pending");
  } finally {
    db.close();
  }
});
