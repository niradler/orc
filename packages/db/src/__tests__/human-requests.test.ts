import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfig } from "@orc/core/config";
import { HumanRequestStore } from "../human-requests.js";

function fixture() {
  const db = new Database(":memory:");
  let time = 10000;
  return {
    db,
    store: new HumanRequestStore(db, () => time),
    now: () => time,
    advance: (milliseconds = 2000) => {
      time += milliseconds;
    },
  };
}
const question = {
  origin: { session_id: "session-a", backend: "codex", request_id: "question-a" },
  kind: "question",
  prompt: "Which color?",
  choices: ["Blue", "Green"],
};

test("should expire unavailable and undelivered requests after 72 hours while retaining their audit", () => {
  const { db, store, advance } = fixture();
  try {
    const request = store.create(question);
    store.respond(request.id, 1, { kind: "question", answer: "Blue" });
    store.unavailable(request.id, 2);
    advance(72 * 3600000 - 1);
    expect(store.list()).toHaveLength(1);
    advance(1);
    expect(store.list()).toEqual([]);
    expect(store.get(request.id).status).toBe("expired");
    expect(store.get(request.id).response).toEqual({ kind: "question", answer: "Blue" });
    expect(store.get(request.id).delivered_at).toBeNull();
    expect(() => store.respond(request.id, 3, { kind: "question", answer: "late" })).toThrow();
  } finally {
    db.close();
  }
});

test("should apply changed retention to existing requests without expiring fresh ones", () => {
  const { db, store, advance } = fixture();
  try {
    const request = store.create(question);
    store.respond(request.id, 1, { kind: "question", answer: "Blue" });
    advance(2 * 3600000);
    expect(store.list()).toHaveLength(1);
    loadConfig({ preferences: { attention_retention_hours: 1 } });
    const fresh = store.create({
      ...question,
      origin: { ...question.origin, request_id: "fresh" },
    });
    expect(store.list().map((entry) => entry.id)).toEqual([fresh.id]);
    expect(store.get(request.id).status).toBe("expired");
  } finally {
    resetConfig();
    db.close();
  }
});

test("should dismiss only obsolete requests from the continuing session and backend", () => {
  const { db, store } = fixture();
  try {
    const request = store.create({
      ...question,
      origin: { ...question.origin, tool_call_id: "tool" },
    });
    store.unavailable(request.id, 1);
    const other = store.create({
      ...question,
      origin: { ...question.origin, session_id: "other" },
    });
    const managed = store.create({
      ...question,
      origin: { ...question.origin, request_id: "managed", chat_thread_id: crypto.randomUUID() },
    });
    store.dismissObsolete("session-a", "claude");
    expect(store.get(request.id).status).toBe("unavailable");
    store.acknowledgeToolResults("session-a", "codex", "different");
    expect(store.get(request.id).status).toBe("unavailable");
    store.acknowledgeToolResults("session-a", "codex", "tool");
    expect(store.get(request.id).status).toBe("cancelled");
    expect(store.get(request.id).delivered_at).toBeNull();
    expect(store.get(other.id).status).toBe("pending");
    store.respond(other.id, 1, { kind: "question", answer: "Blue" });
    store.dismissObsolete("other", "codex");
    expect(store.list().map((entry) => entry.id)).toEqual([managed.id]);
    expect(store.get(other.id).status).toBe("cancelled");
    expect(store.get(other.id).response).toEqual({ kind: "question", answer: "Blue" });
    expect(store.get(other.id).delivered_at).toBeNull();
  } finally {
    db.close();
  }
});

test("should reopen pending and answered requests from a closed SQLite database", () => {
  const path = join(mkdtempSync(join(tmpdir(), "orc-human-reopen-")), "requests.db");
  let db = new Database(path);
  let store = new HumanRequestStore(db);
  const request = store.create(question);
  db.close();
  db = new Database(path);
  store = new HumanRequestStore(db);
  expect(store.get(request.id).status).toBe("pending");
  store.respond(request.id, 1, { kind: "question", answer: "Blue" });
  db.close();
  db = new Database(path);
  store = new HumanRequestStore(db);
  expect(store.get(request.id).response).toEqual({ kind: "question", answer: "Blue" });
  db.close();
});

test("should invalidate a dead runtime owner without expiring independent requests", () => {
  const { db, store, advance } = fixture();
  try {
    const owned = store.create(question, "runtime-a");
    const external = store.create({
      ...question,
      origin: { ...question.origin, request_id: "external" },
    });
    expect(() => store.heartbeat(owned.id, "runtime-b")).toThrow("owns");
    advance(29000);
    store.heartbeat(owned.id, "runtime-a");
    advance(29000);
    expect(store.get(owned.id).status).toBe("pending");
    advance(2000);
    expect(() => store.heartbeat(owned.id, "runtime-a")).toThrow("owns");
    expect(store.get(owned.id).status).toBe("unavailable");
    expect(store.get(external.id).status).toBe("pending");
    expect(() => store.respond(owned.id, 1, { kind: "question", answer: "late" })).toThrow("stale");
    expect(store.cancel(owned.id, 2).status).toBe("cancelled");
  } finally {
    db.close();
  }
});

test("should persist a response across store reconnection and distinguish delivery", () => {
  const { db, store, now } = fixture();
  try {
    const request = store.create(question);
    const answered = store.respond(request.id, request.version, {
      kind: "question",
      answer: "Custom color",
    });
    const reconnected = new HumanRequestStore(db, now);
    expect(reconnected.get(request.id).response).toEqual({
      kind: "question",
      answer: "Custom color",
    });
    expect(answered.status).toBe("answered");
    expect(reconnected.acknowledge(request.id, answered.version).status).toBe("delivered");
    expect(reconnected.list()).toEqual([]);
  } finally {
    db.close();
  }
});

