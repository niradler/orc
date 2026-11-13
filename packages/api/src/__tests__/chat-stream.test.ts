import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeResource, changes } from "@orc/core/changes";
import type { ChatThread } from "@orc/core/chat";
import { globalConfigPath, resetConfig } from "@orc/core/config";
import {
  initializeAgentPreferences,
  readProviderSettings,
  saveProviderSettings,
} from "@orc/core/provider-service";
import { continuationPrompt } from "../routes/chat.js";
import type { createApp } from "../server.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const oldMock = process.env.ORC_E2E_CHAT_MOCK;
const AUTH = {
  Authorization: "Bearer test-secret",
  "content-type": "application/json",
};

beforeAll(() => {
  process.env.ORC_E2E_CHAT_MOCK = "1";
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  if (oldMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
  else process.env.ORC_E2E_CHAT_MOCK = oldMock;
});

function expectUnbuffered(res: Response) {
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(res.headers.get("x-accel-buffering")).toBe("no");
}

/**
 * These tests exercise /chat/stream without shelling out to a real LLM.
 *
 * The happy-path round-trip (spawn acpx -> stdin flush -> stdout -> SSE) is
 * covered by the Playwright e2e spec in packages/web/tests/e2e/chat.spec.ts,
 * which is the only place where spawning a real agent makes sense.
 *
 * Here we lock down the input-validation contract so a broken client cannot
 * spawn an agent with an empty or malformed prompt.
 */
describe("/chat/stream contract", () => {
  test("rejects empty messages array with 400", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/messages/i);
  });

  test("rejects missing messages field with 400", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(400);
  });

  test("runs a mocked turn even when the agent provider is disabled", async () => {
    // The browser suites chat through ORC_E2E_CHAT_MOCK with no agent CLI
    // installed, so an installed-but-disabled profile must not block the turn.
    const home = mkdtempSync(join(tmpdir(), "orc-chat-mock-"));
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".orc"), { recursive: true });
    writeFileSync(globalConfigPath(), "{}");
    resetConfig();
    initializeAgentPreferences(() => null);
    resetConfig();
    process.env.ORC_E2E_CHAT_MOCK = "1";
    try {
      const res = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          messages: [{ role: "user", content: "Reply with exactly: MOCK-OK." }],
          agent: "codex",
          model: "",
          agentOptions: {},
          workspace: { host: null, cwd: "", worktree: false },
          context: { source: "webchat", route: "/activity?project=all" },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("MOCK-OK");
    } finally {
      process.env.ORC_E2E_CHAT_MOCK = "1";
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfig();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("/chat SSE proxy buffering", () => {
  test("should disable proxy buffering on the turn stream and the live reattach stream", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [{ role: "user", content: "reply after 1000ms" }] }),
    });
    expect(res.status).toBe(200);
    expectUnbuffered(res);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No stream");
    let text = "";
    const decoder = new TextDecoder();
    let threadId: string | undefined;
    while (!threadId) {
      const part = await reader.read();
      if (part.done) throw new Error("Stream ended before the thread was announced");
      text += decoder.decode(part.value);
      for (const line of text.split("\n").filter((l) => l.startsWith("data:"))) {
        const event = JSON.parse(line.slice(5)) as { type: string; thread?: { id: string } };
        if (event.type === "thread") threadId = event.thread?.id;
      }
    }
    const live = await app.request(`/api/chat/threads/${threadId}/live`, { headers: AUTH });
    expect(live.status).toBe(200);
    expectUnbuffered(live);
    await live.body?.cancel();
    while (!(await reader.read()).done) {}
  });
});

async function threadOf(res: Response): Promise<string> {
  const text = await res.text();
  for (const line of text.split("\n").filter((l) => l.startsWith("data:"))) {
    const event = JSON.parse(line.slice(5)) as { type: string; thread?: { id: string } };
    if (event.type === "thread" && event.thread) return event.thread.id;
  }
  throw new Error("No thread event");
}

