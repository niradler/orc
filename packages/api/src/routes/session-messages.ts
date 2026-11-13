import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import { ValidationError } from "@orc/core/errors";
import {
  SessionLineageSchema,
  SessionMessageCreateSchema,
  SessionMessageMoveSchema,
  SessionMessageResultSchema,
  SessionMessageSchema,
  type SessionMessageSender,
  SessionSpawnSchema,
  type SessionStatus,
  SessionStatusSchema,
  SessionWaitManySchema,
  SessionWaitSchema,
} from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { SessionMessageStore } from "@orc/db/session-messages";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";
import { requireAncestor, sendToSession, sessionLineage } from "../sessions/control.js";
import { chatStatus, spawnChat, stopChat } from "./chat.js";

const app = createRouter();
app.use("/session-messages/*", bodyLimit({ maxSize: 20000 }));
app.use("/session-messages", bodyLimit({ maxSize: 20000 }));

const params = z.object({ id: z.string().min(1).max(200) });
const message = {
  200: {
    description: "Session message",
    content: { "application/json": { schema: SessionMessageSchema } },
  },
  404: { description: "Session or message not found" },
  409: { description: "Message is no longer queued, or a safety limit was reached" },
};

function store(): SessionMessageStore {
  return new SessionMessageStore(getSqlite());
}

function caller(identifier: string | undefined): SessionMessageSender {
  return identifier
    ? store().resolveSender(identifier, "session")
    : { kind: "human", label: "human relay (ORC web)" };
}

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/messages",
    tags: ["Sessions"],
    summary: "Queued and recently delivered messages for a live or idle session",
    request: { params },
    responses: {
      200: {
        description: "Session message inbox",
        content: {
          "application/json": {
            schema: z.object({ messages: z.array(SessionMessageSchema) }),
          },
        },
      },
      404: { description: "Session not found" },
    },
  }),
  (c) => {
    const mails = store();
    const target = mails.target(c.req.valid("param").id);
    return c.json({ messages: mails.list(target.id) }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/{id}/messages",
    tags: ["Sessions"],
    summary: "Queue a message for a live or idle session",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: SessionMessageCreateSchema.omit({ session_id: true, backend: true }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Queued message and its target",
        content: { "application/json": { schema: SessionMessageResultSchema } },
      },
      404: { description: "Session not found" },
      403: { description: "Only an ancestor session can steer or interrupt" },
      409: { description: "A safety limit was reached" },
    },
  }),
  async (c) =>
    c.json(
      await sendToSession(
        { ...c.req.valid("json"), session_id: c.req.valid("param").id },
        caller(c.req.header("X-ORC-Session")),
      ),
      200,
    ),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/session-messages",
    tags: ["Sessions"],
    summary: "Queue a message from an agent session; pass X-ORC-Session for sender identity",
    request: {
      body: { content: { "application/json": { schema: SessionMessageCreateSchema } } },
    },
    responses: {
      200: {
        description: "Queued message and its target",
        content: { "application/json": { schema: SessionMessageResultSchema } },
      },
      404: { description: "Session not found" },
      403: { description: "Only an ancestor session can steer or interrupt" },
      409: { description: "A safety limit was reached" },
    },
  }),
  async (c) =>
    c.json(await sendToSession(c.req.valid("json"), caller(c.req.header("X-ORC-Session"))), 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/session-messages/{id}/cancel",
    tags: ["Sessions"],
    summary: "Cancel a queued session message",
    request: { params },
    responses: message,
  }),
  (c) => {
    const cancelled = store().cancel(c.req.valid("param").id);
    changes.publish("session-messages", "sessions");
    return c.json(cancelled, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/session-messages/{id}/move",
    tags: ["Sessions"],
    summary: "Reorder a queued session message",
    request: {
      params,
      body: { content: { "application/json": { schema: SessionMessageMoveSchema } } },
    },
    responses: message,
  }),
  (c) => {
    const moved = store().move(c.req.valid("param").id, c.req.valid("json").direction);
    changes.publish("session-messages", "sessions");
    return c.json(moved, 200);
  },
);

function callerSession(identifier: string | undefined): string {
  if (!identifier)
    throw new ValidationError("Pass X-ORC-Session with the calling session id to start sessions");
  const sender = store().resolveSender(identifier, "session");
  return new ChatStore(getSqlite()).get(identifier)
    ? identifier
    : (sender.session_id ?? identifier);
}

