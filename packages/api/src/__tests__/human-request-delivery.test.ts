import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AgentBackend, AgentEvent, SessionOpts } from "@orc/agent-runtime";
import { ChatStore, installChat } from "@orc/db/chat";
import { HumanRequestStore } from "@orc/db/human-requests";
import {
  type DeliveryDeps,
  deliverIdleAnswers,
  deliveryMessage,
  type PushTarget,
} from "../human-request-delivery.js";
import { activeTurns } from "../sessions/turns.js";

const target: PushTarget = {
  sourceId: "live-1",
  agent: "codex",
  backend: "codex-cli",
  runtimeId: "native-1",
  host: null,
  cwd: "/work",
  model: null,
};

function fixture(options: { idle?: boolean; fail?: boolean } = {}) {
  const db = new Database(":memory:");
  installChat(db);
  let time = 100000;
  const store = new HumanRequestStore(db, () => time);
  const chats = new ChatStore(db);
  const sent: { prompt: string; opts: SessionOpts; statusAtSend: string[] }[] = [];
  const backend = {
    name: "fake",
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    startSession: async () => {
      throw new Error("not used");
    },
    resumeSession: async (runtimeSessionId: string, opts: SessionOpts) => ({
      id: runtimeSessionId,
      send: async (prompt: string) => {
        sent.push({ prompt, opts, statusAtSend: store.list().map((request) => request.status) });
      },
      respondPermission: () => {},
      alive: () => true,
      close: async () => {},
      async *events(): AsyncGenerator<AgentEvent> {
        if (options.fail) {
          yield { type: "error", data: "resume refused" };
          return;
        }
        yield { type: "text", data: "Thanks, continuing." };
        yield { type: "result", data: { runtimeSessionId } };
      },
    }),
  } satisfies AgentBackend;
  const deps: DeliveryDeps = {
    store,
    chats,
    target: async (request) => (request.input.origin.session_id === "live-1" ? target : null),
    idle: async () => options.idle ?? true,
    resumed: async () => {},
    backend: () => backend,
  };
  const answered = (requestId: string, sessionId = "live-1") => {
    const request = store.create({
      origin: { session_id: sessionId, backend: "codex", request_id: requestId },
      kind: "command",
      title: "IBKR check",
      prompt: "Run the positions check",
      command: { script: "python ibkr.py positions", cwd: "/work" },
    });
    const running = store.claimCommand(request.id, request.version);
    return store.completeCommand(request.id, running.version, {
      kind: "command",
      exit_code: 1,
      stdout: "",
      stderr: "token [REDACTED] expired",
      truncated: false,
    });
  };
  return {
    db,
    store,
    chats,
    deps,
    sent,
    answered,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("should push an unpolled answer into its idle session after acknowledging it", async () => {
  const { db, store, deps, sent, answered, advance } = fixture();
  try {
    const request = answered("a");
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(0);
    advance(15000);
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.statusAtSend).toEqual([]);
    expect(sent[0]?.opts).toMatchObject({ cwd: "/work", interactive: false, executionHost: null });
    expect(sent[0]?.prompt).toContain("python ibkr.py positions");
    expect(sent[0]?.prompt).toContain("Exit code: 1");
    expect(sent[0]?.prompt).toContain("token [REDACTED] expired");
    expect(store.get(request.id).status).toBe("delivered");
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("should leave answers alone while the agent polls, holds the session or is unknown", async () => {
  const busy = fixture({ idle: false });
  try {
    const request = busy.answered("a");
    const unknown = busy.answered("b", "elsewhere");
    busy.advance(20000);
    const polled = busy.answered("c");
    busy.advance(20000);
    busy.store.fetched(polled.id);
    busy.advance(5000);
    await deliverIdleAnswers(busy.deps);
    expect(busy.sent).toHaveLength(0);
    expect(busy.store.get(request.id).status).toBe("answered");
    expect(busy.store.get(unknown.id).status).toBe("answered");
    expect(busy.store.get(polled.id).status).toBe("answered");
    activeTurns.add("local:codex-cli:native-1");
    await deliverIdleAnswers({ ...busy.deps, idle: async () => true });
    expect(busy.sent).toHaveLength(0);
  } finally {
    activeTurns.clear();
    busy.db.close();
  }
});

test("should combine a session's answers into one turn and record it in chats showing it", async () => {
  const { db, chats, deps, sent, answered, advance } = fixture();
  try {
    chats.save({
      id: crypto.randomUUID(),
      title: "Live",
      config: { agent: "codex", model: "", system: "", mcp: "orc", autoApprove: false } as never,
      cwd: "/work",
      host: null,
      runtimeId: "native-1",
      backend: "codex-cli",
      sourceId: "live-1",
      messages: [],
      updatedAt: 1,
    });
    answered("a");
    answered("b");
    advance(15000);
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.prompt.match(/### IBKR check/g)).toHaveLength(2);
    const [thread] = chats.byRuntime("codex-cli", null, "native-1");
    expect(thread?.pushedAt).toBeGreaterThan(1);
    expect(thread?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(thread?.messages[1]?.content).toBe("Thanks, continuing.");
  } finally {
    db.close();
  }
});

test("should report an undeliverable answer instead of claiming delivery", async () => {
  const { db, store, deps, answered, advance } = fixture({ fail: true });
  try {
    const request = answered("a");
    advance(15000);
    await deliverIdleAnswers(deps);
    const failed = store.get(request.id);
    expect(failed.status).toBe("unavailable");
    expect(failed.delivery_error).toContain("resume refused");
    expect(failed.delivered_at).toBeNull();
    expect(failed.response).toMatchObject({ exit_code: 1 });
  } finally {
    db.close();
  }
});

test("should describe question and approval answers for the agent", () => {
  const base = {
    id: "r1",
    status: "answered" as const,
    delivery_error: null,
    version: 2,
    created_at: 0,
    expires_at: 1,
    responded_at: 0,
    delivered_at: null,
  };
  const input = {
    origin: { session_id: "s", backend: "codex", request_id: "q" },
    project_id: null,
    kind: "question" as const,
    prompt: "Which color?",
    choices: [],
    choice_descriptions: {},
    multi_select: false,
    notify: [],
    expires_in_seconds: 60,
  };
  const message = deliveryMessage([
    { ...base, input, response: { kind: "question", answer: "Blue" } },
    {
      ...base,
      id: "r2",
      input: { ...input, kind: "approval" },
      response: { kind: "approval", approved: false },
    },
  ]);
  expect(message).toContain("Answer: Blue");
  expect(message).toContain("Denied. Do not perform the action.");
});