describe("/chat/stream client message id", () => {
  test("should reject a stored first-send id across newly created threads", async () => {
    const clientMessageId = crypto.randomUUID();
    const body = {
      messages: [{ role: "user", content: "Reply with exactly: ONCE." }],
      clientMessageId,
    };
    await (await streamTurn(body)).text();
    const repeat = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify(body),
    });
    if (repeat.ok) await repeat.text();
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toMatchObject({ code: "CHAT_MESSAGE_EXISTS" });
  });

  test("should release a first-send reservation after rejected preparation", async () => {
    const clientMessageId = crypto.randomUUID();
    const rejected = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        messages: [{ role: "assistant", content: "No user input" }],
        clientMessageId,
      }),
    });
    expect(rejected.status).toBe(400);
    await (
      await streamTurn({
        messages: [{ role: "user", content: "Reply with exactly: RETRIED." }],
        clientMessageId,
      })
    ).text();
  });

  test("stores the client id on the user message and rejects a repeated send", async () => {
    const clientMessageId = crypto.randomUUID();
    const first = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        messages: [{ role: "user", content: "Reply with exactly: FIRST." }],
        clientMessageId,
      }),
    });
    expect(first.status).toBe(200);
    const threadId = await threadOf(first);
    const thread = (await (
      await app.request(`/api/chat/threads/${threadId}`, { headers: AUTH })
    ).json()) as { messages: { id: string; role: string }[] };
    expect(thread.messages.find((message) => message.role === "user")?.id).toBe(clientMessageId);

    const repeat = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        messages: [{ role: "user", content: "Reply with exactly: FIRST." }],
        threadId,
        clientMessageId,
      }),
    });
    expect(repeat.status).toBe(409);
  });

  test("announces a starting turn so other clients refresh", async () => {
    const seen: ChangeResource[] = [];
    const unsubscribe = changes.subscribe(({ resources }) => seen.push(...resources));
    try {
      const res = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ messages: [{ role: "user", content: "reply after 300ms" }] }),
      });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      await reader?.read();
      expect(seen).toContain("sessions");
      while (reader && !(await reader.read()).done) {}
    } finally {
      unsubscribe();
    }
  });
});

