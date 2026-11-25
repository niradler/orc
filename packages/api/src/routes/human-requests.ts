import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import { loadConfig } from "@orc/core/config";
import { hostAlias, resolveExecHost } from "@orc/core/exec-host";
import {
  CommandRunSchema,
  HumanRequestInputSchema,
  HumanRequestSchema,
  HumanRequestSnoozeSchema,
  HumanRespondPayloadSchema,
  SecretClaimResultSchema,
} from "@orc/core/human-requests";
import { getSqlite } from "@orc/db/client";
import { currentHumanRequest, HumanRequestStore } from "@orc/db/human-requests";
import { bodyLimit } from "hono/body-limit";
import { auditActor } from "../lib/audit-actor.js";
import { prepareCommand } from "../lib/command-request.js";
import { createRouter } from "../lib/router.js";
import { selectedTerminalHost } from "../terminals/host.js";

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
        description: "Notifications: pending requests and undelivered answers",
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
  (c) => {
    const input = c.req.valid("json");
    const command = input.command;
    // Pin the host at creation: omitted means the global default, and unknown aliases never queue.
    if (input.kind === "command" && command) {
      const config = loadConfig();
      command.host =
        command.host === undefined
          ? hostAlias(resolveExecHost(config))
          : hostAlias(selectedTerminalHost(config, command.host));
    }
    return c.json(store().create(input), 200);
  },
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
    const { id } = c.req.valid("param");
    const request = current(id);
    if (request.status !== "answered") return c.json(request, 200);
    if (request.input.kind === "secret") return c.json(request, 200);
    if (store().seen(id)) changes.publish("human-requests");
    if (owner) store().responseFetched(id, owner);
    return c.json(current(id), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/human-requests/{id}/claim",
    tags: ["Human requests"],
    summary: "Claim one-time secret response values or saved references",
    request: { params },
    responses: {
      200: {
        description: "One-time secret delivery payload",
        content: { "application/json": { schema: SecretClaimResultSchema } },
      },
    },
  }),
  (c) => {
    const owner = c.req.header("X-ORC-Human-Owner");
    const { id } = c.req.valid("param");
    if (owner) store().heartbeat(id, z.string().uuid().parse(owner));
    current(id);
    const claimed = store().claimSecret(id);
    if (owner) store().responseFetched(id, owner);
    changes.publish("human-requests");
    c.header("Cache-Control", "no-store");
    return c.json(claimed, 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/human-requests/{id}/view",
    tags: ["Human requests"],
    summary: "View request details without acknowledging that its agent read the response",
    request: { params },
    responses: response,
  }),
  (c) => c.json(current(c.req.valid("param").id), 200),
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
            schema: z.object({ version, response: HumanRespondPayloadSchema }).strict(),
          },
        },
      },
    },
    responses: response,
  }),
  (c) => {
    const input = c.req.valid("json");
    const { id } = c.req.valid("param");
    current(id);
    const updated = store().respond(id, input.version, input.response, auditActor(c));
    changes.publish("human-requests", "notifications");
    if (input.response.kind === "secret" && input.response.save_to_project) {
      changes.publish("project-secrets");
    }
    c.header("Cache-Control", "no-store");
    return c.json(updated, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/human-requests/{id}/snooze",
    tags: ["Human requests"],
    summary:
      "Snooze a pending request until a future timestamp without changing its status or expiry",
    request: {
      params,
      body: { content: { "application/json": { schema: HumanRequestSnoozeSchema } } },
    },
    responses: response,
  }),
  (c) => {
    const input = c.req.valid("json");
    const id = c.req.valid("param").id;
    current(id);
    const until =
      input.until !== undefined ? input.until : Date.now() + (input.after_seconds ?? 0) * 1000;
    const updated = store().snooze(id, input.version, until);
    changes.publish("human-requests", "notifications");
    return c.json(updated, 200);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/human-requests/{id}/snooze",
    tags: ["Human requests"],
    summary: "Wake a snoozed pending request immediately",
    request: {
      params,
      query: z.object({ version: z.coerce.number().int().positive().optional() }),
    },
    responses: response,
  }),
  (c) => {
    const id = c.req.valid("param").id;
    current(id);
    const updated = store().unsnooze(id, c.req.valid("query").version);
    changes.publish("human-requests", "notifications");
    return c.json(updated, 200);
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
    changes.publish("human-requests", "notifications");
    const result = await prepared.execute();
    const completed = store().completeCommand(id, claimed.version, result);
    changes.publish("human-requests", "notifications");
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
    (c) => {
      const updated = store()[operation](c.req.valid("param").id, c.req.valid("json").version);
      changes.publish("human-requests", "notifications");
      return c.json(updated, 200);
    },
  );
}

export { app as humanRequestsRouter };
