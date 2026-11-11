import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SessionMessageStore } from "../session-messages.js";

type Session = {
  id: string;
  backend?: string;
  native?: string | null;
  status?: string;
  title?: string | null;
};

function fixture(sessions: Session[] = []) {
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
  for (const session of sessions) {
    db.query(
      "INSERT INTO gateway_sessions (id, backend, runtime_session_id, status, title) VALUES (?,?,?,?,?)",
    ).run(
      session.id,
      session.backend ?? "claude",
      session.native === undefined ? `native-${session.id}` : session.native,
      session.status ?? "idle",
      session.title ?? null,
    );
  }
  let time = 1_000_000;
  const store = new SessionMessageStore(db, () => time);
  return {
    db,
    store,
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

const human = { kind: "human" as const, label: "human relay (test)" };
const agent = (id: string) => ({
  kind: "session" as const,
  session_id: id,
  label: `session ${id}`,
});

test("resolves a native target id and delivers only at a claimed safe point", () => {
  const { db, store } = fixture([
    { id: "s1", backend: "claude", native: "native-1" },
    { id: "s2", backend: "codex", native: "native-2" },
  ]);
  try {
    const message = store.create({ session_id: "native-2", body: "hello" }, human);
    expect(message).toMatchObject({
      target_session_id: "s2",
      target_native_id: "native-2",
      target_backend: "codex",
      state: "queued",
      hop: 0,
    });
    expect(store.claim("claude", "native-1")).toEqual([]);
    const claimed = store.claim("codex", "native-2");
    expect(claimed.map((entry) => entry.id)).toEqual([message.id]);
    expect(store.get(message.id).state).toBe("delivering");
    store.deliver([message.id], "hook");
    expect(store.get(message.id)).toMatchObject({
      state: "delivered",
      delivered_via: "hook",
    });
    expect(store.claim("codex", "native-2")).toEqual([]);
  } finally {
    db.close();
  }
});

test("stops an agent ping-pong at the hop limit", () => {
  const { db, store } = fixture([
    { id: "s1", backend: "claude" },
    { id: "s2", backend: "codex" },
  ]);
  try {
    const relay = (target: string) => {
      const message = store.create({ session_id: target, body: `to ${target}` }, human);
      store.claim(message.target_backend, message.target_native_id as string);
      store.deliver([message.id], "hook");
      return message;
    };
    relay("s1");
    const first = store.create({ session_id: "s2", body: "one" }, agent("s1"));
    expect(first.hop).toBe(1);
    store.deliver(
      store.claim("codex", "native-s2").map((entry) => entry.id),
      "hook",
    );
    const second = store.create({ session_id: "s1", body: "two" }, agent("s2"));
    expect(second.hop).toBe(2);
    store.deliver(
      store.claim("claude", "native-s1").map((entry) => entry.id),
      "hook",
    );
    const third = store.create({ session_id: "s2", body: "three" }, agent("s1"));
    expect(third.hop).toBe(3);
    store.deliver(
      store.claim("codex", "native-s2").map((entry) => entry.id),
      "hook",
    );
    expect(() => store.create({ session_id: "s1", body: "four" }, agent("s2"))).toThrow(
      /hop limit/,
    );
  } finally {
    db.close();
  }
});

test("caps one sender and target per rolling hour", () => {
  const { db, store } = fixture([
    { id: "s1", backend: "claude" },
    { id: "s2", backend: "codex" },
  ]);
  try {
    for (let index = 0; index < 20; index++)
      store.create({ session_id: "s1", body: `message ${index}` }, agent("s2"));
    expect(() => store.create({ session_id: "s1", body: "late" }, agent("s2"))).toThrow(
      /Hourly message limit/,
    );
    expect(store.create({ session_id: "s1", body: "human" }, human).state).toBe("queued");
  } finally {
    db.close();
  }
});

test("returns the same row for a retried request id", () => {
  const { db, store } = fixture([
    { id: "s1", backend: "claude" },
    { id: "s2", backend: "claude" },
  ]);
  try {
    const first = store.create(
      { session_id: "s1", body: "only once", request_id: "retry-1" },
      agent("s2"),
    );
    expect(
      store.create({ session_id: "s1", body: "only once", request_id: "retry-1" }, agent("s2")).id,
    ).toBe(first.id);
    expect(() =>
      store.create({ session_id: "s2", body: "other", request_id: "retry-1" }, agent("s2")),
    ).toThrow(/different session/);
  } finally {
    db.close();
  }
});

test("rejects a live session without a context-capable hook but accepts a stopped one", () => {
  const { db, store } = fixture([
    { id: "cursor", backend: "cursor", status: "running" },
    { id: "ended", backend: "cursor", status: "stopped" },
  ]);
  try {
    expect(() => store.create({ session_id: "cursor", body: "hello" }, human)).toThrow(
      /cannot receive messages while running/,
    );
    expect(store.create({ session_id: "ended", body: "hello" }, human).target_session_id).toBe(
      "ended",
    );
  } finally {
    db.close();
  }
});

test("reorders and cancels queued messages while leaving delivered rows alone", () => {
  const { db, store } = fixture([{ id: "s1", backend: "claude" }]);
  try {
    const first = store.create({ session_id: "s1", body: "first" }, human);
    const second = store.create({ session_id: "s1", body: "second" }, human);
    expect(store.move(second.id, "up").position).toBe(0);
    expect(store.list("s1").map((entry) => entry.body)).toEqual(["second", "first"]);
    expect(store.cancel(first.id).state).toBe("cancelled");
    store.claim("claude", "native-s1");
    store.deliver([second.id], "hook");
    expect(() => store.cancel(second.id)).toThrow(/Only a queued message/);
    expect(() => store.move(second.id, "up")).toThrow(/Only a queued message/);
  } finally {
    db.close();
  }
});

test("marks rows abandoned by a previous process as interrupted and never retries them", () => {
  const { db, store } = fixture([{ id: "s1", backend: "claude" }]);
  try {
    const message = store.create({ session_id: "s1", body: "in flight" }, human);
    store.claim("claude", "native-s1");
    expect(store.interruptInFlight()).toBe(1);
    expect(store.get(message.id)).toMatchObject({
      state: "interrupted",
      delivery_error: "ORC restarted while delivering this message",
    });
    expect(store.claim("claude", "native-s1")).toEqual([]);
  } finally {
    db.close();
  }
});
