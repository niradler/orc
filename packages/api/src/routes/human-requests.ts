import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import {
  CommandRunSchema,
  HumanRequestInputSchema,
  HumanRequestSchema,
  HumanResponseSchema,
} from "@orc/core/human-requests";
import { getSqlite } from "@orc/db/client";
import { currentHumanRequest, HumanRequestStore } from "@orc/db/human-requests";
import { bodyLimit } from "hono/body-limit";
import { prepareCommand } from "../lib/command-request.js";
import { createRouter } from "../lib/router.js";

const app = createRouter();
app.use("/human-requests/*", bodyLimit({ maxSize: 80000 }));
app.use("/human-requests", bodyLimit({ maxSize: 80000 }));
const params = z.object({ id: z.string().min(1).max(128) });
const version = z.number().int().positive();
const response = {
  200: {
    description: "Human request",
    content: { "application/json": { schema: HumanRequestSchema } },
  },
};
function store(): HumanRequestStore {
  return new HumanRequestStore(getSqlite());
}

function current(id: string) {
  return currentHumanRequest(store(), id);
}

app.openapi(
  createRoute({
    method: "get",
    path: "/human-requests",
    tags: ["Human requests"],
    responses: {
      200: {
        description: "Attention needed: pending requests and undelivered answers",
        content: { "application/json": { schema: z.array(HumanRequestSchema) } },
      },
    },
  }),
  (c) =>
    c.json(
      store()
        .list()
        .map((request) => current(request.id))
        .filter((request) =>
          ["pending", "running", "answered", "unavailable"].includes(request.status),
        ),
      200,
    ),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/human-requests",
    tags: ["Human requests"],
    request: { body: { content: { "application/json": { schema: HumanRequestInputSchema } } } },
    responses: response,
  }),
  (c) => c.json(store().create(c.req.valid("json")), 200),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/human-requests/{id}",
    tags: ["Human requests"],
    request: { params },
    responses: response,
  }),
  (c) => {
    const owner = c.req.header("X-ORC-Human-Owner");
    if (owner) store().heartbeat(c.req.valid("param").id, z.string().uuid().parse(owner));
    const request = current(c.req.valid("param").id);
    if (owner && request.status === "answered") store().responseFetched(request.id, owner);
    return c.json(request, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/human-requests/{id}/respond",
    tags: ["Human requests"],
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ version, response: HumanResponseSchema }).strict(),
          },
        },
      },
    },
    responses: response,
  }),
  (c) => {
    const input = c.req.valid("json");
    current(c.req.valid("param").id);
    return c.json(store().respond(c.req.valid("param").id, input.version, input.response), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/human-requests/{id}/run",
    tags: ["Human requests"],
    request: { params, body: { content: { "application/json": { schema: CommandRunSchema } } } },
    responses: response,
  }),
  async (c) => {
    const input = c.req.valid("json");
    const id = c.req.valid("param").id;
    const prepared = await prepareCommand(current(id), input);
    const claimed = store().claimCommand(id, input.version);
    changes.publish("human-requests");
    const result = await prepared.execute();
    const completed = store().completeCommand(id, claimed.version, result);
    changes.publish("human-requests");
    return c.json(completed, 200);
  },
);

for (const operation of ["acknowledge", "cancel"] as const) {
  app.openapi(
    createRoute({
      method: "post",
      path: `/human-requests/{id}/${operation}`,
      tags: ["Human requests"],
      request: {
        params,
        body: { content: { "application/json": { schema: z.object({ version }).strict() } } },
      },
      responses: response,
    }),
    (c) => c.json(store()[operation](c.req.valid("param").id, c.req.valid("json").version), 200),
  );
}

export { app as humanRequestsRouter };
