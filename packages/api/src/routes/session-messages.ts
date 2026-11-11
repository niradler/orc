import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import {
  type SessionMessage,
  SessionMessageCreateSchema,
  SessionMessageMoveSchema,
  SessionMessageResultSchema,
  SessionMessageSchema,
  type SessionMessageSender,
  sessionMessageBackend,
  sessionMessageHookSupported,
} from "@orc/core/session-messages";
import { getSqlite } from "@orc/db/client";
import { SessionMessageStore } from "@orc/db/session-messages";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";

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

function result(store: SessionMessageStore, queued: SessionMessage) {
  const target = store.target(queued.target_session_id);
  return {
    message: queued,
    target: {
      session_id: target.id,
      backend: sessionMessageBackend(target.backend),
      status: target.status,
      delivery:
        target.status === "stopped"
          ? ("resume" as const)
          : sessionMessageHookSupported(target.backend)
            ? ("hook" as const)
            : ("unsupported" as const),
    },
  };
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
      409: { description: "A safety limit was reached" },
    },
  }),
  (c) => {
    const mails = store();
    const id = c.req.valid("param").id;
    const input = c.req.valid("json");
    const queued = mails.create(
      { ...input, session_id: id },
      caller(c.req.header("X-ORC-Session")),
    );
    changes.publish("session-messages", "sessions");
    return c.json(result(mails, queued), 200);
  },
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
      409: { description: "A safety limit was reached" },
    },
  }),
  (c) => {
    const mails = store();
    const queued = mails.create(c.req.valid("json"), caller(c.req.header("X-ORC-Session")));
    changes.publish("session-messages", "sessions");
    return c.json(result(mails, queued), 200);
  },
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

export { app as sessionMessagesRouter };
