import { expect, test } from "bun:test";
import { HumanRequestSchema } from "@orc/core/human-requests";
import type { OrcNotification } from "@orc/core/notifications";
import {
  mergeNotificationToasts,
  NotificationFeed,
  notificationInView,
} from "../../src/lib/notification-feed";

const item = (id: string, type = "future.type"): OrcNotification => ({
  id,
  type,
  source_id: id,
  title: id,
  body: "",
  level: "needs-you",
  project_id: null,
  path: "/activity",
  requires_action: true,
  created_at: 1000,
  expires_at: 10000,
  read_at: null,
  dismissed_at: null,
});
test("should settle new generic types once and never replay initial history", () => {
  const feed = new NotificationFeed();
  feed.update([item("old")], 1000);
  expect(feed.flush(3000, () => false)).toEqual([]);
  feed.update([item("new"), item("old")], 3000);
  expect(feed.flush(3999, () => false)).toEqual([]);
  expect(feed.flush(4000, () => false).map((item) => item.id)).toEqual(["new"]);
  feed.update([item("new"), item("old")], 5000);
  expect(feed.flush(6000, () => false)).toEqual([]);
});
test("should recheck resolved, dismissed, expired and viewed alerts before delivery", () => {
  const feed = new NotificationFeed();
  feed.update([], 0);
  feed.update(
    [
      item("resolved"),
      item("dismissed"),
      item("expired"),
      item("viewed"),
      item("job", "job.failed"),
    ],
    1000,
  );
  feed.update(
    [
      { ...item("resolved"), requires_action: false },
      { ...item("dismissed"), dismissed_at: 1500 },
      { ...item("expired"), expires_at: 1900 },
      item("viewed"),
      item("job", "job.failed"),
    ],
    1500,
  );
  expect(feed.flush(2000, (item) => item.id === "viewed").map((item) => item.id)).toEqual(["job"]);
});

test("should collapse mixed completion bursts while keeping urgent notices separate", () => {
  const result = mergeNotificationToasts(
    [],
    [
      item("needs"),
      { ...item("job", "job.finished"), level: "done" },
      { ...item("agent", "agent.finished"), level: "done" },
    ],
  );
  expect(result).toHaveLength(2);
  expect(result[1]?.items.map((item) => item.type)).toEqual(["job.finished", "agent.finished"]);
  const next = mergeNotificationToasts(result, [
    { ...item("another", "future.completed"), level: "done" },
  ]);
  expect(next[1]?.items).toHaveLength(3);
});

const view = {
  active: true,
  pathname: "/chat",
  search: "?project=all&chatThread=thread-1",
  chatThreadId: "thread-1",
};

test("should recognize the open chat by thread, including a side panel link", () => {
  const finished = {
    ...item("finished", "agent.finished"),
    path: "/activity?chat=open&chatThread=thread-1",
  };
  expect(notificationInView(finished, view)).toBe(true);
  expect(
    notificationInView(finished, {
      ...view,
      pathname: "/tasks",
      search: "?chat=open&chatThread=thread-1",
    }),
  ).toBe(true);
  expect(notificationInView(finished, { ...view, chatThreadId: "thread-2" })).toBe(false);
  expect(
    notificationInView(finished, { ...view, pathname: "/tasks", search: "?project=all" }),
  ).toBe(false);
  expect(notificationInView(finished, { ...view, active: false })).toBe(false);
});

test("should recognize a human request whose origin chat is open", () => {
  const request = HumanRequestSchema.parse({
    id: "request-1",
    input: {
      kind: "question",
      prompt: "Continue?",
      origin: {
        session_id: "session-1",
        backend: "codex",
        request_id: "request-1",
        chat_thread_id: "00000000-0000-4000-8000-000000000001",
      },
    },
    status: "pending",
    version: 1,
    response: null,
    created_at: 1000,
    expires_at: 10000,
    responded_at: null,
    delivered_at: null,
  });
  const notification = {
    ...item("request-1", "human.request"),
    source_id: request.id,
    path: `/activity?notifications=open&request=${request.id}`,
  };
  expect(
    notificationInView(notification, {
      ...view,
      chatThreadId: "00000000-0000-4000-8000-000000000001",
      requests: [request],
    }),
  ).toBe(true);
  expect(notificationInView(notification, { ...view, requests: [], chatThreadId: null })).toBe(
    false,
  );
});

