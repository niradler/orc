import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  consumeResourceEvents,
  EventFrames,
  invalidateResources,
  parseResources,
} from "../../src/lib/resource-events";

describe("resource events", () => {
  test("open history refreshes activity dates and active icons when session work changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    let state = { running: true, updatedAt: 10 };
    const threads = new QueryObserver(client, {
      queryKey: ["chat-threads", true],
      queryFn: async () => ({ ...state }),
    });
    const native = new QueryObserver(client, {
      queryKey: ["chat-resume-sessions", true],
      queryFn: async () => ({ ...state }),
    });
    const cleanup = [threads.subscribe(() => {}), native.subscribe(() => {})];
    try {
      await Promise.all([threads.refetch(), native.refetch()]);
      state = { running: false, updatedAt: 20 };
      await invalidateResources(client, ["human-requests"]);
      expect(threads.getCurrentResult().data).toEqual(state);
      expect(native.getCurrentResult().data).toEqual(state);
      state = { running: true, updatedAt: 30 };
      await invalidateResources(client, ["sessions"]);
      expect(threads.getCurrentResult().data).toEqual(state);
      expect(native.getCurrentResult().data).toEqual(state);
    } finally {
      for (const unsubscribe of cleanup) unsubscribe();
      client.clear();
    }
  });
  test("should keep health idle for unrelated resource changes and refresh explicit health changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["health"],
      queryFn: async () => {
        reads++;
        return { status: "ok", version: "test" };
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      const baseline = reads;
      await invalidateResources(client, ["tasks", "sessions", "jobs", "projects", "memories"]);
      expect(reads).toBe(baseline);
      await invalidateResources(client, ["health"]);
      expect(reads).toBe(baseline + 1);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
  test("should refresh read counters without re-reading skill content", async () => {
    const client = new QueryClient();
    client.setQueryData(["skills"], []);
    client.setQueryData(["skill", "example"], { content: "Instructions" });
    await invalidateResources(client, ["skill-usage"]);
    expect(client.getQueryState(["skills"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["skill", "example"])?.isInvalidated).toBe(false);
    client.clear();
  });
  test("should retain a change that arrives while an older snapshot is in flight", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    let title = "before";
    const observer = new QueryObserver(client, {
      queryKey: ["tasks"],
      queryFn: async () => {
        const snapshot = title;
        await Bun.sleep(30);
        return snapshot;
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    title = "after";
    try {
      await invalidateResources(client, ["tasks"]);
      expect(client.getQueryData(["tasks"])).toBe("after");
    } finally {
      unsubscribe();
      client.clear();
    }
  });
  test("should decode fragmented SSE frames, CRLF, comments and multiline data", () => {
    const events: [string, string][] = [];
    const frames = new EventFrames((event, data) => events.push([event, data]));
    frames.push(": keepalive\r\n\r\nevent: re");
    frames.push("ady\r\ndata: {}\r\n\r");
    frames.push('\nevent: change\ndata: {"resources":\ndata: ["tasks"]}\n\n');
    expect(events).toEqual([
      ["ready", "{}"],
      ["change", '{"resources":\n["tasks"]}'],
    ]);
    expect(parseResources(events[1]?.[1] ?? "")).toEqual(["tasks"]);
    expect(parseResources('{"resources":["unknown","terminals"]}')).toEqual(["terminals"]);
    expect(() => parseResources("{}")).toThrow();
  });

  test("should refresh a knowledge base digest when its job runs change", async () => {
    const client = new QueryClient();
    client.setQueryData(["kb-digest", "kb1"], null);
    client.setQueryData(["kb", "documents", "kb1"], []);
    await invalidateResources(client, ["jobs"]);
    expect(client.getQueryState(["kb-digest", "kb1"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["kb", "documents", "kb1"])?.isInvalidated).toBe(false);
    client.clear();
  });

  test("should refresh only affected resources and mark inactive queries stale", async () => {
    const client = new QueryClient();
    client.setQueryData(["tasks"], []);
    client.setQueryData(["task", "one"], {});
    client.setQueryData(["terminals"], []);
    await invalidateResources(client, ["tasks"]);
    expect(client.getQueryState(["tasks"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["task", "one"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["terminals"])?.isInvalidated).toBe(false);
    client.clear();
  });

  test("should cancel the response reader when the subscription is aborted", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    const events: string[] = [];
    const pending = consumeResourceEvents(response, controller.signal, (event) => {
      events.push(event);
      controller.abort();
    });
    await pending;
    expect(events).toEqual(["ready"]);
    expect(cancelled).toBe(true);
  });
});
