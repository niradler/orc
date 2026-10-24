import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HumanRequestStore } from "@orc/db/human-requests";
import { HumanRequestChannels } from "../human-requests.js";
import type { GatewayAdapter, IncomingMessage } from "../types.js";

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
