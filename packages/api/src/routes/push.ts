import { createRoute, z } from "@hono/zod-openapi";
import {
  PushConfigSchema,
  PushDeviceSchema,
  PushDeviceUpdateSchema,
  PushSubscriptionInputSchema,
} from "@orc/core/push";
import { getSqlite } from "@orc/db/client";
import { PushStore } from "@orc/db/push";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";
import { sendPush, vapidPublicKey } from "../push/service.js";

const app = createRouter();
app.use("/push/*", bodyLimit({ maxSize: 8000 }));
const params = z.object({ id: z.string().min(1).max(128) });
const device = {
  200: {
    description: "Push device",
    content: { "application/json": { schema: PushDeviceSchema } },
  },
};

function store(): PushStore {
  return new PushStore(getSqlite());
}

app.openapi(
  createRoute({
    method: "get",
    path: "/push/config",
    tags: ["Push"],
    responses: {
      200: {
        description: "VAPID public key browsers subscribe with",
        content: { "application/json": { schema: PushConfigSchema } },
      },
    },
  }),
  (c) => c.json({ public_key: vapidPublicKey({ store: store(), fetch }) }, 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/push/subscriptions",
    tags: ["Push"],
    responses: {
      200: {
        description: "Registered push devices",
        content: { "application/json": { schema: z.array(PushDeviceSchema) } },
      },
    },
  }),
  (c) => c.json(store().list(), 200),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/push/subscriptions",
    tags: ["Push"],
    request: {
      body: { content: { "application/json": { schema: PushSubscriptionInputSchema } } },
    },
    responses: device,
  }),
  (c) => c.json(store().subscribe(c.req.valid("json")), 200),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/push/subscriptions/{id}",
    tags: ["Push"],
    request: {
      params,
      body: { content: { "application/json": { schema: PushDeviceUpdateSchema } } },
    },
    responses: device,
  }),
  (c) => c.json(store().updateTopics(c.req.valid("param").id, c.req.valid("json").topics), 200),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/push/subscriptions/{id}",
    tags: ["Push"],
    request: { params },
    responses: { 204: { description: "Device removed" } },
  }),
  (c) => {
    store().remove(c.req.valid("param").id);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/push/subscriptions/{id}/test",
    tags: ["Push"],
    request: { params },
    responses: {
      200: {
        description: "Delivery outcome",
        content: {
          "application/json": {
            schema: z.object({ sent: z.number(), failed: z.number(), expired: z.number() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const pushStore = store();
    const { id } = pushStore.get(c.req.valid("param").id);
    const result = await sendPush(
      null,
      { title: "ORC", body: "Notifications are working on this device.", url: "/", tag: "test" },
      id,
      { store: pushStore, fetch },
    );
    return c.json(result, 200);
  },
);

export { app as pushRouter };
