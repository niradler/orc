import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
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
let requireQuestion = false;
let questionAnswer: Record<string, string[]> | undefined;
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
  const question = requireQuestion;
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
    respondQuestion: (_id, answers) => {
      questionAnswer = answers;
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
      if (question) {
        yield {
          type: "question_request",
          data: {
            requestId: "q1",
            questions: [
              {
                id: "answer",
                header: "Color",
                question: "Which color?",
                options: [
                  { label: "Blue", description: "Blue option" },
                  { label: "Green", description: "Green option" },
                ],
              },
            ],
          },
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
  mkdirSync(join(home, "second"));
  getSqlite()
    .query("INSERT INTO projects (id,name,scope) VALUES ('p2','channel-second',?)")
    .run(join(home, "second"));
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
      orcMcpMode: "meta",
      systemPromptAppend: expect.stringContaining("skill_read"),
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

test("custom native buttons invoke an agent only through an authorized matching action route", async () => {
  requirePermission = false;
  const current = service.connection("test");
  await service.save({
    ...current,
    credentials: {},
    routes: [
      {
        id: "buttons",
        name: "Custom buttons",
        enabled: true,
        condition: {
          all: [
            { field: "kind", op: "is", value: "action" },
            { field: "text", op: "is", value: "summarize-task" },
          ],
        },
        action: { type: "agent", agent: "channels-fixture", project_id: "p1" },
      },
      ...current.routes.map((r) => ({
        ...r,
        condition: { all: [{ field: "kind", op: "is", value: "message" }, r.condition] },
      })),
    ],
  });
  const before = calls.length;
  await service.receive({
    ...message,
    message_id: "native-button-outside",
    sender: "outsider",
    kind: "action",
    text: "summarize-task",
    thread: "457",
  });
  expect(calls).toHaveLength(before);
  await service.receive({
    ...message,
    message_id: "native-button",
    kind: "action",
    text: "summarize-task",
    thread: "457",
  });
  expect(calls).toHaveLength(before + 1);
  expect(calls.at(-1)?.prompt).toBe("summarize-task");
  expect(sent.at(-1)).toMatchObject({ chat_id: "chat", message_thread_id: 457 });
  await service.receive({
    ...message,
    message_id: "unmatched-button",
    kind: "action",
    text: "unknown-button",
    thread: "457",
  });
  expect(calls).toHaveLength(before + 1);
});

test("channel commands manage scoped sessions, custom shortcuts and native slash input", async () => {
  requirePermission = false;
  const before = calls.length;
  await service.receive({ ...message, message_id: "command-help", text: "/help@mybot" });
  expect(calls.length).toBe(before);
  expect(String(sent.at(-1)?.text)).toContain("ORC chat controls");
  await service.receive({
    ...message,
    message_id: "command-new",
    text: "/session new",
    thread: "commands",
  });
  expect(String(sent.at(-1)?.text)).toContain("Created and activated");
  await service.receive({
    ...message,
    message_id: "command-first",
    text: "first",
    thread: "commands",
  });
  expect(calls.at(-1)?.resume).toBe(false);
  await service.receive({
    ...message,
    message_id: "command-new2",
    text: "/session new",
    thread: "commands",
  });
  await service.receive({
    ...message,
    message_id: "command-second",
    text: "second",
    thread: "commands",
  });
  expect(calls.at(-1)?.resume).toBe(false);
  const listBefore = calls.length;
  await service.receive({
    ...message,
    message_id: "command-list",
    text: "/sessions",
    thread: "commands",
  });
  expect(String(sent.at(-1)?.text)).toContain("channels-fixture");
  expect(calls.length).toBe(listBefore);
  const rows = getSqlite()
    .query<{ id: string }, []>(
      "SELECT id FROM gateway_sessions WHERE chat_id LIKE '%commands%' ORDER BY created_at",
    )
    .all();
  expect(rows.length).toBe(2);
  await service.receive({
    ...message,
    message_id: "command-switch",
    text: `/session switch ${rows[0]?.id}`,
    thread: "commands",
  });
  await service.receive({
    ...message,
    message_id: "command-resume",
    text: "third",
    thread: "commands",
  });
  expect(calls.at(-1)?.resume).toBe(true);
  const current = service.connection("test");
  await service.save({
    ...current,
    credentials: {},
    config: {
      commands: [
        { command: "summary", description: "Task summary", prompt: "Summarize $ARGUMENTS" },
      ],
    },
  });
  await service.receive({
    ...message,
    message_id: "command-custom",
    text: "/orc summary task-123",
    thread: "commands",
  });
  expect(calls.at(-1)?.prompt).toBe("Summarize task-123");
  await service.receive({
    ...message,
    message_id: "command-native",
    text: "/backend-native-command args",
    thread: "commands",
  });
  expect(calls.at(-1)?.prompt).toBe("/backend-native-command args");
  const count = calls.length;
  await service.receive({
    ...message,
    message_id: "command-deny-cwd",
    text: "/project unavailable-project",
    thread: "commands",
  });
  expect(calls.length).toBe(count);
  expect(String(sent.at(-1)?.text)).toContain("unavailable or not allowed");
  await service.receive({
    ...message,
    message_id: "command-deny-bypass",
    text: "/session mode bypass",
    thread: "commands",
  });
  expect(String(sent.at(-1)?.text)).toContain("Use /session new");
  await stop();
  stop = await startChannelRuntime(service);
  await service.receive({
    ...message,
    message_id: "command-after-restart",
    text: "resume after restart",
    thread: "commands",
  });
  expect(calls.at(-1)?.resume).toBe(true);
});

test("stop interrupts a pending agent turn and discards already queued messages", async () => {
  requirePermission = true;
  const count = calls.length;
  const pending = service.receive({ ...message, message_id: "stop-running", thread: "stop" });
  const deadline = Date.now() + 3000;
  while (calls.length === count && Date.now() < deadline) await Bun.sleep(10);
  expect(calls.length).toBe(count + 1);
  const queued = service.receive({
    ...message,
    message_id: "stop-queued",
    thread: "stop",
    text: "must not execute",
  });
  await service.receive({ ...message, message_id: "stop-control", thread: "stop", text: "/stop" });
  await Promise.all([pending, queued]);
  expect(calls.length).toBe(count + 1);
  expect(sent.some((p) => String(p.text).includes("Stopped the current turn"))).toBe(true);
  expect(
    getSqlite()
      .query<{ status: string }, []>(
        "SELECT status FROM gateway_sessions WHERE chat_id LIKE '%stop%' ORDER BY created_at DESC LIMIT 1",
      )
      .get()?.status,
  ).toBe("stopped");
  requirePermission = false;
});

test("an authorized unmatched message explains setup without invoking an agent", async () => {
  const current = service.connection("test");
  await service.save({ ...current, credentials: {}, routes: [] });
  const count = calls.length;
  await service.receive({ ...message, message_id: "no-route", text: "hello" });
  expect(calls.length).toBe(count);
  expect(String(sent.at(-1)?.text)).toContain("No inbound route matches");
  await service.save({ ...service.connection("test"), credentials: {}, routes: current.routes });
});

test("a plain answer to the single bound question resumes the waiting agent", async () => {
  requirePermission = false;
  requireQuestion = true;
  questionAnswer = undefined;
  const count = calls.length;
  const pending = service.receive({ ...message, message_id: "question-turn", thread: "question" });
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const human = new HumanRequestStore(getSqlite());
    const request = human
      .list()
      .find((r) => r.status === "pending" && r.input.origin.channel?.thread_id === "question");
    if (
      request &&
      human.canReply(request.id, request.version, "test:me", JSON.stringify(["chat", "question"]))
    )
      break;
    await Bun.sleep(20);
  }
  await service.receive({
    ...message,
    message_id: "question-answer",
    thread: "question",
    text: "Blue",
  });
  await pending;
  expect(questionAnswer as Record<string, string[]> | undefined).toEqual({ answer: ["Blue"] });
  expect(calls.length).toBe(count + 1);
  requireQuestion = false;
}, 10000);

test("project and model controls isolate sessions and spawn in the selected project's folder", async () => {
  requirePermission = false;
  const current = service.connection("test");
  await service.save({
    ...current,
    credentials: {},
    targets: current.targets.map((t) => ({ ...t, project_ids: ["p1", "p2"] })),
  });
  const send = (id: string, text: string) =>
    service.receive({ ...message, message_id: id, thread: "900", text });
  await send("model-set", "/model fixture-model");
  await send("model-run", "first project message");
  expect(calls.at(-1)?.opts).toMatchObject({
    cwd: home,
    model: "fixture-model",
    humanRequestContext: { projectId: "p1" },
  });
  await send("project-choose", "/project channel-second");
  expect(String(sent.at(-1)?.text)).toContain(join(home, "second"));
  await send("project-run", "second project message");
  expect(calls.at(-1)?.opts).toMatchObject({
    cwd: join(home, "second"),
    humanRequestContext: { projectId: "p2" },
  });
  expect(calls.at(-1)?.resume).toBe(false);
  const otherSession = getSqlite()
    .query<{ id: string }, []>(
      "SELECT id FROM gateway_sessions WHERE project_id='p2' ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  await send("project-default", "/project default");
  await send("project-resume", "back to first project");
  expect(calls.at(-1)?.opts.cwd).toBe(home);
  expect(calls.at(-1)?.opts.model).toBe("fixture-model");
  expect(calls.at(-1)?.resume).toBe(true);
  const count = calls.length;
  await send("project-session-deny", `/session switch ${otherSession?.id}`);
  expect(String(sent.at(-1)?.text)).toContain("unavailable in this project");
  expect(calls.length).toBe(count);
  await send("model-default", "/model default");
  await send("model-default-run", "use default model");
  expect(calls.at(-1)?.opts.model).toBeUndefined();
  await service.save({ ...service.connection("test"), credentials: {}, targets: current.targets });
});

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
