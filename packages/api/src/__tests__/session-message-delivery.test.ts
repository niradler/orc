import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AgentBackend } from "@orc/agent-runtime";
import { SessionMessageStore } from "@orc/db/session-messages";
import type { PushTarget } from "../human-request-delivery.js";
import { deliverIdleSessionMessages } from "../session-message-delivery.js";

const target: PushTarget = {
  sourceId: "session-a",
  agent: "claude",
  backend: "claude",
  runtimeId: "native-a",
  host: null,
  cwd: process.cwd(),
  model: null,
  fingerprint: "stopped",
};

function fixture(sessionBackend = "claude", runtimeBackend = sessionBackend) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE gateway_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    backend TEXT NOT NULL,
    runtime_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    title TEXT,
    last_activity_at INTEGER
  )`);
  db.query(
    "INSERT INTO gateway_sessions (id, backend, runtime_session_id, status) VALUES ('session-a',?,'native-a','stopped')",
  ).run(sessionBackend);
  const store = new SessionMessageStore(db);
  const prompts: string[] = [];
  const resumed: string[] = [];
  const deps = {
    store,
    target: async () => ({ ...target, agent: sessionBackend, backend: runtimeBackend }),
    idle: async () => true,
    resumed: async (entry: PushTarget) => {
      resumed.push(entry.sourceId);
    },
    backend: () => ({}) as AgentBackend,
    chatTurn: (_target: PushTarget, prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve();
    },
  };
  return { db, store, deps, prompts, resumed };
}

const human = { kind: "human" as const, label: "human relay (test)" };

test("delivers queued messages to an exited session through a chat turn", async () => {
  const { db, store, deps, prompts } = fixture();
  try {
    const message = store.create({ session_id: "session-a", body: "Resume the review" }, human);
    await deliverIdleSessionMessages(deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Resume the review");
    expect(prompts[0]).toContain("Delivery is not approval");
    expect(store.get(message.id)).toMatchObject({
      state: "delivered",
      delivered_via: "chat",
    });
  } finally {
    db.close();
  }
});

test("delivers to a stopped session whose chat runtime name differs from its backend", async () => {
  const { db, store, deps, prompts } = fixture("gemini", "acpx");
  try {
    const message = store.create({ session_id: "session-a", body: "Resume Gemini" }, human);
    await deliverIdleSessionMessages(deps);
    expect(prompts[0]).toContain("Resume Gemini");
    expect(store.get(message.id).state).toBe("delivered");
  } finally {
    db.close();
  }
});

test("keeps a queued message when the target is still live", async () => {
  const { db, store, deps, prompts } = fixture();
  try {
    const message = store.create({ session_id: "session-a", body: "Stay queued" }, human);
    await deliverIdleSessionMessages({ ...deps, target: async () => null });
    expect(prompts).toEqual([]);
    expect(store.get(message.id).state).toBe("queued");
  } finally {
    db.close();
  }
});

test("marks a message failed when the turn cannot be delivered", async () => {
  const { db, store, deps } = fixture();
  try {
    const message = store.create({ session_id: "session-a", body: "Will fail" }, human);
    await deliverIdleSessionMessages({
      ...deps,
      chatTurn: () => Promise.reject(new Error("backend unavailable")),
    });
    expect(store.get(message.id)).toMatchObject({
      state: "failed",
      delivery_error: "backend unavailable",
    });
  } finally {
    db.close();
  }
});
