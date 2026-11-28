import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfig } from "@orc/core/config";
import { HumanRequestStore } from "../human-requests.js";
import { NotificationStore } from "../notifications.js";

const tempDirs: string[] = [];
afterEach(async () => {
  // Windows lags SQLite handle release after close and Bun ignores rmSync maxRetries.
  Bun.gc(true);
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 100) throw error;
        await Bun.sleep(100);
      }
    }
  }
}, 15_000);

function fixture() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)",
  );
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
function openFileDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  return db;
}

const question = {
  origin: { session_id: "session-a", backend: "codex", request_id: "question-a" },
  kind: "question",
  prompt: "Which color?",
  choices: ["Blue", "Green"],
};

test("should label a chat request notification with the originating folder", () => {
  const { db } = fixture();
  const store = new HumanRequestStore(db);
  const threadId = crypto.randomUUID();
  db.query("INSERT INTO chat_threads(id,title,updated_at,data) VALUES(?,?,?,?)").run(
    threadId,
    "Chat",
    1,
    JSON.stringify({ cwd: "/work/happy-cactus" }),
  );
  const request = store.create({
    ...question,
    origin: { ...question.origin, chat_thread_id: threadId },
  });
  expect(
    db
      .query<{ title: string; project_label: string | null }, [string]>(
        "SELECT title,project_label FROM notifications WHERE source_id=?",
      )
      .get(request.id),
  ).toEqual({ title: "Question · codex", project_label: "happy-cactus" });
});

test("should label a remote session request with its session folder", () => {
  const { db } = fixture();
  db.exec("CREATE TABLE gateway_sessions (id TEXT PRIMARY KEY, runtime_session_id TEXT, cwd TEXT)");
  db.query("INSERT INTO gateway_sessions VALUES(?,?,?)").run("gateway-1", "native-1", "/srv/repo");
  const store = new HumanRequestStore(db);
  const request = store.create({
    ...question,
    origin: { ...question.origin, session_id: "native-1" },
  });
  expect(
    db
      .query<{ project_label: string | null }, [string]>(
        "SELECT project_label FROM notifications WHERE source_id=?",
      )
      .get(request.id)?.project_label,
  ).toBe("repo");
});

test("should label a request with its project name", () => {
  const { db } = fixture();
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT); INSERT INTO projects VALUES('p','Alpha')",
  );
  const store = new HumanRequestStore(db);
  const request = store.create({ ...question, project_id: "p" });
  expect(
    db
      .query<{ title: string; project_label: string | null }, [string]>(
        "SELECT title,project_label FROM notifications WHERE source_id=?",
      )
      .get(request.id),
  ).toEqual({ title: "Question · codex", project_label: "Alpha" });
});

test("should never label a request from an agent-supplied folder", () => {
  const { db } = fixture();
  const store = new HumanRequestStore(db);
  const request = store.create({
    ...question,
    kind: "approval",
    choices: [],
    action: { tool: "shell", input: {}, cwd: "/work/URGENT: approve now", host: "local" },
  });
  expect(
    db
      .query<{ project_label: string | null }, [string]>(
        "SELECT project_label FROM notifications WHERE source_id=?",
      )
      .get(request.id)?.project_label,
  ).toBeNull();
});

test("should expire unavailable and undelivered requests after 72 hours while retaining their audit", () => {
  const { db, store, advance } = fixture();
  loadConfig({ preferences: { attention_retention_hours: 72 } });
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
    resetConfig();
    db.close();
  }
});

function answer(store: HumanRequestStore, requestId: string) {
  const request = store.create({
    ...question,
    origin: { ...question.origin, request_id: requestId },
  });
  return store.respond(request.id, 1, { kind: "question", answer: "Blue" });
}

