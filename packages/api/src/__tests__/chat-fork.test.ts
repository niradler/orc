import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentBackend,
  type AgentEvent,
  type AgentSession,
  createBackend,
  registerBackend,
  type SessionOpts,
  UNKNOWN_CAPABILITIES,
} from "@orc/agent-runtime";
import { ChatSettingsSchema, type ChatThread, ChatThreadSchema } from "@orc/core/chat";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import type { createApp } from "../server.js";
import { activeTurns, turnKey } from "../sessions/turns.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const forkCalls: { source: string; opts: SessionOpts }[] = [];
const sends: { id: string | null; prompt: string }[] = [];

const AUTH = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };

function session(id: string | null, resultId: string): AgentSession {
  return {
    id: "fork-fixture",
    capabilities: { ...UNKNOWN_CAPABILITIES, fork: true },
    getRuntimeSessionId: () => resultId,
    send: async (prompt) => {
      sends.push({ id, prompt });
    },
    respondPermission: () => {},
    alive: () => true,
    close: async () => {},
    async *events(): AsyncIterable<AgentEvent> {
      yield { type: "text", data: "Fork reply" };
      yield { type: "result", data: { runtimeSessionId: resultId } };
    },
  };
}

function nativeBackend(): AgentBackend {
  return {
    name: "codex-cli",
    capabilities: { ...UNKNOWN_CAPABILITIES, fork: true },
    preflight: async () => ({ ok: true }),
    startSession: async () => session(null, "native-started"),
    resumeSession: async (id) => session(id, "native-resumed"),
    forkSession: async (source, opts) => {
      forkCalls.push({ source, opts });
      return session(null, "native-forked");
    },
    stop: async () => {},
  };
}

function contextBackend(): AgentBackend {
  return {
    name: "codex-cli",
    capabilities: { ...UNKNOWN_CAPABILITIES, fork: false },
    preflight: async () => ({ ok: true }),
    startSession: async () => session(null, "context-started"),
    resumeSession: async (id) => session(id, "context-resumed"),
    stop: async () => {},
  };
}

function failingForkBackend(): AgentBackend {
  return {
    ...nativeBackend(),
    forkSession: async () => {
      throw new Error("native fixture failed");
    },
  };
}

// The chat route resolves the backend from the agent id, so both fixtures stand
// in for the same adapter and each test installs the one it needs.
function useBackend(kind: "native" | "context" | "failing"): void {
  registerBackend(
    "codex-cli",
    kind === "native" ? nativeBackend : kind === "context" ? contextBackend : failingForkBackend,
  );
}

// Test files share one module registry, so the real adapter must be restored or
// later files inherit this fixture.
const realCodexBackend = createBackend("codex-cli");
const oldMock = process.env.ORC_E2E_CHAT_MOCK;

beforeAll(() => {
  delete process.env.ORC_E2E_CHAT_MOCK;
  useBackend("native");
});
beforeEach(() => {
  // Another suite may leave the browser mock flag on; these tests exercise the
  // native fork path, which the mock deliberately skips.
  delete process.env.ORC_E2E_CHAT_MOCK;
  app = setupTestApp();
  useBackend("native");
  forkCalls.length = 0;
  sends.length = 0;
});
afterAll(() => {
  registerBackend("codex-cli", () => realCodexBackend);
  if (oldMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
  else process.env.ORC_E2E_CHAT_MOCK = oldMock;
  teardownTestApp();
});

function seedThread(overrides: Partial<ChatThread> = {}): ChatThread {
  const started = 1_700_000_000_000;
  const thread: ChatThread = {
    id: crypto.randomUUID(),
    title: "Refactor the chat panel",
    config: ChatSettingsSchema.parse({ agent: "codex", model: "fixture-model" }),
    cwd: "/workspace/orc",
    host: null,
    runtimeId: "source-native",
    backend: "codex-cli",
    capabilities: { ...UNKNOWN_CAPABILITIES, fork: true },
    sourceId: null,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Refactor the chat panel",
        timestamp: started,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "The panel now copies and forks per message.",
        timestamp: started + 42_000,
        agent: "codex",
        turn: {
          startedAt: started,
          finishedAt: started + 42_000,
          durationMs: 42_000,
          outcome: "completed",
        },
        activity: [
          {
            type: "tool",
            id: "tool-1",
            name: "shell",
            input: '{"command":"bun test"}',
            result: "green",
          },
        ],
      },
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "Now add tests",
        timestamp: started + 60_000,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Tests added.",
        timestamp: started + 70_000,
        turn: {
          startedAt: started + 60_000,
          finishedAt: started + 70_000,
          durationMs: 10_000,
          outcome: "completed",
        },
      },
    ],
    updatedAt: started + 70_000,
    ...overrides,
  };
  new ChatStore(getSqlite()).save(thread);
  return thread;
}

