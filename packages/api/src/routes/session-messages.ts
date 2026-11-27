import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import { NotFoundError, ValidationError } from "@orc/core/errors";
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
  SessionSubagentsSchema,
  SessionWaitManySchema,
  SessionWaitSchema,
} from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { SessionMessageStore } from "@orc/db/session-messages";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";
import {
  deliverSessionMessageNow,
  requireAncestor,
  sendToSession,
  sessionLineage,
  sessionSubagents,
} from "../sessions/control.js";
import { resolveSessionRef } from "../sessions/resolve.js";
import { chatStatus, spawnChat, stopSession } from "./chat.js";

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

app.openapi(
  createRoute({
    method: "post",
    path: "/session-messages/{id}/deliver",
    tags: ["Sessions"],
    summary: "Steer a queued session message into the active turn now",
    request: { params },
    responses: message,
  }),
  async (c) => c.json(await deliverSessionMessageNow(c.req.valid("param").id), 200),
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
    request: {
      params,
      query: z.object({
        include_archived: z
          .enum(["true", "false"])
          .optional()
          .default("false")
          .transform((value) => value === "true")
          .openapi({ description: "Also return children the caller archived" }),
      }),
    },
    responses: {
      200: {
        description: "Child sessions",
        content: {
          "application/json": { schema: z.object({ sessions: z.array(SessionStatusSchema) }) },
        },
      },
    },
  }),
  (c) => {
    const id = c.req.valid("param").id;
    const resolved = resolveSessionRef(id);
    const ids = new Set<string>([id]);
    if (resolved) {
      for (const candidate of [resolved.chatId, resolved.liveId, resolved.nativeId]) {
        if (candidate) ids.add(candidate);
      }
    }
    return c.json(
      {
        sessions: new ChatStore(getSqlite())
          .children([...ids], {
            includeArchived: c.req.valid("query").include_archived,
          })
          .map((child) => chatStatus(child.id)),
      },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/{id}/archive",
    tags: ["Sessions"],
    summary: "Archive or restore a session started with session_start",
    description:
      "Archiving only removes the session from the default child list; its transcript stays readable by id. Only the session that started it (or an ancestor) may archive it.",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ archived: z.boolean().default(true) }).strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated session",
        content: { "application/json": { schema: SessionStatusSchema } },
      },
      403: { description: "Only the session that started it, or an ancestor, can archive it" },
      404: { description: "Session not found, or it was not started with session_start" },
    },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    const { archived } = c.req.valid("json");
    const header = c.req.header("X-ORC-Session");
    if (!header)
      throw new ValidationError(
        "Pass X-ORC-Session with the calling session id to archive sessions",
      );
    const thread = resolveSessionRef(id)?.thread;
    if (!thread) throw new NotFoundError("Session started with session_start", id);
    requireAncestor(caller(header), thread.id);
    const updated = new ChatStore(getSqlite()).setArchived(
      thread.id,
      archived ? (thread.archivedAt ?? Date.now()) : null,
    );
    if (!updated) throw new NotFoundError("Session", id);
    changes.publish("sessions");
    return c.json(chatStatus(updated.id), 200);
  },
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

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/subagents",
    tags: ["Sessions"],
    summary: "The subagents a session ran, each with the tool call that started it",
    request: { params },
    responses: {
      200: {
        description: "Subagents in start order",
        content: { "application/json": { schema: SessionSubagentsSchema } },
      },
    },
  }),
  async (c) => c.json(await sessionSubagents(c.req.valid("param").id), 200),
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
    const sender = caller(c.req.header("X-ORC-Session"));
    return c.json(stopSession(id, c.req.valid("query").cascade === "true", sender), 200);
  },
);

export { app as sessionMessagesRouter };