describe("/chat/stream account switching", () => {
  function accountFixture() {
    const home = mkdtempSync(join(tmpdir(), "orc-chat-accounts-"));
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".orc"), { recursive: true });
    writeFileSync(globalConfigPath(), "{}");
    resetConfig();
    initializeAgentPreferences(() => null);
    resetConfig();
    const initial = readProviderSettings();
    saveProviderSettings({
      ...initial,
      default_provider_id: "claude",
      providers: [
        ...initial.providers.map((profile) =>
          profile.id === "claude" ? { ...profile, enabled: true } : profile,
        ),
        {
          id: "claude-two",
          name: "Claude 2",
          agent: "claude",
          enabled: true,
          executable: "",
          home: join(home, "accounts", "claude-two"),
          model: "",
          environment: [],
        },
      ],
    });
    const restore = () => {
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfig();
      rmSync(home, { recursive: true, force: true });
    };
    return { home, restore };
  }

  function streamBody(content: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
      messages: [{ role: "user", content }],
      agent: "claude",
      model: "",
      agentOptions: {},
      ...extra,
    });
  }

  async function threadState(threadId: string) {
    return (await (
      await app.request(`/api/chat/threads/${threadId}`, { headers: AUTH })
    ).json()) as {
      config: { providerId: string };
      messages: unknown[];
      providerSwitch?: unknown;
    };
  }

  /** Reads the SSE stream until the thread event names the conversation and its run. */
  async function readUntilThread(res: Response) {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No stream");
    const decoder = new TextDecoder();
    let text = "";
    let threadId = "";
    let runId = "";
    while (!threadId) {
      const part = await reader.read();
      if (part.done) throw new Error("Stream ended before the thread was announced");
      text += decoder.decode(part.value);
      for (const line of text.split("\n").filter((l) => l.startsWith("data:"))) {
        const event = JSON.parse(line.slice(5)) as {
          type: string;
          thread?: { id: string };
          runId?: string;
        };
        if (event.type === "thread" && event.thread) {
          threadId = event.thread.id;
          runId = event.runId ?? "";
        }
      }
    }
    const drain = async () => {
      while (!(await reader.read()).done) {}
    };
    return { threadId, runId, drain };
  }

  test("replays bounded prior context after the native session is replaced", () => {
    const messages = Array.from({ length: 240 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index} ${"x".repeat(600)}`,
      timestamp: index,
    }));
    const prompt = continuationPrompt(messages);
    if (!prompt) throw new Error("Continuation prompt was not built");
    expect(prompt).toContain("[ORC account switch]");
    expect(prompt).toContain("--- End of prior conversation ---");
    expect(prompt).toContain("message 239");
    expect(prompt).not.toContain("message 0 ");
    expect(prompt).toContain("[Earlier conversation omitted]");
    // An account switch keeps its historical 12k bound so a smaller-context
    // provider is not handed a larger prompt than it used to receive.
    expect(prompt.length).toBeLessThan(14_000);
    // A fork gets the long budget and keeps both the newest work and the
    // request that started it.
    const fork = continuationPrompt(messages, "fork");
    if (!fork) throw new Error("Fork continuation prompt was not built");
    expect(fork).toContain("[ORC fork]");
    expect(fork).toContain("User (original request): message 0");
    expect(fork.length).toBeGreaterThan(prompt.length * 4);
    expect(fork.length).toBeLessThan(103_000);
    expect(continuationPrompt([])).toBeUndefined();
  });

  test("keeps the newest turn when it alone exceeds the replay budget", () => {
    const tool = (index: number) => ({
      type: "tool" as const,
      id: `tool-${index}`,
      name: "shell",
      input: "x".repeat(600),
      result: "y".repeat(1_200),
    });
    // One assistant turn with enough tool work to exceed the 12k switch budget
    // on its own: the newest turn must be clipped into the replay, not dropped.
    const oversized = [
      { id: "u-0", role: "user" as const, content: "Start the task", timestamp: 0 },
      {
        id: "a-0",
        role: "assistant" as const,
        content: "final answer",
        timestamp: 1,
        activity: Array.from({ length: 10 }, (_, index) => tool(index)),
      },
    ];
    const prompt = continuationPrompt(oversized);
    if (!prompt) throw new Error("Oversized newest turn dropped the whole replay");
    expect(prompt).toContain("final answer");
    expect(prompt).toContain("[Earlier conversation omitted]");
    expect(prompt.length).toBeLessThan(14_000);

    const huge = [
      { id: "u-0", role: "user" as const, content: "Start the task", timestamp: 0 },
      {
        id: "a-0",
        role: "assistant" as const,
        content: "final answer",
        timestamp: 1,
        activity: Array.from({ length: 60 }, (_, index) => tool(index)),
      },
    ];
    const fork = continuationPrompt(huge, "fork");
    if (!fork) throw new Error("Oversized newest turn dropped the fork replay");
    expect(fork).toContain("User (original request): Start the task");
    expect(fork.length).toBeLessThan(103_000);
  });

  test("switches a live conversation to another account of the same agent", async () => {
    const { restore } = accountFixture();
    try {
      const first = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("Reply with exactly: FIRST.", { providerId: "claude" }),
      });
      expect(first.status).toBe(200);
      const threadId = await threadOf(first);

      const second = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("Reply with exactly: SECOND.", {
          threadId,
          providerId: "claude-two",
        }),
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("SECOND");

      const thread = await threadState(threadId);
      expect(thread.config.providerId).toBe("claude-two");
      expect(thread.providerSwitch).toBeUndefined();
      expect(thread.messages).toHaveLength(4);
    } finally {
      restore();
    }
  });

  test("rejects a switch while a response is running and keeps the provider", async () => {
    const { restore } = accountFixture();
    try {
      const first = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("reply after 1000ms", { providerId: "claude" }),
      });
      expect(first.status).toBe(200);
      const { threadId, drain } = await readUntilThread(first);
      const switching = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("Reply with exactly: SECOND.", {
          threadId,
          providerId: "claude-two",
        }),
      });
      expect(switching.status).toBe(409);
      expect(await switching.text()).toContain("Wait for the current response");
      await drain();
      expect((await threadState(threadId)).config.providerId).toBe("claude");
    } finally {
      restore();
    }
  });

  test("does not apply a switch when the send is invalid", async () => {
    const { restore } = accountFixture();
    try {
      const first = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("Reply with exactly: FIRST.", { providerId: "claude" }),
      });
      expect(first.status).toBe(200);
      const threadId = await threadOf(first);
      const invalid = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("   ", { threadId, providerId: "claude-two" }),
      });
      expect(invalid.status).toBe(400);
      expect((await threadState(threadId)).config.providerId).toBe("claude");
    } finally {
      restore();
    }
  });

  test("does not replay the transcript into a session the switch already established", async () => {
    const { restore } = accountFixture();
    try {
      const first = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("Reply with exactly: FIRST.", { providerId: "claude" }),
      });
      expect(first.status).toBe(200);
      const threadId = await threadOf(first);

      // The switch turn is stopped after the new session received the continuation.
      const switching = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("reply after 1000ms", { threadId, providerId: "claude-two" }),
      });
      expect(switching.status).toBe(200);
      const { runId, drain } = await readUntilThread(switching);
      const cancelled = await app.request(`/api/chat/runs/${runId}/cancel`, {
        method: "POST",
        headers: AUTH,
      });
      expect(cancelled.status).toBe(200);
      await drain();

      const next = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: streamBody("Reply with exactly: THIRD.", { threadId, providerId: "claude-two" }),
      });
      expect(next.status).toBe(200);
      const text = await next.text();
      expect(text).toContain("THIRD");
      expect(text).not.toContain("[ORC account switch]");
      const thread = await threadState(threadId);
      expect(thread.providerSwitch).toBeUndefined();
      expect(thread.messages).toHaveLength(6);
    } finally {
      restore();
    }
  });
});

async function streamTurn(body: Record<string, unknown>): Promise<Response> {
  const res = await app.request("/api/chat/stream", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res;
}

function eventsOf(text: string): { type: string; thread?: ChatThread; runId?: string }[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as { type: string; thread?: ChatThread });
}

describe("/chat/threads/by-message", () => {
  test("finds the thread that stored a client message id", async () => {
    const clientMessageId = crypto.randomUUID();
    const res = await streamTurn({
      messages: [{ role: "user", content: "Reply with exactly: LOOKUP." }],
      clientMessageId,
    });
    const threadId = await threadOf(res);
    const found = await app.request(`/api/chat/threads/by-message/${clientMessageId}`, {
      headers: AUTH,
    });
    expect(found.status).toBe(200);
    const thread = (await found.json()) as ChatThread;
    expect(thread.id).toBe(threadId);
    expect(
      thread.messages.some((message) => message.id === clientMessageId && message.role === "user"),
    ).toBe(true);
  });

  test("answers 404 for an unknown message id", async () => {
    const res = await app.request(`/api/chat/threads/by-message/${crypto.randomUUID()}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/not found/i);
  });

  test("does not match assistant message ids", async () => {
    const res = await streamTurn({
      messages: [{ role: "user", content: "Reply with exactly: ASSISTANT-ID." }],
    });
    const threadId = await threadOf(res);
    const thread = (await (
      await app.request(`/api/chat/threads/${threadId}`, { headers: AUTH })
    ).json()) as ChatThread;
    const assistantId = thread.messages.find((message) => message.role === "assistant")?.id;
    expect(assistantId).toBeTruthy();
    const found = await app.request(`/api/chat/threads/by-message/${assistantId}`, {
      headers: AUTH,
    });
    expect(found.status).toBe(404);
  });

  test("rejects a non-uuid message id with 400", async () => {
    const res = await app.request("/api/chat/threads/by-message/not-a-uuid", { headers: AUTH });
    expect(res.status).toBe(400);
  });
});

