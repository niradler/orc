import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentSession,
  registerBackend,
  type SessionOpts,
} from "@orc/agent-runtime";
import { ChannelService } from "@orc/channels";
import type { ChannelTransport } from "@orc/channels/providers";
import { resetConfig } from "@orc/core/config";
import { ChannelStore } from "@orc/db/channels";
import { createTestDb, getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { startChannelRuntime } from "../channel-runtime.js";

const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ORC_DB_PATH: process.env.ORC_DB_PATH,
};
const home = mkdtempSync(join(tmpdir(), "orc-channel-runtime-"));
let service: ChannelService;
let stop: () => Promise<void>;
const calls: Array<{ resume: boolean; opts: SessionOpts; prompt: string }> = [];
const sent: Record<string, unknown>[] = [];
let requirePermission = false;
let approved = false;
function fixture(opts: SessionOpts, resume: boolean): AgentSession {
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let decide: () => void = () => {};
  const decision = new Promise<void>((resolve) => {
    decide = resolve;
  });
  let alive = true;
  const ask = requirePermission;
  return {
    id: `fixture-${calls.length}`,
    alive: () => alive,
    send: async (prompt) => {
      calls.push({ resume, opts, prompt });
      start();
    },
    respondPermission: (_id, result) => {
      approved = result === "approved";
      decide();
    },
    async *events(): AsyncIterable<AgentEvent> {
      await started;
      if (ask) {
        yield {
          type: "permission_request",
          data: { requestId: "permission-1", tool: "fixture", command: "harmless fixture action" },
        };
        await decision;
      }
      yield { type: "text", data: "**Reply received**" };
      yield { type: "result", data: { runtimeSessionId: "native-fixture" } };
    },
    close: async () => {
      alive = false;
      decide();
      start();
    },
  };
}
beforeAll(async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  getSqlite()
    .query("INSERT INTO projects (id,name,scope) VALUES ('p1','channel-runtime',?)")
    .run(home);
  registerBackend("channels-fixture", () => ({
    name: "channels-fixture",
    startSession: async (opts) => fixture(opts, false),
    resumeSession: async (_id, opts) => fixture(opts, true),
    preflight: async () => ({ ok: true }),
    stop: async () => {},
  }));
  const transport: ChannelTransport = {
    identity: async () => ({ id: "bot", name: "bot" }),
    send: async (body) => {
      sent.push(body);
      return String(sent.length);
    },
    edit: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  service = new ChannelService(new ChannelStore(getSqlite()), () => transport);
  await service.save({
    id: "test",
    name: "Telegram",
    provider: "telegram",
    enabled: true,
    credentials: { token: "fixture" },
    targets: [
      {
        id: "me",
        name: "Nir",
        chat_id: "chat",
        user_ids: ["nir", "also-authorized"],
        project_ids: ["p1"],
        inbound: true,
        attention: true,
      },
    ],
    routes: [
      {
        id: "private",
        name: "Private",
        condition: { field: "is_direct", op: "is", value: true },
        action: { type: "agent", agent: "channels-fixture", project_id: "p1" },
      },
    ],
  });
  stop = await startChannelRuntime(service);
});
afterAll(async () => {
  await stop?.();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});
const message = {
  connection: "test",
  sender: "nir",
  chat: "chat",
  text: "hello",
  message_id: "m1",
  kind: "message" as const,
  is_direct: true,
  is_mention: false,
};

test("authorized channel invokes selected agent and replies; follow-up resumes only the same scoped conversation", async () => {
  await service.receive({ ...message, sender: "outsider" });
  expect(calls).toHaveLength(0);
  await service.receive(message);
  expect(calls[0]).toMatchObject({
    resume: false,
    prompt: "hello",
    opts: {
      interactive: true,
      autoApprove: false,
      humanRequestContext: { projectId: "p1", notify: ["telegram"] },
    },
  });
  expect(sent.at(-1)).toMatchObject({ chat_id: "chat", text: "<b>Reply received</b>" });
  await service.receive({ ...message, message_id: "m2", text: "follow up" });
  expect(calls[1]?.resume).toBe(true);
  await service.receive({ ...message, message_id: "m3", thread: "123" });
  expect(calls[2]?.resume).toBe(false);
  expect(sent.at(-1)?.message_thread_id).toBe(123);
});

test("native permission request uses durable Attention and a bound button response", async () => {
  requirePermission = true;
  const pending = service.receive({ ...message, message_id: "m4", thread: "456" });
  let callback = "";
  const deadline = Date.now() + 7000;
  while (!callback && Date.now() < deadline) {
    const native = sent.find((p) => p.reply_markup) as
      | { reply_markup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } }
      | undefined;
    callback = native?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";
    if (!callback) await Bun.sleep(50);
  }
  if (!callback) throw new Error("Attention notification was not sent");
  await service.receive({
    ...message,
    message_id: "action-wrong",
    kind: "action",
    text: callback,
    thread: "other",
  });
  expect(approved).toBe(false);
  await service.receive({
    ...message,
    sender: "also-authorized",
    message_id: "action-wrong-user",
    kind: "action",
    text: callback,
    thread: "456",
  });
  expect(approved).toBe(false);
  await service.receive({
    ...message,
    message_id: "action-ok",
    kind: "action",
    text: callback,
    thread: "456",
  });
  await pending;
  expect(approved).toBe(true);
}, 15000);

test("editing a recipient during a running turn cannot redirect its reply", async () => {
  requirePermission = true;
  const repliesBefore = sent.filter((p) => String(p.text).includes("Reply received")).length;
  const pending = service.receive({ ...message, message_id: "m5", thread: "789" });
  const human = new HumanRequestStore(getSqlite());
  let request = human
    .list()
    .find((r) => r.status === "pending" && r.input.origin.channel?.thread_id === "789");
  const deadline = Date.now() + 3000;
  while (!request && Date.now() < deadline) {
    await Bun.sleep(20);
    request = human
      .list()
      .find((r) => r.status === "pending" && r.input.origin.channel?.thread_id === "789");
  }
  if (!request) throw new Error("Agent did not pause for the fixture permission");
  const current = service.connection("test");
  await service.save({
    ...current,
    credentials: {},
    targets: current.targets.map((t) => ({ ...t, chat_id: "replacement" })),
  });
  human.respond(request.id, request.version, { kind: "approval", approved: true });
  await pending;
  expect(sent.some((p) => p.chat_id === "replacement")).toBe(false);
  expect(sent.filter((p) => String(p.text).includes("Reply received"))).toHaveLength(repliesBefore);
});
