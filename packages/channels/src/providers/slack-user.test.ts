import { afterEach, expect, test } from "bun:test";
import { ChannelConnectionSchema, type ChannelInbound } from "@orc/core/channels";
import { createChannelTransport } from "./registry.js";
import { slackUser, slackUserInbound } from "./slack-user.js";

const originalFetch = globalThis.fetch;
const OriginalSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalSocket;
  socket = undefined;
});

type SocketOptions = { headers?: Record<string, string> };
let socket: FakeSocket | undefined;
class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(
    readonly url: string,
    readonly options?: SocketOptions,
  ) {
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

const connection = ChannelConnectionSchema.parse({
  id: "su",
  name: "Slack user",
  provider: "slack-user",
});
const credentials = { token: "xoxc-fixture", cookie: "xoxd-fixture" };
const now = () => String(Date.now() / 1000);

function mockSlack(overrides: Record<string, unknown> = {}) {
  const requests: Array<{ method: string; headers: Record<string, string>; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1) ?? "";
    requests.push({
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        init?.body && String(init.body).startsWith("{")
          ? JSON.parse(String(init.body))
          : init?.body,
    });
    if (method === "auth.test")
      return Response.json({
        ok: true,
        user_id: "U_SELF",
        user: "nir",
        team_id: "T1",
        team: "Acme",
      });
    if (method === "rtm.connect")
      return Response.json(overrides.rtm ?? { ok: true, url: "wss://fixture.invalid" });
    if (method === "chat.postMessage") return Response.json({ ok: true, ts: "1732000000.000100" });
    if (method === "chat.update") return Response.json({ ok: true });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return requests;
}

async function startedTransport(received: ChannelInbound[], failures: string[]) {
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  const transport = createChannelTransport(connection, credentials);
  await transport.start(
    (message) => received.push(message),
    (code) => failures.push(code),
  );
  const deadline = Date.now() + 2000;
  while (!socket && Date.now() < deadline) await Bun.sleep(5);
  if (!socket) throw new Error("earshot did not open a socket");
  return transport;
}

function frame(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "message",
    channel: "C1",
    user: "U_OTHER",
    text: "hello",
    ts: now(),
    ...overrides,
  });
}

test("maps earshot messages to channel inbound with threads, DMs and mention triggers", async () => {
  mockSlack();
  const received: ChannelInbound[] = [];
  const failures: string[] = [];
  const transport = await startedTransport(received, failures);
  try {
    expect(socket?.options?.headers?.Cookie).toBe("d=xoxd-fixture");
    socket?.onmessage?.({
      data: frame({ thread_ts: "1731999999.000050", text: "deploy status?" }),
    });
    expect(received[0]).toMatchObject({
      connection: "su",
      sender: "U_OTHER",
      chat: "C1",
      thread: "1731999999.000050",
      text: "deploy status?",
      kind: "message",
      is_direct: false,
      is_mention: false,
    });
    expect(received[0]?.root).toBe(received[0]?.message_id.split(":")[1]);
    expect(received[0]?.message_id).toBe(`C1:${received[0]?.root}`);

    socket?.onmessage?.({ data: frame({ channel: "D1", channel_type: "im", user: "U_SELF" }) });
    expect(received[1]).toMatchObject({ chat: "D1", is_direct: true, sender_name: "nir" });

    socket?.onmessage?.({ data: frame({ user: "U_SELF", text: "@orc summarize the thread" }) });
    expect(received[2]).toMatchObject({ text: "@orc summarize the thread", is_mention: true });

    socket?.onmessage?.({ data: frame({ text: "<@U_SELF> /status" }) });
    expect(received[3]).toMatchObject({ text: "/status", is_mention: true });

    socket?.onmessage?.({ data: frame({ text: "<@U_SELF>" }) });
    socket?.onmessage?.({ data: frame({ ts: String(Date.now() / 1000 - 3600) }) });
    expect(received).toHaveLength(4);
    expect(failures.filter(Boolean)).toEqual([]);
  } finally {
    await transport.stop();
  }
});

