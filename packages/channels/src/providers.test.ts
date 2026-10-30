import { afterEach, expect, test } from "bun:test";
import { ChannelConnectionSchema, type ChannelInbound, channelCommand } from "@orc/core/channels";
import { createChannelTransport, slackManifest } from "./providers.js";

const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
});

test("Telegram registers built-in and custom slash commands through its owned transport", async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1) ?? "";
    requests.push({ method, body: JSON.parse(String(init?.body)) });
    if (method === "getUpdates")
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    return Response.json({
      ok: true,
      result: method === "getMe" ? { id: 1, username: "orcbot" } : {},
    });
  }) as unknown as typeof fetch;
  const connection = ChannelConnectionSchema.parse({
    id: "tg",
    name: "Telegram",
    provider: "telegram",
    config: {
      commands: [{ command: "summary", description: "Summarize", prompt: "Summarize $ARGUMENTS" }],
    },
  });
  const transport = createChannelTransport(connection, { token: "fixture" });
  await transport.identity();
  await transport.start(
    () => {},
    () => {},
  );
  const commands = requests.find((r) => r.method === "setMyCommands")?.body.commands;
  expect(commands).toContainEqual({
    command: "help",
    description: "Chat controls and custom shortcuts",
  });
  expect(commands).toContainEqual({ command: "summary", description: "Summarize" });
  await transport.stop();
});

test("Slack Socket Mode acknowledges slash commands and routes them with verified sender/channel identity", async () => {
  let socket: FakeSocket | undefined;
  class FakeSocket {
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    sent: string[] = [];
    constructor(_url: string) {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(text: string) {
      this.sent.push(text);
    }
    close() {
      this.onclose?.();
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (url) =>
    Response.json(
      String(url).endsWith("auth.test")
        ? { ok: true, user_id: "BOT", team_id: "T1" }
        : { ok: true, url: "wss://fixture.invalid" },
    )) as typeof fetch;
  const connection = ChannelConnectionSchema.parse({
    id: "slack",
    name: "Slack",
    provider: "slack",
  });
  const transport = createChannelTransport(connection, {
    bot_token: "fixture",
    app_token: "fixture-app",
  });
  const received: ChannelInbound[] = [];
  const failures: string[] = [];
  await transport.identity();
  await transport.start(
    (message) => received.push(message),
    (code) => failures.push(code),
  );
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "slash_commands",
      envelope_id: "e1",
      payload: { command: "/orc", text: "summary task-123", channel_id: "D1", user_id: "U1" },
    }),
  });
  expect(socket?.sent).toEqual([JSON.stringify({ envelope_id: "e1" })]);
  expect(received[0]).toMatchObject({
    sender: "U1",
    chat: "D1",
    text: "/orc summary task-123",
    is_direct: true,
    message_id: "e1",
  });
  expect(channelCommand(received[0]?.text ?? "")).toEqual({ name: "summary", args: "task-123" });
  expect(slackManifest.features.slash_commands[0]?.command).toBe("/orc");
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "events_api",
      envelope_id: "e2",
      payload: {
        event: {
          type: "app_mention",
          user: "U1",
          channel: "C1",
          text: "<@BOT> /status",
          ts: String(Date.now() / 1000),
        },
      },
    }),
  });
  expect(received[1]?.text).toBe("/status");
  socket?.onmessage?.({
    data: JSON.stringify({
      type: "slash_commands",
      envelope_id: "wrong-team",
      payload: { team_id: "OTHER", command: "/orc", text: "help", channel_id: "D1", user_id: "U1" },
    }),
  });
  expect(received.length).toBe(2);
  expect(failures.some((code) => code.includes("workspace_mismatch"))).toBe(true);

  await transport.stop();
});

test("shortcut configuration rejects reserved commands and command parsing is bounded", () => {
  expect(
    ChannelConnectionSchema.safeParse({
      id: "test",
      name: "Test",
      provider: "telegram",
      config: { commands: [{ command: "help", description: "override", prompt: "override" }] },
    }).success,
  ).toBe(false);
  expect(channelCommand("/help@OrcBot")).toEqual({ name: "help", args: "" });
  expect(channelCommand("/orc")).toEqual({ name: "help", args: "" });
  expect(channelCommand("/orc /status")).toEqual({ name: "status", args: "" });
  expect(channelCommand(`/orc ${"orc ".repeat(10000)}`)).toBeNull();
});

test("explicit rate limits retry safely, ambiguous network failures never retry", async () => {
  const connection = ChannelConnectionSchema.parse({
    id: "tg",
    name: "Telegram",
    provider: "telegram",
  });
  const transport = createChannelTransport(connection, { token: "fixture" });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls === 1
      ? Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 0 } },
          { status: 429 },
        )
      : Response.json({ ok: true, result: { message_id: 10 } });
  }) as unknown as typeof fetch;
  expect(await transport.send({ chat_id: "123", text: "Test" })).toBe("10");
  expect(calls).toBe(2);
  calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("network timeout");
  }) as unknown as typeof fetch;
  await expect(transport.send({ chat_id: "123", text: "Test" })).rejects.toMatchObject({
    ambiguous: true,
  });
  expect(calls).toBe(1);
});

test("Telegram resumes its persisted account cursor after downtime without replaying old first-setup messages", async () => {
  const connection = ChannelConnectionSchema.parse({
    id: "tg",
    name: "Telegram",
    provider: "telegram",
  });
  for (const resume of [true, false]) {
    let polls = 0;
    let saved = resume ? "124" : undefined;
    const offsets: number[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getUpdates") {
        offsets.push(JSON.parse(String(init?.body)).offset);
        if (polls++ === 0)
          return Response.json({
            ok: true,
            result: [
              {
                update_id: 124,
                message: {
                  message_id: 88,
                  date: Math.floor(Date.now() / 1000) - 60,
                  text: "sent during downtime",
                  chat: { id: 1, type: "private" },
                  from: { id: 1 },
                },
              },
            ],
          });
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      }
      return Response.json({ ok: true, result: {} });
    }) as unknown as typeof fetch;
    const received: ChannelInbound[] = [];
    const transport = createChannelTransport(
      connection,
      { token: "fixture" },
      {
        loadCursor: () => saved,
        saveCursor: (value) => {
          saved = value;
        },
      },
    );
    await transport.start(
      (message) => received.push(message),
      () => {},
    );
    const deadline = Date.now() + 1000;
    while (polls < 2 && Date.now() < deadline) await Bun.sleep(5);
    await transport.stop();
    expect(offsets[0]).toBe(resume ? 124 : 0);
    expect(saved).toBe("125");
    expect(received.length).toBe(resume ? 1 : 0);
  }
});

test("message editing clears old buttons and accepts Telegram's unchanged-message response", async () => {
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body));
    return Response.json(
      { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
      { status: 400 },
    );
  }) as unknown as typeof fetch;
  const connection = ChannelConnectionSchema.parse({
    id: "tg",
    name: "Telegram",
    provider: "telegram",
  });
  await createChannelTransport(connection, { token: "fixture" }).edit("10", {
    chat_id: "123",
    text: "Same",
  });
  expect(payload?.reply_markup).toEqual({ inline_keyboard: [] });
});
