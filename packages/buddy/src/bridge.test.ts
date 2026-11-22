import { afterEach, describe, expect, mock, test } from "bun:test";
import type { HumanRequest } from "@orc/core/human-requests";
import { type BuddyTransport, runBridge } from "./bridge.js";
import type { BuddyApi, ChatWaitingEntry } from "./orc.js";
import { sseStream } from "./orc.js";
import type { BuddySnapshot } from "./protocol.js";

const NOW = Date.now();

function fakeTransport() {
  const sent: unknown[] = [];
  let onMessage: ((value: unknown) => void) | null = null;
  let onClose: (() => void) | null = null;
  const transport: BuddyTransport & {
    sent: unknown[];
    emit(value: unknown): void;
    close(): void;
  } = {
    label: "fake",
    sent,
    send(line) {
      sent.push(JSON.parse(line));
    },
    onMessage(handler) {
      onMessage = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      onClose?.();
    },
    emit(value) {
      onMessage?.(value);
    },
  };
  return transport;
}

type FakeState = {
  sessions: unknown[];
  notifications: { notifications: unknown[]; unread: number; has_more: boolean };
  humanRequests: HumanRequest[];
  waiting: ChatWaitingEntry[];
};

function fakeApi(state: FakeState) {
  const calls = {
    respondHuman: mock(async (_id: string, _response: unknown) => {}),
    chatPermission: mock(async (_runId: string, _requestId: string, _decision: string) => ({
      ok: true,
    })),
    chatAnswer: mock(async (_runId: string, _requestId: string, _answers: unknown) => ({
      ok: true,
    })),
    markRead: mock(async (_id: string) => {}),
  };
  const api = {
    baseUrl: "http://127.0.0.1:7700",
    headers: {},
    client: {},
    sessions: async () => state.sessions,
    notifications: async () => state.notifications,
    humanRequests: async () => state.humanRequests,
    chatWaiting: async () => state.waiting,
    projects: async () => [{ id: "p1", name: "orc" }],
    tokensToday: async () => 42_000,
    respondHuman: calls.respondHuman,
    chatPermission: calls.chatPermission,
    chatAnswer: calls.chatAnswer,
    markRead: calls.markRead,
    createToken: async () => ({ token: "t", expires_at: 0 }),
  } as unknown as BuddyApi;
  return { api, calls };
}

function approval(id: string): HumanRequest {
  return {
    id,
    input: {
      origin: { session_id: "s1", backend: "claude", request_id: "r" },
      project_id: "p1",
      kind: "approval",
      title: "Approve Bash",
      prompt: "rm -rf /tmp/foo",
      choices: [],
      choice_descriptions: {},
      multi_select: false,
      notify: [],
      expires_in_seconds: 86400,
    },
    status: "pending",
    delivery_error: null,
    version: 1,
    response: null,
    created_at: NOW,
    expires_at: NOW + 86_400_000,
    responded_at: null,
    delivered_at: null,
    seen_at: null,
    push_state: null,
    push_error: null,
  };
}

/** An SSE response that stays open; the controller can push more frames later. */
function openSse(frames: string[]) {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(startController) {
      controller = startController;
      for (const frame of frames) startController.enqueue(new TextEncoder().encode(frame));
    },
  });
  return {
    response: new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    push(frame: string) {
      controller?.enqueue(new TextEncoder().encode(frame));
    },
  };
}

const realFetch = globalThis.fetch;

function mockFetch(liveFrames: string[] = []) {
  const events = openSse(["event: ready\ndata: {}\n\n"]);
  const live = openSse(liveFrames);
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/events")) return events.response;
    if (url.includes("/live")) return live.response;
    return new Response(JSON.stringify({ error: `unmocked ${url}` }), { status: 500 });
  }) as unknown as typeof fetch;
  return { events, live };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const settle = () => Bun.sleep(30);