test("should reject duplicate and stale replies, mismatched response kinds and changed origin content", () => {
  const { db, store } = fixture();
  try {
    const request = store.create(question);
    expect(store.create(question).id).toBe(request.id);
    expect(() => store.create({ ...question, prompt: "Changed command?" })).toThrow(
      "different content",
    );
    expect(() => store.respond(request.id, 2, { kind: "question", answer: "Blue" })).toThrow(
      "stale",
    );
    expect(() => store.respond(request.id, 1, { kind: "approval", approved: true })).toThrow(
      "kind",
    );
    store.respond(request.id, 1, { kind: "question", answer: "Blue" });
    expect(() => store.respond(request.id, 1, { kind: "question", answer: "Green" })).toThrow(
      "already answered",
    );
    store.acknowledge(request.id, 2);
    expect(() => store.acknowledge(request.id, 2)).toThrow("already delivered");
  } finally {
    db.close();
  }
});

test("should expire or cancel pending requests without granting approval", () => {
  const { db, store, advance } = fixture();
  try {
    const request = store.create({ ...question, expires_in_seconds: 1 });
    advance();
    expect(store.get(request.id).status).toBe("expired");
    expect(() => store.respond(request.id, 1, { kind: "question", answer: "Blue" })).toThrow(
      "stale",
    );
    const next = store.create({ ...question, origin: { ...question.origin, request_id: "next" } });
    expect(store.cancel(next.id, 1).status).toBe("cancelled");
    expect(() => store.respond(next.id, 1, { kind: "question", answer: "Blue" })).toThrow("stale");
  } finally {
    db.close();
  }
});

test("should require the exact proposed action for approval and retain denial", () => {
  const { db, store } = fixture();
  try {
    expect(() => store.create({ ...question, choices: [], kind: "approval" })).toThrow(
      "exact action",
    );
    const request = store.create({
      ...question,
      choices: [],
      kind: "approval",
      action: { tool: "Bash", input: { command: "pwd" }, cwd: "/tmp", host: "local" },
    });
    expect(store.respond(request.id, 1, { kind: "approval", approved: false }).response).toEqual({
      kind: "approval",
      approved: false,
    });
  } finally {
    db.close();
  }
});

test("should retain an undelivered answer when its originating runtime becomes unavailable", () => {
  const { db, store } = fixture();
  try {
    const request = store.create(question);
    const answered = store.respond(request.id, 1, { kind: "question", answer: "Blue" });
    const unavailable = store.unavailable(request.id, answered.version);
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.response).toEqual({ kind: "question", answer: "Blue" });
    expect(unavailable.delivered_at).toBeNull();
    expect(store.list().map((entry) => entry.id)).toEqual([request.id]);
    expect(() => store.acknowledge(request.id, answered.version)).toThrow("stale");
  } finally {
    db.close();
  }
});

test("should validate multi-select answers against the originating question choices", () => {
  const { db, store } = fixture();
  try {
    const request = store.create({ ...question, multi_select: true });
    expect(() =>
      store.respond(request.id, 1, {
        kind: "question",
        answer: "Green",
        selected_choices: ["Blue"],
      }),
    ).toThrow("choices");
    expect(() =>
      store.respond(request.id, 1, { kind: "question", answer: "Red", selected_choices: ["Red"] }),
    ).toThrow("choices");
    expect(
      store.respond(request.id, 1, {
        kind: "question",
        answer: "Blue, Green",
        selected_choices: ["Blue", "Green"],
      }).response,
    ).toEqual({ kind: "question", answer: "Blue, Green", selected_choices: ["Blue", "Green"] });
  } finally {
    db.close();
  }
});

test("should acknowledge only the matching native result or the stopped session's denials", () => {
  const { db, store } = fixture();
  try {
    const create = (id: string, sessionId: string, approved: boolean) => {
      const request = store.create({
        origin: { session_id: sessionId, backend: "claude", request_id: id, tool_call_id: id },
        kind: "approval",
        prompt: "Run?",
        action: { tool: "Bash", input: { command: "pwd" }, cwd: "/tmp", host: "local" },
      });
      return store.respond(request.id, 1, { kind: "approval", approved });
    };
    const denied = create("denied", "s", false);
    const approved = create("approved", "s", true);
    const other = create("other", "other-session", false);
    store.acknowledgeDeniedAtStop("s", "claude");
    expect(store.get(denied.id).status).toBe("delivered");
    expect(store.get(approved.id).status).toBe("answered");
    expect(store.get(other.id).status).toBe("answered");
    store.acknowledgeToolResults("s", "codex", "approved");
    expect(store.get(approved.id).status).toBe("answered");
    store.acknowledgeToolResults("s", "claude", "approved");
    expect(store.get(approved.id).status).toBe("delivered");
  } finally {
    db.close();
  }
});

test("should show fresh pending requests before a full inbox of unavailable requests", () => {
  const { db, store } = fixture();
  try {
    for (let index = 0; index < 100; index++) {
      const request = store.create({
        ...question,
        origin: { ...question.origin, request_id: `old-${index}` },
      });
      store.unavailable(request.id, 1);
    }
    const pending = store.create(question);
    expect(store.list()).toHaveLength(100);
    expect(store.list()[0]?.id).toBe(pending.id);
  } finally {
    db.close();
  }
});