describe("slim thread event", () => {
  test("carries only the current user message on a multi-turn conversation", async () => {
    const first = await streamTurn({
      messages: [{ role: "user", content: "Reply with exactly: ONE." }],
    });
    const threadId = await threadOf(first);
    const clientMessageId = crypto.randomUUID();
    const second = await streamTurn({
      threadId,
      messages: [{ role: "user", content: "Reply with exactly: TWO." }],
      clientMessageId,
    });
    const event = eventsOf(await second.text()).find((entry) => entry.type === "thread");
    expect(event?.thread?.id).toBe(threadId);
    expect(event?.thread?.messages).toHaveLength(1);
    expect(event?.thread?.messages[0]?.id).toBe(clientMessageId);
    expect(event?.thread?.messages[0]?.role).toBe("user");
    const full = (await (
      await app.request(`/api/chat/threads/${threadId}`, { headers: AUTH })
    ).json()) as ChatThread;
    expect(full.messages).toHaveLength(4);
  });

  test("stays small even with a large stored history", async () => {
    const first = await streamTurn({
      messages: [{ role: "user", content: `Reply with exactly: ${"x".repeat(300_000)}` }],
    });
    const threadId = await threadOf(first);
    const clientMessageId = crypto.randomUUID();
    const second = await streamTurn({
      threadId,
      messages: [{ role: "user", content: "Reply with exactly: SMALL." }],
      clientMessageId,
    });
    const text = await second.text();
    const line = text.split("\n").find((entry) => entry.includes('"type":"thread"'));
    expect(line).toBeTruthy();
    expect((line ?? "").length).toBeLessThan(50_000);
    const event = JSON.parse((line ?? "").slice(5)) as { thread: ChatThread };
    expect(event.thread.messages).toHaveLength(1);
    expect(event.thread.messages[0]?.id).toBe(clientMessageId);
  });

  test("replays the slim event when attaching mid-turn", async () => {
    const first = await streamTurn({
      messages: [{ role: "user", content: "Reply with exactly: HISTORY." }],
    });
    const threadId = await threadOf(first);
    const clientMessageId = crypto.randomUUID();
    const res = await streamTurn({
      threadId,
      messages: [{ role: "user", content: "reply after 1500ms" }],
      clientMessageId,
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No stream");
    const decoder = new TextDecoder();
    let announced = false;
    let buffered = "";
    while (!announced) {
      const part = await reader.read();
      if (part.done) throw new Error("Stream ended before the thread was announced");
      buffered += decoder.decode(part.value);
      announced = eventsOf(buffered).some((entry) => entry.type === "thread");
    }
    const live = await app.request(`/api/chat/threads/${threadId}/live`, { headers: AUTH });
    expect(live.status).toBe(200);
    const liveReader = live.body?.getReader();
    if (!liveReader) throw new Error("No live stream");
    let liveText = "";
    let replayed: { thread?: ChatThread } | undefined;
    while (!replayed) {
      const part = await liveReader.read();
      if (part.done) throw new Error("Live stream ended before the thread replay");
      liveText += decoder.decode(part.value);
      replayed = eventsOf(liveText).find((entry) => entry.type === "thread");
    }
    expect(replayed?.thread?.messages).toHaveLength(1);
    expect(replayed?.thread?.messages[0]?.id).toBe(clientMessageId);
    await liveReader.cancel();
    while (!(await reader.read()).done) {}
  });
});