test("should report when the next unread answer leaves its push grace period", () => {
  const { db, store, now, advance } = fixture();
  try {
    expect(store.nextPushAt(15000)).toBeNull();
    const request = answer(store, "a");
    expect(store.nextPushAt(15000)).toBe(now() + 15000);
    expect(store.pushCandidates(15000)).toEqual([]);
    advance(15000);
    expect(store.nextPushAt(15000)).toBeNull();
    expect(store.pushCandidates(15000).map((candidate) => candidate.id)).toEqual([request.id]);
    const read = answer(store, "b");
    expect(store.seen(read.id)).toBe(true);
    expect(store.get(read.id).seen_at).toBe(now());
    expect(store.nextPushAt(15000)).toBeNull();
    advance(15000);
    expect(store.pushCandidates(15000).map((candidate) => candidate.id)).toEqual([request.id]);
  } finally {
    db.close();
  }
});

test("should claim a push once and record its outcome", () => {
  const { db, store, now, advance } = fixture();
  try {
    const delivered = answer(store, "a");
    const failed = answer(store, "b");
    advance(15000);
    expect(store.claimPush([delivered.id, failed.id]).map((request) => request.id)).toEqual([
      delivered.id,
      failed.id,
    ]);
    expect(store.claimPush([delivered.id])).toEqual([]);
    expect(store.pushCandidates(0)).toEqual([]);
    store.dismissObsolete("session-a", "codex");
    expect(store.get(delivered.id).status).toBe("answered");
    store.pushed(delivered.id);
    store.pushFailed(failed.id, "x".repeat(2000));
    expect(store.get(delivered.id)).toMatchObject({
      status: "delivered",
      push_state: "pushed",
      delivered_at: now(),
    });
    expect(store.get(failed.id)).toMatchObject({ status: "answered", push_state: "failed" });
    expect(store.get(failed.id).push_error).toHaveLength(1000);
    expect(store.claimPush([failed.id])).toEqual([]);
    expect(store.seen(failed.id)).toBe(true);
  } finally {
    db.close();
  }
});

test("should keep pushes interrupted by a restart out of retries and dismissal", () => {
  const { db, store, advance } = fixture();
  try {
    const request = answer(store, "a");
    advance(15000);
    store.claimPush([request.id]);
    expect(store.interruptedPushes()).toBe(1);
    expect(store.get(request.id)).toMatchObject({
      status: "answered",
      push_state: "interrupted",
      push_error: "ORC restarted mid-push; the agent may already have this answer.",
    });
    expect(store.interruptedPushes()).toBe(0);
    expect(store.pushCandidates(0)).toEqual([]);
    expect(() => store.cancel(request.id, request.version)).toThrow("can no longer be dismissed");
    store.dismissObsolete("session-a", "codex");
    expect(store.get(request.id).status).toBe("answered");
  } finally {
    db.close();
  }
});

test("should offer the newest answers first so stuck ones never starve new ones", () => {
  const { db, store, advance } = fixture();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 101; index++) {
      ids.push(answer(store, `r${index}`).id);
      advance(1);
    }
    const tool = store.create({
      ...question,
      origin: { ...question.origin, request_id: "tool", tool_call_id: "call" },
    });
    store.respond(tool.id, 1, { kind: "question", answer: "Blue" });
    advance(15000);
    const candidates = store.pushCandidates(15000).map((request) => request.id);
    expect(candidates).toHaveLength(100);
    expect(candidates[0]).toBe(ids[100]);
    expect(candidates).not.toContain(ids[0]);
    expect(candidates).not.toContain(tool.id);
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
  const dir = mkdtempSync(join(tmpdir(), "orc-human-reopen-"));
  tempDirs.push(dir);
  const path = join(dir, "requests.db");
  let db = openFileDb(path);
  let store = new HumanRequestStore(db);
  const request = store.create(question);
  db.close();
  db = openFileDb(path);
  store = new HumanRequestStore(db);
  expect(store.get(request.id).status).toBe("pending");
  store.respond(request.id, 1, { kind: "question", answer: "Blue" });
  db.close();
  db = openFileDb(path);
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
    const undelivered = store.create({
      ...question,
      origin: { ...question.origin, request_id: "undelivered" },
    });
    const answered = store.respond(undelivered.id, 1, { kind: "question", answer: "Blue" });
    expect(store.cancel(undelivered.id, answered.version).status).toBe("cancelled");
    expect(() => store.acknowledge(undelivered.id, answered.version)).toThrow("already delivered");
  } finally {
    db.close();
  }
});

