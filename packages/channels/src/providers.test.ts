import { afterEach, expect, test } from "bun:test";
import {
  ChannelCommandsSchema,
  ChannelConnectionSchema,
  type ChannelInbound,
  channelCommand,
} from "@orc/core/channels";
import { createChannelTransport, slackManifest } from "./providers.js";
import { telegramFiles } from "./telegram.js";

const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
test("Telegram extracts documents and largest photos and bounds file downloads", async () => {
  expect(
    telegramFiles({
      message_id: 12,
      document: {
        file_id: "document-id",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 4,
      },
    }),
  ).toEqual([
    {
      fileId: "document-id",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 4,
      description: "Telegram document",
    },
  ]);
  expect(
    telegramFiles({
      message_id: 12,
      photo: [{ file_id: "small" }, { file_id: "large", file_size: 4 }],
    })[0]?.fileId,
  ).toBe("large");
  let downloads = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("getFile"))
      return Response.json({
        ok: true,
        result: { file_path: "documents/report.bin", file_size: 4 },
      });
    downloads++;
    return new Response(new Uint8Array([0, 255, 1, 10]));
  }) as typeof fetch;
  const transport = createChannelTransport(
    ChannelConnectionSchema.parse({ id: "uploads", name: "Uploads", provider: "telegram" }),
    { token: "private-fixture" },
  );
  if (!transport.downloadFile) throw new Error("No Telegram file downloader");
  const file = await transport.downloadFile({
    fileId: "document-id",
    name: "report.bin",
    mimeType: "application/octet-stream",
    size: 4,
  });
  expect(file.data).toEqual(new Uint8Array([0, 255, 1, 10]));
  await expect(
    transport.downloadFile({ fileId: "large", name: "large.bin", mimeType: "", size: 20_000_001 }),
  ).rejects.toThrow("20 MB");
  expect(downloads).toBe(1);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
});

test("should resolve a custom emoji to its real sticker format and download its original bytes", async () => {
  const methods: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1) ?? "";
    methods.push(method);
    if (method === "getCustomEmojiStickers") {
      expect(JSON.parse(String(init?.body))).toEqual({ custom_emoji_ids: ["123"] });
      return Response.json({
        ok: true,
        result: [{ file_id: "real-id", custom_emoji_id: "123", is_video: true, emoji: "🙂" }],
      });
    }
    if (method === "getFile") {
      expect(JSON.parse(String(init?.body))).toEqual({ file_id: "real-id" });
      return Response.json({ ok: true, result: { file_path: "stickers/real.webm" } });
    }
    return new Response(new Uint8Array([0, 255, 1, 2]));
  }) as typeof fetch;
  const transport = createChannelTransport(
    ChannelConnectionSchema.parse({ id: "tg", name: "Telegram", provider: "telegram" }),
    { token: "fixture" },
  );
  if (!transport.downloadFile) throw new Error("Missing file downloader");
  const file = await transport.downloadFile({
    fileId: "custom-emoji:123",
    customEmojiId: "123",
    name: "emoji.webp",
    mimeType: "image/webp",
  });
  expect(file).toMatchObject({
    name: "sticker-123.webm",
    mimeType: "video/webm",
    description: expect.stringContaining("emoji: 🙂"),
  });
  expect(file.data).toEqual(new Uint8Array([0, 255, 1, 2]));
  expect(methods).toEqual(["getCustomEmojiStickers", "getFile", "real.webm"]);
});

test("should deliver emoji, captions, voice files, stickers, video notes and attributed reactions from polling", async () => {
  const received: ChannelInbound[] = [];
  let polls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).endsWith("getUpdates"))
      return Response.json({ ok: true, result: { username: "orcbot" } });
    expect(JSON.parse(String(init?.body)).allowed_updates).toContain("message_reaction");
    if (polls++ === 0) {
      const base = {
        chat: { id: 20, type: "private" },
        from: { id: 12 },
        date: Math.floor(Date.now() / 1000),
        message_id: 42,
      };
      const reaction = {
        chat: base.chat,
        user: base.from,
        date: base.date,
        message_id: 42,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      };
      return Response.json({
        ok: true,
        result: [
          { update_id: 1, message: { ...base, voice: { file_id: "voice", duration: 4 } } },
          {
            update_id: 2,
            message: { ...base, sticker: { file_id: "sticker", emoji: "🙂", is_animated: true } },
          },
          { update_id: 3, message: { ...base, video_note: { file_id: "video", duration: 3 } } },
          {
            update_id: 4,
            message: { ...base, caption: "Look 🙂 @orcbot", photo: [{ file_id: "photo" }] },
          },
          { update_id: 5, message_reaction: reaction },
          {
            update_id: 6,
            message_reaction: { ...reaction, user: undefined, actor_chat: { id: 20 } },
          },
          { update_id: 7, message_reaction: { ...reaction, user: { id: 99, is_bot: true } } },
          { update_id: 8, message: { ...base, text: "👍 👨‍👩‍👧‍👦" } },
          { update_id: 9, edited_message: { ...base, text: "Edited 🙂", edit_date: base.date } },
        ],
      });
    }
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  }) as typeof fetch;
  const transport = createChannelTransport(
    ChannelConnectionSchema.parse({ id: "tg", name: "Telegram", provider: "telegram" }),
    { token: "fixture" },
    { loadCursor: () => "1", saveCursor: () => {} },
  );
  try {
    await transport.identity();
    await transport.start(
      (value) => received.push(value),
      () => {},
    );
    const deadline = Date.now() + 2000;
    while (polls < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(received).toHaveLength(7);
    expect(received[0]?.attachments?.[0]).toMatchObject({
      name: "voice-42.ogg",
      mimeType: "audio/ogg",
    });
    expect(received[1]?.attachments?.[0]?.name).toBe("sticker-42.tgs");
    expect(received[2]?.attachments?.[0]?.name).toBe("video_note-42.mp4");
    expect(received[3]).toMatchObject({ text: "Look 🙂 @orcbot", is_mention: true });
    expect(received[4]?.text).toContain('"current":["👍"]');
    expect(received[5]?.text).toBe("👍 👨‍👩‍👧‍👦");
    expect(received[6]).toMatchObject({ message_id: "edit:20:42:9", text: "Edited 🙂" });
    expect(JSON.parse(received[6]?.context ?? "{}")).toMatchObject({
      messageId: "42",
      edited: true,
    });
  } finally {
    await transport.stop();
  }
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
  expect(commands).toContainEqual({
    command: "session_new",
    description: "Start a new conversation",
  });
  expect(commands).toContainEqual({
    command: "session_list",
    description: "Choose a conversation",
  });
  for (const item of commands as Array<{ command: string }>)
    expect(item.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  await transport.stop();
});

test("single-token session controls support Telegram mentions without shadowing shortcuts", () => {
  expect(channelCommand("/session_new@orcbot")).toEqual({ name: "session", args: "new" });
  expect(channelCommand("/session_list")).toEqual({ name: "session", args: "list" });
  expect(channelCommand("/session new")).toEqual({ name: "session", args: "new" });
  expect(
    ChannelCommandsSchema.safeParse([
      { command: "session_new", description: "override", prompt: "override" },
    ]).success,
  ).toBe(false);
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