test("posts and edits as the user with the session cookie, and drops its own reply echoes", async () => {
  const requests = mockSlack();
  const received: ChannelInbound[] = [];
  const transport = await startedTransport(received, []);
  try {
    const ts = await transport.send({
      channel: "C1",
      text: "Working…",
      thread_ts: "1731999999.000050",
    });
    expect(ts).toBe("1732000000.000100");
    const post = requests.find((r) => r.method === "chat.postMessage");
    expect(post?.headers.Authorization).toBe("Bearer xoxc-fixture");
    expect(post?.headers.Cookie).toBe("d=xoxd-fixture");
    expect(post?.body).toMatchObject({ channel: "C1", thread_ts: "1731999999.000050" });

    socket?.onmessage?.({ data: frame({ user: "U_SELF", ts, text: "Working…" }) });
    expect(received).toHaveLength(0);

    await transport.edit(ts, { channel: "C1", text: "Done", blocks: [] });
    const update = requests.find((r) => r.method === "chat.update");
    expect(update?.headers.Cookie).toBe("d=xoxd-fixture");
    expect(update?.body).toMatchObject({ ts, text: "Done", blocks: [] });

    socket?.onmessage?.({ data: frame({ user: "U_SELF", text: "@orc next task" }) });
    expect(received).toHaveLength(1);
    expect(received[0]?.is_mention).toBe(true);
  } finally {
    await transport.stop();
  }
});

test("identity verifies the session and reports the workspace", async () => {
  const requests = mockSlack();
  const transport = createChannelTransport(connection, credentials);
  expect(await transport.identity()).toEqual({ id: "T1", name: "Acme" });
  const auth = requests.find((r) => r.method === "auth.test");
  expect(auth?.headers.Authorization).toBe("Bearer xoxc-fixture");
  expect(auth?.headers.Cookie).toBe("d=xoxd-fixture");
});

test("a rejected session surfaces session_expired and stops retrying", async () => {
  mockSlack({ rtm: { ok: false, error: "invalid_auth" } });
  const received: ChannelInbound[] = [];
  const failures: string[] = [];
  const transport = createChannelTransport(connection, credentials);
  await transport.start(
    (message) => received.push(message),
    (code) => failures.push(code),
  );
  const deadline = Date.now() + 2000;
  while (!failures.length && Date.now() < deadline) await Bun.sleep(5);
  expect(failures.some((code) => code.startsWith("session_expired"))).toBe(true);
  expect(socket).toBeUndefined();
  await transport.stop();
});

test("credential and transport configuration are validated", () => {
  expect(() => createChannelTransport(connection, { cookie: "xoxd-fixture" })).toThrow(
    "user token",
  );
  expect(() => createChannelTransport(connection, { token: "xoxc-fixture" })).toThrow("cookie");
  expect(() =>
    createChannelTransport(
      ChannelConnectionSchema.parse({ ...connection, config: { transport: "polling" } }),
      credentials,
    ),
  ).toThrow("transport");
  const dCookie = createChannelTransport(connection, {
    token: "xoxc-fixture",
    cookie: "d=xoxd-fixture",
  });
  expect(dCookie).toBeDefined();
});

test("controls render typeable commands because a user session receives no button events", () => {
  const payload = slackUser.controls("Choose a project", "markdown", [
    [
      { label: "ops", value: "/project ops" },
      { label: "Approve", value: "orc_action:secret-token" },
    ],
  ]);
  const blocks = payload.blocks as Array<{ text: { text: string } }>;
  const text = String(blocks[0]?.text.text);
  expect(text).toContain("Choose a project");
  expect(text).toContain("/project ops");
  expect(text).not.toContain("orc_action");
  expect(slackUser.info.capabilities.buttons).toBe(false);
});

test("inbound mapping drops incomplete frames and keeps the @orc trigger text for rules", () => {
  const base = { channel: "C1", user: "U1", text: "@orc help", ts: "1732000000.000100" };
  expect(slackUserInbound({ ...base, channel: "" }, "su", "U_SELF", "nir")).toBeNull();
  expect(slackUserInbound({ ...base, user: "" }, "su", "U_SELF", "nir")).toBeNull();
  expect(slackUserInbound({ ...base, text: "  " }, "su", "U_SELF", "nir")).toBeNull();
  expect(slackUserInbound(base, "su", "U_SELF", "nir")).toMatchObject({
    text: "@orc help",
    is_mention: true,
    root: "1732000000.000100",
  });
});
