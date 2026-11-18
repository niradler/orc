import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  consumeResourceEvents,
  EventFrames,
  flushResourceChanges,
  invalidateResources,
  parseResources,
  subscribeResourceChanges,
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
  test("should refresh the usage report on usage changes without polling quotas", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    let reportReads = 0;
    let quotaReads = 0;
    const report = new QueryObserver(client, {
      queryKey: ["usage-report", "30", "day", "", ""],
      queryFn: async () => {
        reportReads++;
        return { totals: {} };
      },
    });
    const quotas = new QueryObserver(client, {
      queryKey: ["usage-quotas"],
      queryFn: async () => {
        quotaReads++;
        return { accounts: [] };
      },
    });
    const cleanup = [report.subscribe(() => {}), quotas.subscribe(() => {})];
    try {
      await Promise.all([report.refetch(), quotas.refetch()]);
      const reportBaseline = reportReads;
      const quotaBaseline = quotaReads;
      await invalidateResources(client, ["usage"]);
      expect(reportReads).toBe(reportBaseline + 1);
      expect(quotaReads).toBe(quotaBaseline);
    } finally {
      for (const unsubscribe of cleanup) unsubscribe();
      client.clear();
    }
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
  test("should coalesce a burst per root inside the window and refresh once the window passes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    const reads = { list: 0, detail: 0, tasks: 0, jobs: 0, terminals: 0 };
    const query = (key: string[], hit: keyof typeof reads) =>
      new QueryObserver(client, {
        queryKey: key,
        queryFn: async () => {
          reads[hit]++;
          return { hit };
        },
      });
    const observers = [
      query(["sessions", "live", true], "list"),
      query(["session", "one"], "detail"),
      query(["tasks"], "tasks"),
      query(["jobs"], "jobs"),
      query(["terminals"], "terminals"),
    ];
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    try {
      await Promise.all(observers.map((observer) => observer.refetch()));
      await Promise.all([
        invalidateResources(client, ["sessions"]),
        invalidateResources(client, ["sessions"]),
        invalidateResources(client, ["session-messages"]),
      ]);
      expect(reads).toEqual({ list: 2, detail: 2, tasks: 1, jobs: 1, terminals: 1 });

      // A second change inside the next window joins the first refresh instead of adding one.
      const first = invalidateResources(client, ["sessions"]);
      await Bun.sleep(200);
      const joined = invalidateResources(client, ["sessions"]);
      await Promise.all([first, joined]);
      expect(reads.list).toBe(3);

      // After the window closes, the next change refreshes again.
      await Bun.sleep(400);
      await invalidateResources(client, ["tasks", "jobs"]);
      expect(reads).toMatchObject({ tasks: 2, jobs: 2, terminals: 1 });
    } finally {
      for (const stop of unsubscribe) stop();
      client.clear();
    }
  });

  test("should refresh only the open session's queries when another session's work changes", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    const reads = { list: 0, viewed: 0, thread: 0, other: 0, tasks: 0 };
    const query = (key: unknown[], hit: keyof typeof reads) =>
      new QueryObserver(client, {
        queryKey: key,
        queryFn: async () => {
          reads[hit]++;
          return { hit };
        },
      });
    const observers = [
      query(["sessions", "live", true], "list"),
      query(["sessions", "lineage", "viewed"], "viewed"),
      query(["chat-threads", "session", "viewed-chat"], "thread"),
      query(["sessions", "children", "other"], "other"),
      query(["tasks"], "tasks"),
    ];
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    try {
      await Promise.all(observers.map((observer) => observer.refetch()));
      await invalidateResources(client, ["session-activity"], ["busy", "busy-native"]);
      expect(reads).toEqual({ list: 1, viewed: 1, thread: 1, other: 1, tasks: 1 });
      await invalidateResources(client, ["session-activity"], ["viewed", "viewed-chat"]);
      expect(reads).toEqual({ list: 1, viewed: 2, thread: 2, other: 1, tasks: 1 });
      await invalidateResources(client, ["session-activity"]);
      expect(reads).toEqual({ list: 2, viewed: 2, thread: 2, other: 1, tasks: 1 });
      await invalidateResources(client, ["sessions"]);
      expect(reads).toEqual({ list: 3, viewed: 2, thread: 3, other: 2, tasks: 1 });
      await invalidateResources(client, ["session-messages"]);
      expect(reads).toEqual({ list: 3, viewed: 2, thread: 3, other: 2, tasks: 1 });
    } finally {
      for (const stop of unsubscribe) stop();
      client.clear();
    }
  });

  test("should refresh the usage report but only the open session's cache when another session's usage lands", async () => {
    const client = new QueryClient();
    client.setQueryData(["usage-report", "30"], {});
    client.setQueryData(["session-cache", "viewed", false], {});
    client.setQueryData(["session-cache", "busy", true], {});
    await flushResourceChanges(client);
    await Promise.all([
      invalidateResources(client, ["usage"], ["busy"]),
      flushResourceChanges(client),
    ]);
    expect(client.getQueryState(["usage-report", "30"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["session-cache", "busy", true])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["session-cache", "viewed", false])?.isInvalidated).toBe(false);
    client.clear();
  });

  test("should tell subscribers a desktop preview request is waiting without refreshing queries", async () => {
    const client = new QueryClient();
    client.setQueryData(["sessions", "live", true], []);
    const seen: string[][] = [];
    const unsubscribe = subscribeResourceChanges((resources) => seen.push(resources));
    try {
      await invalidateResources(client, ["desktop-preview"]);
      expect(seen).toEqual([["desktop-preview"]]);
      expect(client.getQueryState(["sessions", "live", true])?.isInvalidated).toBe(false);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  test("should flush queued changes on demand and cancel the pending window", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: ["sessions", "live", true],
      queryFn: async () => ({ read: ++reads }),
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await observer.refetch();
      const pending = invalidateResources(client, ["sessions"]);
      await Promise.all([pending, flushResourceChanges(client)]);
      expect(reads).toBe(2);
      await Bun.sleep(400);
      expect(reads).toBe(2);
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
    expect(parseResources(events[1]?.[1] ?? "")).toEqual({ resources: ["tasks"] });
    expect(parseResources('{"resources":["unknown","terminals"]}')).toEqual({
      resources: ["terminals"],
    });
    expect(parseResources('{"resources":["sessions"],"sessions":["s1",2]}')).toEqual({
      resources: ["sessions"],
      sessions: ["s1"],
    });
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

  test("should refresh every formerly polled view from the resource that changes it", async () => {
    const cases: [Parameters<typeof invalidateResources>[1][number], unknown[]][] = [
      ["jobs", ["job-runs", "j1"]],
      ["jobs", ["job-run-logs", "j1", "r1", true]],
      ["jobs", ["kb-digest", "kb1"]],
      ["jobs", ["kb-digest-runs", "kb1", "j1", 1, "running"]],
      ["knowledge", ["kb", "documents", "kb1"]],
      ["knowledge", ["kb", "document", "d1"]],
      ["knowledge", ["kb", "status"]],
      ["knowledge", ["kb", "parsers"]],
      ["sessions", ["sessions", "children", "s1"]],
      ["session-messages", ["sessions", "messages", "s1"]],
      ["webhooks", ["webhook-deliveries", "w1"]],
      ["workspaces", ["workspaces", "path", "/repo"]],
      ["usage", ["chat-analytics", "thread", "t1"]],
      ["channels", ["channels"]],
      ["channels", ["channel-pairing", "p1"]],
      ["channels", ["channel-notification-deliveries"]],
    ];
    for (const [resource, key] of cases) {
      const client = new QueryClient();
      client.setQueryData(key, null);
      const refreshed = invalidateResources(client, [resource]);
      await flushResourceChanges(client);
      await refreshed;
      expect([resource, key, client.getQueryState(key)?.isInvalidated]).toEqual([
        resource,
        key,
        true,
      ]);
      client.clear();
    }
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
