import { createRoute, z } from "@hono/zod-openapi";
import {
  SessionSendInputSchema,
  SessionSendPreviewSchema,
  type SessionSendRequest,
  SessionSendSchema,
  SessionSendToRemoteHostSchema,
} from "@orc/core/session-send";
import { listSends, sendDto, sendPreview, sendSession } from "../handoffs/send.js";
import { createRouter } from "../lib/router.js";
import { findRemoteHost } from "../remote-hosts.js";

const app = createRouter();
const params = z.object({ id: z.string().min(1).max(200) });

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/send-preview",
    tags: ["Sessions"],
    summary: "What a Send to host move would carry, and whether the session is eligible",
    request: { params },
    responses: {
      200: {
        description: "Send preview",
        content: { "application/json": { schema: SessionSendPreviewSchema } },
      },
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await sendPreview(c.req.valid("param").id), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/live/{id}/send-to",
    tags: ["Sessions"],
    summary:
      "Move a session to another ORC installation: snapshot and push its repo state, upload the native transcript and prepare it for resume there",
    description:
      "The destination URL, token and proxy headers come from the client's saved hosts and are used for this request only; they are not stored. Orchestration failures are recorded on the returned send with status error.",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.union([SessionSendToRemoteHostSchema, SessionSendInputSchema]),
          },
        },
      },
    },
    responses: {
      200: {
        description: "The recorded send, ready or with its error",
        content: { "application/json": { schema: SessionSendSchema } },
      },
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    const body = c.req.valid("json");
    const input: SessionSendRequest =
      "remote_host" in body
        ? (() => {
            const host = findRemoteHost(body.remote_host);
            return {
              host_label: host.label,
              url: host.url,
              token: host.token,
              headers: host.headers,
              project: body.project,
              note: body.note,
            };
          })()
        : body;
    return c.json(sendDto(await sendSession(c.req.valid("param").id, input)), 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/live/{id}/sends",
    tags: ["Sessions"],
    summary: "This session's send history, newest first",
    request: { params },
    responses: {
      200: {
        description: "Session sends",
        content: {
          "application/json": { schema: z.object({ sends: z.array(SessionSendSchema) }) },
        },
      },
    },
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    const rows = await listSends(c.req.valid("param").id);
    return c.json({ sends: rows.map(sendDto) }, 200);
  },
);

export { app as sessionSendRouter };
