import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeResource, changes } from "@orc/core/changes";
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
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index} ${"x".repeat(600)}`,
      timestamp: index,
    }));
    const prompt = continuationPrompt(messages);
    if (!prompt) throw new Error("Continuation prompt was not built");
    expect(prompt).toContain("[ORC account switch]");
    expect(prompt).toContain("--- End of prior conversation ---");
    expect(prompt).toContain("message 39");
    expect(prompt).not.toContain("message 0 ");
    expect(prompt.length).toBeLessThan(14_000);
    expect(continuationPrompt([])).toBeUndefined();
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
