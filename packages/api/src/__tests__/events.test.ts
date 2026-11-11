import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { changes } from "@orc/core/changes";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { maintainNotifications } from "../notifications.js";
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
    expect(first.headers.get("cache-control")).toBe("no-cache, no-transform");
    if (!first.body || !second.body) throw new Error("Missing SSE response body");
    const readers = [first.body.getReader(), second.body.getReader()];
    const decode = (value: Uint8Array | undefined): string => new TextDecoder().decode(value);
    // The stream also watches real folders under the home directory (skills, agents, config),
    // which other test packages running in parallel may write to. Those changes are genuine
    // events, so each reader collects everything and the test asserts only on tasks.
    const received = readers.map(() => "");
    const pumps = readers.map(async (reader, i) => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        received[i] += decode(value);
      }
    });
    const tasksChanged = (text: string) => /event: change\ndata: .*"tasks"/.test(text);
    async function until(check: () => boolean, ms: number): Promise<boolean> {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10))
        if (check()) return true;
      return check();
    }
    try {
      expect(await until(() => received.every((t) => t.includes("event: ready")), 2000)).toBe(true);
      await Bun.sleep(150);
      expect(received.some(tasksChanged)).toBe(false);
      getSqlite()
        .query("INSERT INTO tasks(id,title) VALUES (?,?)")
        .run("event-task", "Updated elsewhere");
      expect(await until(() => received.every(tasksChanged), 2000)).toBe(true);
      for (const text of received) expect(text).not.toContain("Updated elsewhere");
    } finally {
      await Promise.all(readers.map((reader) => reader.cancel()));
      await Promise.all(pumps);
    }
  });

  test("should publish expired human requests from maintenance without a client read", async () => {
    // Created ten seconds ago with a five-second lifetime: still pending when written, already
    // expired for the sweep that uses the real clock.
    const clock = Date.now() - 10_000;
    const request = new HumanRequestStore(getSqlite(), () => clock).create({
      origin: { session_id: "expiry-session", backend: "codex", request_id: "expiry-question" },
      kind: "question",
      prompt: "Did this expire?",
      expires_in_seconds: 5,
    });
    // Let the create-time change reach subscribers before this test subscribes.
    await Bun.sleep(150);
    const response = await req(app, "GET", "/events");
    if (!response.body) throw new Error("Missing SSE response body");
    const reader = response.body.getReader();
    let received = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        received += new TextDecoder().decode(value);
      }
    })();
    const until = async (check: () => boolean, ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10))
        if (check()) return true;
      return check();
    };
    try {
      expect(await until(() => received.includes("event: ready"), 2000)).toBe(true);
      // The create-time event must not be mistaken for the expiry this test is about.
      await Bun.sleep(300);
      expect(received).not.toContain('"human-requests"');
      maintainNotifications();
      expect(await until(() => received.includes('"human-requests"'), 2000)).toBe(true);
      // Raw SQL: HumanRequestStore.get() also expires, so it cannot witness the sweep.
      expect(
        getSqlite()
          .query<{ status: string }, [string]>("SELECT status FROM human_requests WHERE id=?")
          .get(request.id)?.status,
      ).toBe("expired");
    } finally {
      await reader.cancel();
      await pump;
    }
  });

  test("should deliver terminal lifecycle notifications without terminal output sockets", async () => {
    const response = await req(app, "GET", "/events");
    if (!response.body) throw new Error("Missing SSE response body");
    const reader = response.body.getReader();
    try {
      await reader.read();
      changes.publish("terminals");
      // Changes in watched home folders may arrive first; read until the terminals event.
      let text = "";
      const end = Date.now() + 2000;
      while (!text.includes('"terminals"') && Date.now() < end)
        text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain('"terminals"');
    } finally {
      await reader.cancel();
    }
  });
});