const status = {
  200: {
    description: "Session status",
    content: { "application/json": { schema: SessionStatusSchema } },
  },
  404: { description: "Session not found" },
};

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/spawn",
    tags: ["Sessions"],
    summary: "Start a headless child chat session for the calling session (X-ORC-Session)",
    request: { body: { content: { "application/json": { schema: SessionSpawnSchema } } } },
    responses: {
      ...status,
      400: { description: "Missing caller identity or invalid workspace" },
      409: { description: "Spawn limit reached or all chat workers are busy" },
    },
  }),
  async (c) => {
    const thread = await spawnChat(
      callerSession(c.req.header("X-ORC-Session")),
      c.req.valid("json"),
    );
    changes.publish("sessions");
    return c.json(chatStatus(thread.id), 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/status",
    tags: ["Sessions"],
    summary: "Status, last reply, queue and lineage of a chat-run session",
    request: { params },
    responses: status,
  }),
  (c) => c.json(chatStatus(c.req.valid("param").id), 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/children",
    tags: ["Sessions"],
    summary: "Sessions started by this session",
    request: { params },
    responses: {
      200: {
        description: "Child sessions",
        content: {
          "application/json": { schema: z.object({ sessions: z.array(SessionStatusSchema) }) },
        },
      },
    },
  }),
  (c) =>
    c.json(
      {
        sessions: new ChatStore(getSqlite())
          .children([c.req.valid("param").id])
          .map((child) => chatStatus(child.id)),
      },
      200,
    ),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/lineage",
    tags: ["Sessions"],
    summary: "The session that started this one and the sessions it started",
    request: { params },
    responses: {
      200: {
        description: "Parent and children",
        content: { "application/json": { schema: SessionLineageSchema } },
      },
    },
  }),
  (c) => c.json(sessionLineage(c.req.valid("param").id), 200),
);

function settled(current: SessionStatus, initial: SessionStatus, until: "idle" | "message") {
  if (current.status !== "running" && current.status !== "queued") return true;
  return until === "message" && current.last_message !== initial.last_message;
}

function waitFor(
  ids: string[],
  until: "idle" | "message",
  mode: "all" | "any",
  timeoutSecs: number,
  signal: AbortSignal,
): Promise<{ sessions: SessionStatus[]; timedOut: boolean }> {
  const initial = ids.map((id) => chatStatus(id));
  const done = (current: SessionStatus[]) => {
    const flags = current.map((status, index) =>
      settled(status, initial[index] as SessionStatus, until),
    );
    return mode === "all" ? flags.every(Boolean) : flags.some(Boolean);
  };
  if (done(initial)) return Promise.resolve({ sessions: initial, timedOut: false });
  return new Promise((resolve) => {
    let finish = (_timedOut: boolean) => {};
    const unsubscribe = changes.subscribe(({ resources }) => {
      if (
        resources.includes("sessions") ||
        resources.includes("session-messages") ||
        resources.includes("human-requests")
      )
        finish(false);
    });
    const timer = setTimeout(() => finish(true), timeoutSecs * 1000);
    const abort = () => finish(true);
    signal.addEventListener("abort", abort);
    finish = (timedOut) => {
      const current = ids.map((id) => chatStatus(id));
      if (!timedOut && !done(current)) return;
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ sessions: current, timedOut });
    };
  });
}

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/{id}/wait",
    tags: ["Sessions"],
    summary: "Block until a chat-run session stops running, waits for a human, or replies",
    request: {
      params,
      body: { content: { "application/json": { schema: SessionWaitSchema } } },
    },
    responses: {
      200: {
        description: "Status when the wait ended",
        content: {
          "application/json": {
            schema: SessionStatusSchema.extend({ timed_out: z.boolean() }),
          },
        },
      },
      404: { description: "Session not found" },
    },
  }),
  async (c) => {
    const { until, timeout_s } = c.req.valid("json");
    const result = await waitFor(
      [c.req.valid("param").id],
      until,
      "all",
      timeout_s,
      c.req.raw.signal,
    );
    return c.json({ ...(result.sessions[0] as SessionStatus), timed_out: result.timedOut }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/wait",
    tags: ["Sessions"],
    summary: "Block until all (or any) of several chat-run sessions stop running, wait, or reply",
    request: { body: { content: { "application/json": { schema: SessionWaitManySchema } } } },
    responses: {
      200: {
        description: "Statuses when the wait ended",
        content: {
          "application/json": {
            schema: z.object({ sessions: z.array(SessionStatusSchema), timed_out: z.boolean() }),
          },
        },
      },
      404: { description: "Session not found" },
    },
  }),
  async (c) => {
    const { session_ids, until, mode, timeout_s } = c.req.valid("json");
    const result = await waitFor(session_ids, until, mode, timeout_s, c.req.raw.signal);
    return c.json({ sessions: result.sessions, timed_out: result.timedOut }, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/{id}/stop",
    tags: ["Sessions"],
    summary:
      "Stop a chat-run session's current turn, and by default the sessions it started; sessions stay resumable",
    request: {
      params,
      query: z.object({ cascade: z.enum(["true", "false"]).default("true") }),
    },
    responses: {
      ...status,
      403: { description: "Only an ancestor session can stop it" },
    },
  }),
  (c) => {
    const id = c.req.valid("param").id;
    chatStatus(id);
    requireAncestor(caller(c.req.header("X-ORC-Session")), id);
    stopChat(id, c.req.valid("query").cascade === "true");
    return c.json(chatStatus(id), 200);
  },
);

export { app as sessionMessagesRouter };
