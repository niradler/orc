import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { changes } from "@orc/core/changes";
import { getSqlite } from "@orc/db/client";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

describe("shared resource event stream", () => {
  let app: ReturnType<typeof setupTestApp>;
  beforeAll(() => {
    app = setupTestApp();
  });
  afterAll(() => teardownTestApp());

  test("should require the same authentication as resource endpoints", async () => {
    const response = await app.request("/api/events");
    expect(response.status).toBe(401);
  });

  test("should initialize, stay idle, and notify two clients of committed changes", async () => {
    const first = await req(app, "GET", "/events");
    const second = await req(app, "GET", "/events");
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    expect(first.headers.get("x-accel-buffering")).toBe("no");
    if (!first.body || !second.body) throw new Error("Missing SSE response body");
    const readers = [first.body.getReader(), second.body.getReader()];
    const decode = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);
    try {
      for (const reader of readers)
        expect(decode((await reader.read()).value)).toContain("event: ready");
      const waiting = readers.map((reader) => reader.read());
      const initialWait = waiting[0];
      if (!initialWait) throw new Error("Missing stream reader");
      expect(
        await Promise.race([initialWait.then(() => "event"), Bun.sleep(150).then(() => "idle")]),
      ).toBe("idle");
      getSqlite()
        .query("INSERT INTO tasks(id,title) VALUES (?,?)")
        .run("event-task", "Updated elsewhere");
      const updates = await Promise.race([
        Promise.all(waiting),
        Bun.sleep(2000).then(() => {
          throw new Error("No change notification");
        }),
      ]);
      for (const update of updates) {
        const text = decode(update.value);
        expect(text).toContain("event: change");
        expect(text).toContain('"tasks"');
        expect(text).not.toContain("Updated elsewhere");
      }
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
    }
  });

  test("should deliver terminal lifecycle notifications without terminal output sockets", async () => {
    const response = await req(app, "GET", "/events");
    if (!response.body) throw new Error("Missing SSE response body");
    const reader = response.body.getReader();
    try {
      await reader.read();
      changes.publish("terminals");
      const next = await reader.read();
      expect(new TextDecoder().decode(next.value)).toContain('"terminals"');
    } finally {
      await reader.cancel();
    }
  });
});
