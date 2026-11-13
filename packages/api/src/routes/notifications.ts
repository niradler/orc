import { createRoute, z } from "@hono/zod-openapi";
import {
  NotificationPageSchema,
  NotificationSchema,
  NotificationUpdateSchema,
} from "@orc/core/notifications";
import { getSqlite } from "@orc/db/client";
import { NotificationStore } from "@orc/db/notifications";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const ApiNotificationSchema = z.object(NotificationSchema.shape).openapi("OrcNotification");
const ApiNotificationPageSchema = z
  .object({ ...NotificationPageSchema.shape, notifications: z.array(ApiNotificationSchema) })
  .openapi("NotificationPage");
app.use("/notifications/*", bodyLimit({ maxSize: 2000 }));
const json = <T extends z.ZodType>(schema: T) => ({
  description: "Notification result",
  content: { "application/json": { schema } },
});
const store = () => new NotificationStore(getSqlite());

app.openapi(
  createRoute({
    method: "get",
    path: "/notifications",
    tags: ["Notifications"],
    summary: "List nonexpired notifications and the shared unread count",
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        unread: z.enum(["true", "false"]).default("false"),
        project_id: z.string().min(1).max(256).optional(),
      }),
    },
    responses: { 200: json(ApiNotificationPageSchema) },
  }),
  (c) => {
    const query = c.req.valid("query");
    return c.json(
      store().list(
        query.limit,
        query.offset,
        query.unread === "true",
        query.project_id === undefined
          ? undefined
          : query.project_id === "unassigned"
            ? null
            : query.project_id,
      ),
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/notifications/{id}",
    tags: ["Notifications"],
    summary: "Change shared read or dismissal state without changing the source request",
    request: {
      params: z.object({ id: z.string().min(1).max(100) }),
      body: { content: { "application/json": { schema: NotificationUpdateSchema } } },
    },
    responses: { 200: json(ApiNotificationSchema) },
  }),
  (c) => c.json(store().update(c.req.valid("param").id, c.req.valid("json")), 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/notifications/read",
    tags: ["Notifications"],
    summary: "Mark current notifications read across clients",
    request: {
      query: z.object({
        // Same sentinel as the list: `unassigned` marks notifications without a project.
        project_id: z.string().min(1).max(256).optional(),
      }),
    },
    responses: { 200: json(z.object({ ok: z.literal(true) })) },
  }),
  (c) => {
    const { project_id } = c.req.valid("query");
    store().markAllRead(
      project_id === undefined ? undefined : project_id === "unassigned" ? null : project_id,
    );
    return c.json({ ok: true as const }, 200);
  },
);

export { app as notificationsRouter };