test("should recognize the open native session by direct link or origin identity", () => {
  const session = {
    id: "native-1",
    agent: "codex-cli",
    host: "lab",
    session_id: "runtime-1",
  };
  const direct = { ...item("native", "agent.finished"), path: "/chat?sessionLive=native-1" };
  const sessions = {
    active: true,
    pathname: "/chat",
    search: "?sessionLive=native-1",
    chatThreadId: null,
    sessions: [session],
  };
  expect(notificationInView(direct, sessions)).toBe(true);
  expect(notificationInView(direct, { ...sessions, search: "?sessionLive=native-2" })).toBe(false);
  const request = HumanRequestSchema.parse({
    id: "request-2",
    input: {
      kind: "question",
      prompt: "Continue?",
      origin: {
        session_id: "gateway-1",
        backend: "codex",
        request_id: "request-2",
        native_session_id: "runtime-1",
        execution_host: "lab",
      },
    },
    status: "pending",
    version: 1,
    response: null,
    created_at: 1000,
    expires_at: 10000,
    responded_at: null,
    delivered_at: null,
  });
  const notification = {
    ...item(request.id, "human.request"),
    source_id: request.id,
    path: `/activity?notifications=open&request=${request.id}`,
  };
  expect(notificationInView(notification, { ...sessions, requests: [request] })).toBe(true);
  expect(
    notificationInView(notification, {
      ...sessions,
      requests: [
        {
          ...request,
          input: {
            ...request.input,
            origin: { ...request.input.origin, execution_host: "elsewhere" },
          },
        },
      ],
    }),
  ).toBe(false);
});

test("should recognize a session notification in the chat thread resumed from it", () => {
  const finished = { ...item("native-1", "agent.finished"), path: "/chat?sessionLive=native-1" };
  const view = {
    active: true,
    pathname: "/chat",
    search: "?project=all",
    chatThreadId: "thread-1",
    threadSourceId: "native-1",
  };
  expect(notificationInView(finished, view)).toBe(true);
  expect(notificationInView(finished, { ...view, threadSourceId: "native-2" })).toBe(false);
  expect(notificationInView(finished, { ...view, pathname: "/tasks" })).toBe(false);
  // A human request's own id is not a session id.
  expect(
    notificationInView(
      {
        ...item("request-1", "human.request"),
        path: "/activity?notifications=open&request=request-1",
      },
      { ...view, threadSourceId: "request-1" },
    ),
  ).toBe(false);
  const request = HumanRequestSchema.parse({
    id: "request-9",
    input: {
      kind: "question",
      prompt: "Continue?",
      origin: { backend: "codex-cli", session_id: "runtime-1", request_id: "request-9" },
    },
    status: "pending",
    version: 1,
    response: null,
    created_at: 1000,
    expires_at: 10000,
    responded_at: null,
    delivered_at: null,
  });
  const resumed = {
    ...view,
    sessions: [{ id: "native-1", agent: "codex-cli", host: null, session_id: "runtime-1" }],
    requests: [request],
  };
  expect(
    notificationInView(
      {
        ...item(request.id, "human.request"),
        source_id: request.id,
        path: `/activity?notifications=open&request=${request.id}`,
      },
      resumed,
    ),
  ).toBe(true);
  expect(
    notificationInView(
      {
        ...item(request.id, "human.request"),
        source_id: request.id,
        path: `/activity?notifications=open&request=${request.id}`,
      },
      { ...resumed, threadSourceId: "native-2", sessions: [] },
    ),
  ).toBe(false);
});
