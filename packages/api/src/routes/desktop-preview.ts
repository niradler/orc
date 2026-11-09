import { createRoute, z } from "@hono/zod-openapi";
import { configuredApiSecret, loadConfig } from "@orc/core/config";
import {
  BrowserActionSchema,
  PreviewBrowserInputSchema,
  PreviewClientSchema,
  PreviewOpenSchema,
} from "@orc/core/desktop-preview";
import { bodyLimit } from "hono/body-limit";
import { previewBroker } from "../desktop-preview/broker.js";
import { readPreviewFile, savePreviewFile } from "../desktop-preview/files.js";
import { previewSession } from "../desktop-preview/session.js";
import { createRouter } from "../lib/router.js";
import { bearerAuth } from "../middleware/auth.js";

const app = createRouter();
app.use("/desktop-preview/*", (c, next) =>
  bearerAuth(configuredApiSecret(loadConfig().api.secret))(c, next),
);
app.use("/desktop-preview/*", bodyLimit({ maxSize: 2_000_000 }));
app.use("/desktop-preview/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
const requestResult = z.object({
  id: z.string(),
  client_id: z.string(),
  session_id: z.string(),
  kind: z.enum(["url", "file", "browser"]),
  target: z.string(),
  status: z.enum(["queued", "opened", "completed", "failed", "expired"]),
  error: z.string().nullable(),
  expires_at: z.number(),
  result: z.unknown().optional(),
  command: BrowserActionSchema.optional(),
  tab_id: z.string().uuid().optional(),
});
const fileResult = z.object({
  kind: z.enum(["text", "image"]),
  path: z.string(),
  root: z.string(),
  host: z.string().nullable(),
  content: z.string(),
  editable: z.boolean(),
});
const params = z.object({ id: z.string().uuid() });
const sessionQuery = z.object({ session_id: z.string().min(1).max(200) });
const fileQuery = sessionQuery.extend({ target: z.string().min(1).max(4096) });
app.openapi(
  createRoute({
    method: "get",
    path: "/desktop-preview/clients",
    tags: ["Desktop preview"],
    summary: "List desktop targets viewing one session",
    request: { query: sessionQuery },
    responses: {
      200: json(
        z.object({
          clients: z.array(
            z.object({
              client_id: z.string(),
              agent_access: z.boolean(),
              browser_ready: z.boolean(),
            }),
          ),
        }),
      ),
    },
  }),
  async (c) => {
    const session = await previewSession(c.req.valid("query").session_id);
    return c.json({ clients: previewBroker.list(session.id) });
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/desktop-preview/clients/{id}/close",
    tags: ["Desktop preview"],
    summary: "Release this desktop lease on close or reload",
    request: { params },
    responses: { 204: { description: "Desktop lease released" } },
  }),
  (c) => {
    previewBroker.close(c.req.valid("param").id, c.req.header("X-Preview-Lease"));
    return c.body(null, 204);
  },
);
function json(schema: z.ZodType) {
  return { description: "Desktop preview result", content: { "application/json": { schema } } };
}

app.openapi(
  createRoute({
    method: "get",
    path: "/desktop-preview/session",
    tags: ["Desktop preview"],
    summary: "Resolve a preview's trusted session workspace and project",
    request: { query: sessionQuery },
    responses: {
      200: json(
        z.object({
          id: z.string(),
          cwd: z.string(),
          host: z.string().nullable(),
          projectId: z.string().nullable(),
        }),
      ),
    },
  }),
  async (c) => {
    const session = await previewSession(c.req.valid("query").session_id);
    return c.json({ ...session, host: session.host.kind === "ssh" ? session.host.alias : null });
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/desktop-preview/clients",
    tags: ["Desktop preview"],
    summary: "Register or renew a desktop viewing one session",
    request: { body: { content: { "application/json": { schema: PreviewClientSchema } } } },
    responses: { 200: json(z.object({ client_id: z.string(), lease: z.string() })) },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const session = input.session_id ? (await previewSession(input.session_id)).id : null;
    return c.json(
      previewBroker.register(
        input.client_id,
        session,
        c.req.header("X-Preview-Lease"),
        input.agent_access,
        input.browser_ready,
      ),
    );
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/desktop-preview/clients/{id}/requests",
    tags: ["Desktop preview"],
    summary: "Receive requests for this desktop's selected session",
    request: { params },
    responses: { 200: json(z.object({ requests: z.array(requestResult) })) },
  }),
  (c) =>
    c.json({
      requests: previewBroker.pending(c.req.valid("param").id, c.req.header("X-Preview-Lease")),
    }),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/desktop-preview/requests",
    tags: ["Desktop preview"],
    summary: "Queue a file or URL in a desktop viewing this session",
    request: { body: { content: { "application/json": { schema: PreviewOpenSchema } } } },
    responses: { 200: json(requestResult) },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const session = await previewSession(input.session_id);
    if (input.kind === "file") await readPreviewFile(session.host, session.cwd, input.target);
    return c.json(previewBroker.create({ ...input, session_id: session.id }));
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/desktop-preview/browser",
    tags: ["Desktop preview"],
    summary: "Queue browser automation for an explicitly enabled session",
    request: { body: { content: { "application/json": { schema: PreviewBrowserInputSchema } } } },
    responses: { 200: json(requestResult) },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const session = await previewSession(input.session_id);
    return c.json(
      previewBroker.create({ ...input, session_id: session.id, kind: "browser", target: "" }),
    );
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/desktop-preview/requests/{id}",
    tags: ["Desktop preview"],
    summary: "Read truthful queued/opened/completed/failed preview delivery",
    request: { params },
    responses: { 200: json(requestResult) },
  }),
  (c) => c.json(previewBroker.get(c.req.valid("param").id)),
);
const acknowledgement = z
  .object({
    client_id: z.string().uuid(),
    status: z.enum(["opened", "completed", "failed"]),
    error: z.string().max(2000).nullable().default(null),
    result: z.unknown().optional(),
  })
  .strict();
app.openapi(
  createRoute({
    method: "post",
    path: "/desktop-preview/requests/{id}/ack",
    tags: ["Desktop preview"],
    summary: "Acknowledge an actual preview or browser action result",
    request: { params, body: { content: { "application/json": { schema: acknowledgement } } } },
    responses: { 200: json(requestResult) },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(
      previewBroker.acknowledge(
        input.client_id,
        c.req.header("X-Preview-Lease"),
        c.req.valid("param").id,
        input.status,
        input.error,
        input.result,
      ),
    );
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/desktop-preview/file",
    tags: ["Desktop preview"],
    summary: "Preview a bounded file inside a trusted session workspace",
    request: { query: fileQuery },
    responses: { 200: json(fileResult) },
  }),
  async (c) => {
    const input = c.req.valid("query");
    const session = await previewSession(input.session_id);
    return c.json(await readPreviewFile(session.host, session.cwd, input.target));
  },
);
const save = fileQuery
  .extend({ content: z.string().max(200_000), original: z.string().max(200_000) })
  .strict();
app.openapi(
  createRoute({
    method: "put",
    path: "/desktop-preview/file",
    tags: ["Desktop preview"],
    summary: "Save workspace text with optimistic conflict protection",
    request: { body: { content: { "application/json": { schema: save } } } },
    responses: {
      204: { description: "File saved" },
      409: { description: "File changed on disk; original content is required" },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const session = await previewSession(input.session_id);
    await savePreviewFile(session.host, session.cwd, input.target, input.content, input.original);
    return c.body(null, 204);
  },
);

export { app as desktopPreviewRouter };