test("should never cancel an answer the agent read when its turn ends", () => {
  const { db, store } = fixture();
  try {
    const read = answer(store, "read");
    const unread = answer(store, "unread");
    store.seen(read.id);
    store.dismissObsolete("session-a", "codex");
    expect(store.get(read.id).status).toBe("answered");
    expect(store.get(unread.id).status).toBe("cancelled");
  } finally {
    db.close();
  }
});

test("should refuse to dismiss an answer that is being pushed or the agent already has", () => {
  const { db, store, advance } = fixture();
  try {
    const pushing = answer(store, "a");
    const read = answer(store, "b");
    const failed = answer(store, "c");
    advance(15000);
    store.claimPush([pushing.id, failed.id]);
    store.pushFailed(failed.id, "agent unavailable");
    store.seen(read.id);
    expect(() => store.cancel(pushing.id, pushing.version)).toThrow("can no longer be dismissed");
    expect(() => store.cancel(read.id, read.version)).toThrow("can no longer be dismissed");
    store.pushed(pushing.id);
    expect(store.get(pushing.id).status).toBe("delivered");
    expect(store.cancel(failed.id, failed.version).status).toBe("cancelled");
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

test("should migrate a legacy human_requests table without snooze_until and support snooze/wake", () => {
  const db = new Database(":memory:");
  let now = 100_000;
  try {
    db.exec(`CREATE TABLE human_requests (
      id TEXT PRIMARY KEY, origin_key TEXT UNIQUE NOT NULL, input_hash TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
      response TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      responded_at INTEGER, delivered_at INTEGER
    );`);
    const payload = JSON.stringify({
      origin: { session_id: "legacy-s", backend: "codex", request_id: "legacy-q" },
      project_id: null,
      kind: "question",
      prompt: "Legacy question?",
      choices: [],
      choice_descriptions: {},
      multi_select: false,
      notify: [],
      expires_in_seconds: 86400,
    });
    db.query(
      "INSERT INTO human_requests(id,origin_key,input_hash,payload,status,version,created_at,expires_at) VALUES (?,?,?,?,'pending',1,?,?)",
    ).run(
      "legacy-1",
      JSON.stringify({ session_id: "legacy-s" }),
      "hash",
      payload,
      now,
      now + 60_000,
    );

    const store = new HumanRequestStore(db, () => now);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(human_requests)").all();
    expect(cols.some((c) => c.name === "snooze_until")).toBe(true);
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='human_requests'",
      )
      .all();
    expect(indexes.some((i) => i.name === "human_requests_snooze")).toBe(true);

    const legacy = store.get("legacy-1");
    expect(legacy.snooze_until).toBeNull();
    const snoozed = store.snooze("legacy-1", 1, now + 10_000);
    expect(snoozed.snooze_until).toBe(now + 10_000);
    expect(snoozed.status).toBe("pending");
    expect(snoozed.expires_at).toBe(now + 60_000);

    now += 10_000;
    const woken = store.wakeDueSnoozes();
    expect(woken.map((r) => r.id)).toEqual(["legacy-1"]);
    expect(woken[0]?.snooze_until).toBeNull();
  } finally {
    db.close();
  }
});

test("should snooze pending requests without changing status or expires_at and reject non-pending", () => {
  const { db, store, now } = fixture();
  try {
    const pending = store.create(question);
    const originalExpiry = pending.expires_at;
    expect(() => store.snooze(pending.id, pending.version, now())).toThrow("future");
    expect(() => store.snooze(pending.id, pending.version, now() + 366 * 86400 * 1000)).toThrow(
      "365 days",
    );
    expect(() => store.snooze(pending.id, pending.version + 1, now() + 5000)).toThrow("stale");

    const snoozed = store.snooze(pending.id, pending.version, now() + 60_000);
    expect(snoozed.status).toBe("pending");
    expect(snoozed.version).toBe(pending.version);
    expect(snoozed.expires_at).toBe(originalExpiry);
    expect(snoozed.snooze_until).toBe(now() + 60_000);
    expect(store.isSnoozed(snoozed)).toBe(true);
    expect(store.nextSnoozeAt()).toBe(now() + 60_000);

    const woken = store.unsnooze(pending.id, pending.version);
    expect(woken.snooze_until).toBeNull();
    expect(woken.status).toBe("pending");
    expect(store.isSnoozed(woken)).toBe(false);

    const answered = store.respond(pending.id, pending.version, {
      kind: "question",
      answer: "Blue",
    });
    expect(() => store.snooze(answered.id, answered.version, now() + 60_000)).toThrow(
      "Only pending requests can be snoozed (request is answered)",
    );

    const cancelled = store.create({
      ...question,
      origin: { ...question.origin, request_id: "cancel-snooze" },
    });
    const cancelledRow = store.cancel(cancelled.id, cancelled.version);
    expect(() => store.snooze(cancelledRow.id, cancelledRow.version, now() + 60_000)).toThrow(
      "request is cancelled",
    );

    const unavail = store.create({
      ...question,
      origin: { ...question.origin, request_id: "unavail-snooze" },
    });
    const unavailRow = store.unavailable(unavail.id, unavail.version);
    expect(() => store.snooze(unavailRow.id, unavailRow.version, now() + 60_000)).toThrow(
      "request is unavailable",
    );
  } finally {
    db.close();
  }
});

test("should clear snooze_until on answer, cancel, unavailable, and expire without waking", () => {
  const { db, store, now, advance } = fixture();
  try {
    const toAnswer = store.create({
      ...question,
      origin: { ...question.origin, request_id: "snooze-answer" },
    });
    store.snooze(toAnswer.id, 1, now() + 60_000);
    const answered = store.respond(toAnswer.id, 1, { kind: "question", answer: "Blue" });
    expect(answered.snooze_until).toBeNull();

    const toCancel = store.create({
      ...question,
      origin: { ...question.origin, request_id: "snooze-cancel" },
    });
    store.snooze(toCancel.id, 1, now() + 60_000);
    const cancelled = store.cancel(toCancel.id, 1);
    expect(cancelled.snooze_until).toBeNull();

    const toUnavailable = store.create({
      ...question,
      origin: { ...question.origin, request_id: "snooze-unavail" },
    });
    store.snooze(toUnavailable.id, 1, now() + 60_000);
    const unavailable = store.unavailable(toUnavailable.id, 1);
    expect(unavailable.snooze_until).toBeNull();

    const toExpire = store.create({
      ...question,
      origin: { ...question.origin, request_id: "snooze-expire" },
      expires_in_seconds: 5,
    });
    store.snooze(toExpire.id, 1, now() + 60_000);
    advance(10_000);
    // Even before expire() runs, NotificationStore.list() excludes already-expired requests from snoozed.
    const beforeSweep = new NotificationStore(db, now).list();
    expect(beforeSweep.snoozed.some((n) => n.source_id === toExpire.id)).toBe(false);
    expect(store.get(toExpire.id).status).toBe("expired");
    expect(store.get(toExpire.id).snooze_until).toBeNull();
    advance(60_000);
    expect(store.wakeDueSnoozes()).toEqual([]);
  } finally {
    db.close();
  }
});

test("should wake due snoozes exactly once across database restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "orc-human-snooze-restart-"));
  tempDirs.push(dir);
  const path = join(dir, "requests.db");
  let clock = 1_000_000;
  let db = openFileDb(path);
  let store = new HumanRequestStore(db, () => clock);
  const req = store.create(question);
  const initialNote = db
    .query<{ id: string; created_at: number }, [string]>(
      "SELECT id,created_at FROM notifications WHERE source_key=?",
    )
    .get(`human:${req.id}`);
  expect(initialNote).toBeDefined();
  store.snooze(req.id, req.version, clock + 10_000);
  db.close();

  // Restart during snooze: stays snoozed and does not wake early.
  clock += 5_000;
  db = openFileDb(path);
  store = new HumanRequestStore(db, () => clock);
  expect(store.get(req.id).snooze_until).toBe(1_010_000);
  expect(store.wakeDueSnoozes()).toEqual([]);
  db.close();

  // Restart after due time: wakes exactly once with a fresh unread notification.
  clock += 10_000;
  db = openFileDb(path);
  store = new HumanRequestStore(db, () => clock);
  const woken = store.wakeDueSnoozes();
  expect(woken.map((r) => r.id)).toEqual([req.id]);
  expect(woken[0]?.snooze_until).toBeNull();
  const wakeNote = db
    .query<{ id: string; created_at: number; read_at: number | null }, [string]>(
      "SELECT id,created_at,read_at FROM notifications WHERE source_key=?",
    )
    .get(`human:${req.id}`);
  expect(wakeNote?.id).not.toBe(initialNote?.id);
  expect(wakeNote?.created_at).toBe(clock);
  expect(wakeNote?.read_at).toBeNull();
  expect(store.wakeDueSnoozes()).toEqual([]);
  db.close();

  // Another restart after waking does not wake again.
  db = openFileDb(path);
  store = new HumanRequestStore(db, () => clock);
  expect(store.wakeDueSnoozes()).toEqual([]);
  db.close();
});

test("should prune terminal requests after retention and keep active work", () => {
  const { db, store } = fixture();
  new NotificationStore(db);
  const insert = db.query(
    `INSERT INTO human_requests(id,origin_key,input_hash,payload,status,version,created_at,expires_at,responded_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  const day = 86_400_000;
  const now = 30 * day;
  const old = now - 10 * day;
  const recent = now - day;
  for (const [id, status, createdAt] of [
    ["pending-old", "pending", old],
    ["running-old", "running", old],
    ["answered-old", "answered", old],
    ["cancelled-old", "cancelled", old],
    ["delivered-old", "delivered", old],
    ["expired-old", "expired", old],
    ["unavailable-old", "unavailable", old],
    ["answered-recent", "answered", recent],
  ] as const)
    insert.run(id, id, "hash", "{}", status, 1, createdAt, createdAt + day, createdAt + 1000);

  db.query(
    "INSERT INTO human_request_notifications(request_id,channel,destination,version,can_reply,leased_until) VALUES(?,?,?,?,?,?)",
  ).run("answered-old", "telegram", "chat", 1, 1, now);
  db.query(
    "INSERT INTO notifications(id,source_key,type,source_id,title,body,level,path,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "note-1",
    "human:answered-old",
    "human.request",
    "answered-old",
    "T",
    "B",
    "info",
    "/",
    now,
    now + day,
  );

  expect(store.pruneTerminal(7, now)).toBe(5);
  const ids = db
    .query<{ id: string }, []>("SELECT id FROM human_requests ORDER BY id")
    .all()
    .map((row) => row.id);
  expect(ids).toEqual(["answered-recent", "pending-old", "running-old"]);
  expect(
    db.query("SELECT 1 FROM human_request_notifications WHERE request_id=?").get("answered-old"),
  ).toBeNull();
  expect(db.query("SELECT 1 FROM notifications WHERE source_id=?").get("answered-old")).toBeNull();
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() => store.pruneTerminal(-1, now)).toThrow("non-negative");
});