async function streamTurn(body: unknown): Promise<{ status: number; text: string }> {
  const response = await app.request("/api/chat/stream", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

describe("chat forks", () => {
  test("prefers a native backend fork and skips the context prompt", async () => {
    const source = seedThread();
    const target = source.messages[3];
    if (!target) throw new Error("Missing assistant message");
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: target.id,
    });
    expect(response.status).toBe(200);
    const forked = ChatThreadSchema.parse(await response.json());
    expect(forked.forkedFrom?.mode).toBe("native");
    expect(forked.forkPending?.sourceRuntimeId).toBe("source-native");
    expect(forked.forkContext).toBeUndefined();

    const turn = await streamTurn({
      threadId: forked.id,
      messages: [{ role: "user", content: "Continue after the native fork" }],
    });
    expect(turn.status).toBe(200);
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]?.source).toBe("source-native");
    expect(sends.at(-1)?.id).toBeNull();
    expect(sends.at(-1)?.prompt).not.toContain("[ORC fork]");
    expect(sends.at(-1)?.prompt).toContain("Continue after the native fork");

    const stored = ChatThreadSchema.parse(
      await (await req(app, "GET", `/chat/threads/${forked.id}`)).json(),
    );
    expect(stored.runtimeId).toBe("native-forked");
    expect(stored.forkPending).toBeUndefined();
    expect(stored.forkedFrom?.mode).toBe("native");
  });

  test("falls back to a tool-aware context replay when native fork is unavailable", async () => {
    useBackend("context");
    const source = seedThread({
      capabilities: { ...UNKNOWN_CAPABILITIES, fork: false },
    });
    const target = source.messages[1];
    if (!target) throw new Error("Missing assistant message");
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: target.id,
    });
    expect(response.status).toBe(200);
    const forked = ChatThreadSchema.parse(await response.json());
    expect(forked.forkedFrom?.mode).toBe("context");
    expect(forked.forkedFrom?.fallbackReason).toContain("does not support native");
    expect(forked.forkContext).toEqual({
      messageCount: 2,
      truncated: false,
      includesActivity: true,
    });
    expect(forked.forkPending).toBeUndefined();

    const turn = await streamTurn({
      threadId: forked.id,
      messages: [{ role: "user", content: "Continue after the context fork" }],
    });
    expect(turn.status).toBe(200);
    expect(forkCalls).toHaveLength(0);
    expect(sends.at(-1)?.id).toBeNull();
    expect(sends.at(-1)?.prompt).toContain("[ORC fork]");
    expect(sends.at(-1)?.prompt).not.toContain("[ORC account switch]");
    expect(sends.at(-1)?.prompt).toContain("User: Refactor the chat panel");
    expect(sends.at(-1)?.prompt).toContain("Tool: shell");
    expect(sends.at(-1)?.prompt).toContain("Result: green");
    expect(sends.at(-1)?.prompt).toContain("Continue after the context fork");
  });

  test("uses context replay for an earlier response and says why", async () => {
    const source = seedThread();
    const target = source.messages[1];
    if (!target) throw new Error("Missing assistant message");
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: target.id,
    });
    expect(response.status).toBe(200);
    const forked = ChatThreadSchema.parse(await response.json());
    expect(forked.forkedFrom?.mode).toBe("context");
    expect(forked.forkedFrom?.fallbackReason).toContain("latest response");
  });

  test("never starts a provider fork while the browser mock is active", async () => {
    process.env.ORC_E2E_CHAT_MOCK = "1";
    const source = seedThread();
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: source.messages[3]?.id,
    });
    expect(response.status).toBe(200);
    const forked = ChatThreadSchema.parse(await response.json());
    expect(forked.forkedFrom?.mode).toBe("context");
    expect(forked.forkPending).toBeUndefined();
    expect(forked.forkContext?.messageCount).toBe(4);
    expect(forkCalls).toHaveLength(0);
  });

  test("allows a native fork when older display history cannot be read", async () => {
    const source = seedThread({ historyBefore: 605 });
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: source.messages[3]?.id,
    });
    expect(response.status).toBe(200);
    const forked = ChatThreadSchema.parse(await response.json());
    expect(forked.forkedFrom?.mode).toBe("native");
    expect(forked.forkedFrom?.partial).toBe(true);
    expect(forked.forkPending?.sourceRuntimeId).toBe("source-native");
  });

  test("falls back to context when a native fork fails on the first turn", async () => {
    useBackend("failing");
    const source = seedThread();
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: source.messages[3]?.id,
    });
    const forked = ChatThreadSchema.parse(await response.json());
    expect(forked.forkedFrom?.mode).toBe("native");

    const turn = await streamTurn({
      threadId: forked.id,
      messages: [{ role: "user", content: "AFTER-FALLBACK" }],
    });
    expect(turn.status).toBe(200);
    const stored = ChatThreadSchema.parse(
      await (await req(app, "GET", `/chat/threads/${forked.id}`)).json(),
    );
    expect(stored.forkedFrom?.mode).toBe("context");
    expect(stored.forkedFrom?.fallbackReason).toContain("native fixture failed");
    expect(stored.forkPending).toBeUndefined();
    expect(stored.forkContext?.messageCount).toBe(4);
    const prompt = sends.at(-1)?.prompt ?? "";
    expect(prompt).toContain("[ORC fork]");
    // The new message is appended after the replay, never included twice.
    expect(prompt.match(/AFTER-FALLBACK/g)).toHaveLength(1);
    expect(stored.runtimeId).toBe("native-started");
  });

  test("rejects a lossy context fork when older native history is unavailable", async () => {
    useBackend("context");
    const source = seedThread({
      capabilities: { ...UNKNOWN_CAPABILITIES, fork: false },
      historyBefore: 605,
    });
    const target = source.messages[1];
    if (!target) throw new Error("Missing assistant message");
    const response = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: target.id,
    });
    expect(response.status).toBe(400);
  });

  test("rejects a user message, an unknown message and a running source", async () => {
    const source = seedThread();
    const user = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: source.messages[0]?.id,
    });
    expect(user.status).toBe(400);

    const missingMessage = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: crypto.randomUUID(),
    });
    expect(missingMessage.status).toBe(404);

    const key = turnKey(source.host, source.backend, source.runtimeId ?? "");
    activeTurns.add(key);
    try {
      const running = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
        messageId: source.messages[3]?.id,
      });
      expect(running.status).toBe(409);
    } finally {
      activeTurns.delete(key);
    }
  });

  test("keeps lineage to the immediate parent when forked again", async () => {
    const source = seedThread();
    const first = await req(app, "POST", `/chat/threads/${source.id}/fork`, {
      messageId: source.messages[3]?.id,
    });
    const once = ChatThreadSchema.parse(await first.json());
    const second = await req(app, "POST", `/chat/threads/${once.id}/fork`, {
      messageId: once.messages[1]?.id,
    });
    expect(second.status).toBe(200);
    const twice = ChatThreadSchema.parse(await second.json());
    expect(twice.title).toBe("Refactor the chat panel (fork)");
    expect(twice.forkedFrom?.threadId).toBe(once.id);
  });
});