describe("runBridge", () => {
  test("sends an initial snapshot and keepalives refresh t", async () => {
    mockFetch();
    const transport = fakeTransport();
    const { api } = fakeApi({
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [],
      waiting: [],
    });
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 20 });
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
    const first = transport.sent[0] as BuddySnapshot;
    expect(first.mood).toBe("idle");
    expect(first.v).toBe(1);
    await Bun.sleep(45);
    const later = transport.sent.at(-1) as BuddySnapshot;
    expect(later.t).toBeGreaterThanOrEqual(first.t);
    await bridge.stop();
  });

  test("respond routes a human approval and acks", async () => {
    mockFetch();
    const transport = fakeTransport();
    const { api, calls } = fakeApi({
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [approval("req1")],
      waiting: [],
    });
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 60_000 });
    transport.emit({ cmd: "respond", id: "req1", decision: "approve" });
    await settle();
    expect(calls.respondHuman).toHaveBeenCalledWith("req1", { kind: "approval", approved: true });
    expect(transport.sent.some((value) => (value as { ack?: string }).ack === "respond")).toBe(
      true,
    );
    await bridge.stop();
  });

  test("respond routes a chat approval captured from the live replay", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "thread", runId: "run-1", thread: { title: "Deploy", projectId: "p1", messages: [] } })}\n\n`,
      `data: ${JSON.stringify({ type: "permission_request", data: { requestId: "perm-1", tool: "Bash", command: "git push" } })}\n\n`,
    ];
    mockFetch(frames);
    const transport = fakeTransport();
    const { api, calls } = fakeApi({
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [],
      waiting: [
        {
          thread_id: "t1",
          title: "Deploy",
          agent: "claude",
          request_key: "hashed",
          kind: "approval",
          native_session_id: null,
          host: null,
        },
      ],
    });
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 60_000 });
    await settle();
    const snapshot = transport.sent.find(
      (value) => (value as BuddySnapshot).needs_you?.length,
    ) as BuddySnapshot;
    expect(snapshot.needs_you).toHaveLength(1);
    expect(snapshot.needs_you[0]?.id).toBe("chat:run-1:perm-1");
    expect(snapshot.needs_you[0]?.hint).toBe("Bash: git push");
    transport.emit({ cmd: "respond", id: "chat:run-1:perm-1", decision: "deny" });
    await settle();
    expect(calls.chatPermission).toHaveBeenCalledWith("run-1", "perm-1", "denied");
    await bridge.stop();
  });

  test("answer validates the choice against the request options", async () => {
    mockFetch();
    const transport = fakeTransport();
    const question = approval("req2");
    question.input = { ...question.input, kind: "question", choices: ["Yes", "No"] };
    const { api, calls } = fakeApi({
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [question],
      waiting: [],
    });
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 60_000 });
    transport.emit({ cmd: "answer", id: "req2", choice: "No" });
    await settle();
    expect(calls.respondHuman).toHaveBeenCalledWith("req2", {
      kind: "question",
      answer: "No",
      selected_choices: ["No"],
    });
    transport.emit({ cmd: "answer", id: "req2", choice: "Maybe" });
    await settle();
    const acks = transport.sent.filter((value) => (value as { ack?: string }).ack === "answer");
    expect(acks.at(-1)).toMatchObject({ ok: false });
    await bridge.stop();
  });

  test("read marks a notification and ping acks with the time", async () => {
    mockFetch();
    const transport = fakeTransport();
    const { api, calls } = fakeApi({
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [],
      waiting: [],
    });
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 60_000 });
    transport.emit({ cmd: "read", id: "n9" });
    transport.emit({ cmd: "ping" });
    await settle();
    expect(calls.markRead).toHaveBeenCalledWith("n9");
    const ping = transport.sent.find((value) => (value as { ack?: string }).ack === "ping") as {
      ok: boolean;
      data: { t: number };
    };
    expect(ping.ok).toBe(true);
    expect(ping.data.t).toBeGreaterThan(0);
    await bridge.stop();
  });

  test("malformed commands ack with an error instead of crashing", async () => {
    mockFetch();
    const transport = fakeTransport();
    const { api } = fakeApi({
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [],
      waiting: [],
    });
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 60_000 });
    transport.emit({ cmd: "respond", id: "req1", decision: "sometimes" });
    transport.emit({ hello: "world" });
    await settle();
    const ack = transport.sent.find((value) => (value as { ack?: string }).ack === "respond");
    expect(ack).toMatchObject({ ok: false });
    await bridge.stop();
  });

  test("a fresh completion celebrates; unchanged refreshes do not resend", async () => {
    const { events } = mockFetch();
    const transport = fakeTransport();
    const state: FakeState = {
      sessions: [],
      notifications: { notifications: [], unread: 0, has_more: false },
      humanRequests: [],
      waiting: [],
    };
    const { api } = fakeApi(state);
    const bridge = await runBridge({ api, transport, debounceMs: 5, keepaliveMs: 60_000 });
    const initialCount = transport.sent.length;

    state.notifications = {
      notifications: [
        {
          id: "n-done",
          type: "agent.finished",
          source_id: "s1",
          title: "Agent finished",
          body: "",
          level: "done",
          project_id: "p1",
          path: "/activity",
          requires_action: false,
          created_at: Date.now() + 10,
          expires_at: Date.now() + 86_400_000,
          read_at: null,
          dismissed_at: null,
        },
      ],
      unread: 1,
      has_more: false,
    };
    events.push('event: change\ndata: {"resources":["notifications"]}\n\n');
    await settle();
    const celebrated = transport.sent.at(-1) as BuddySnapshot;
    expect(celebrated.mood).toBe("celebrate");

    // Same state again: only the keepalive timestamp would differ, so no send.
    const countAfterCelebrate = transport.sent.length;
    events.push('event: change\ndata: {"resources":["notifications"]}\n\n');
    await settle();
    expect(transport.sent.length).toBe(countAfterCelebrate);
    expect(transport.sent.length).toBeGreaterThan(initialCount);
    await bridge.stop();
  });
});

describe("sseStream", () => {
  test("parses events, data and comment keepalives across chunk boundaries", async () => {
    const first = new TextEncoder().encode(': keepalive\n\nevent: change\ndata: {"resources":');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first.slice(0, 25));
        controller.enqueue(first.slice(25));
        controller.enqueue(new TextEncoder().encode('["sessions"]}\n\nevent: ready\ndata: {}\n\n'));
        controller.close();
      },
    });
    const messages = [];
    for await (const message of sseStream(new Response(stream))) messages.push(message);
    expect(messages).toEqual([
      { event: "change", data: '{"resources":["sessions"]}' },
      { event: "ready", data: "{}" },
    ]);
  });
});
