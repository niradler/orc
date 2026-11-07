import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { AuditLog } from "../audit.js";
import { HumanRequestStore } from "../human-requests.js";

function fixture() {
  const db = new Database(":memory:");
  let now = Date.now();
  const store = new HumanRequestStore(db, () => now);
  const audit = new AuditLog(db, { now: () => now });
  return {
    db,
    store,
    advance: (ms: number) => {
      now += ms;
    },
    events: () => audit.list({ entityType: "human_request", limit: 100 }),
  };
}

function input(id: string) {
  return {
    kind: "question",
    prompt: "PRIVATE_PROMPT",
    origin: { session_id: "audit-session", backend: "test", request_id: id },
  };
}

test("should audit human request creation and real transitions without polling or response content", () => {
  const { db, store, events } = fixture();
  try {
    const request = store.create(input("answered"));
    store.create(input("answered"));
    store.get(request.id);
    store.list();
    expect(events().map((event) => event.action)).toEqual(["human_request.created"]);
    store.respond(request.id, 1, { kind: "question", answer: "PRIVATE_ANSWER" });
    expect(() => store.respond(request.id, 1, { kind: "question", answer: "duplicate" })).toThrow();
    store.claimPush([request.id]);
    store.pushed(request.id);
    store.pushed(request.id);
    expect(
      events()
        .map((event) => event.action)
        .sort(),
    ).toEqual(["human_request.answered", "human_request.created", "human_request.delivered"]);
    expect(JSON.stringify(events())).not.toContain("PRIVATE_");
    expect(
      events().every((event) => event.actor === null && event.session_id === "audit-session"),
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("should audit bulk cancellation and expiry once per changed request", () => {
  const { db, store, advance, events } = fixture();
  try {
    const cancelled = store.create(input("cancelled"));
    const answered = store.create(input("answered"));
    store.respond(answered.id, 1, { kind: "question", answer: "PRIVATE_ANSWER" });
    store.dismissObsolete("audit-session", "test");
    store.dismissObsolete("audit-session", "test");
    expect(
      events()
        .filter((event) => event.action === "human_request.cancelled")
        .flatMap((event) => event.subject_ids)
        .sort(),
    ).toEqual([cancelled.id, answered.id].sort());
    const expiring = store.create({ ...input("expiring"), expires_in_seconds: 1 });
    advance(1001);
    store.list();
    store.get(expiring.id);
    expect(events().filter((event) => event.action === "human_request.expired")).toHaveLength(1);
    const disconnected = store.create(input("disconnected"), "runtime");
    store.heartbeat(disconnected.id, "runtime");
    advance(30001);
    store.list();
    store.list();
    expect(events().filter((event) => event.action === "human_request.unavailable")).toHaveLength(
      1,
    );
  } finally {
    db.close();
  }
});

test("should audit command execution, delivery and direct cancellation without recording command results", () => {
  const { db, store, events } = fixture();
  try {
    const command = store.create({
      ...input("command"),
      kind: "command",
      command: { script: "PRIVATE_SCRIPT", cwd: process.cwd() },
    });
    const running = store.claimCommand(command.id, 1);
    const answered = store.completeCommand(command.id, running.version, {
      kind: "command",
      exit_code: 0,
      stdout: "PRIVATE_STDOUT",
      stderr: "PRIVATE_STDERR",
      truncated: false,
    });
    store.acknowledge(answered.id, answered.version);
    const cancelled = store.create(input("cancel"));
    store.cancel(cancelled.id, cancelled.version);
    const unavailable = store.create(input("unavailable"));
    store.unavailable(unavailable.id, unavailable.version);
    expect(
      events()
        .map((event) => event.action)
        .sort(),
    ).toEqual([
      "human_request.answered",
      "human_request.cancelled",
      "human_request.created",
      "human_request.created",
      "human_request.created",
      "human_request.delivered",
      "human_request.running",
      "human_request.unavailable",
    ]);
    expect(JSON.stringify(events())).not.toContain("PRIVATE_");
  } finally {
    db.close();
  }
});

test("should roll back a human request transition when its audit cannot be written", () => {
  const { db, store, events } = fixture();
  try {
    const request = store.create(input("atomic"));
    const record = spyOn(AuditLog.prototype, "record").mockImplementation(() => {
      throw new Error("audit unavailable");
    });
    try {
      expect(() =>
        store.respond(request.id, request.version, { kind: "question", answer: "PRIVATE_ANSWER" }),
      ).toThrow("audit unavailable");
    } finally {
      record.mockRestore();
    }
    expect(store.get(request.id)).toMatchObject({ status: "pending", version: 1, response: null });
    expect(events()).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("should audit interrupted commands and retention expiry without repeated polling events", () => {
  const { db, store, advance, events } = fixture();
  try {
    const command = store.create({
      ...input("interrupted"),
      kind: "command",
      command: { script: "PRIVATE_SCRIPT", cwd: process.cwd() },
    });
    store.claimCommand(command.id, 1);
    advance(330001);
    store.list();
    store.list();
    expect(events().filter((event) => event.action === "human_request.unavailable")).toHaveLength(
      1,
    );
    advance(72 * 3600000);
    store.list();
    store.list();
    expect(events().filter((event) => event.action === "human_request.expired")).toHaveLength(1);
  } finally {
    db.close();
  }
});
