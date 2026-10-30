import { createRoute, z } from "@hono/zod-openapi";
import { type ChannelService, getChannelService } from "@orc/channels";
import { channelProviders, slackManifest } from "@orc/channels/providers";
import { routeMessage } from "@orc/channels/routing";
import {
  ChannelReceiptSchema,
  ChannelSaveSchema,
  ChannelSendSchema,
  ChannelUpdateSchema,
  ChannelViewSchema,
} from "@orc/core/channels";
import { ValidationError } from "@orc/core/errors";
import { createRouter } from "../lib/router.js";

export function createChannelsRouter(service: () => ChannelService = getChannelService) {
  const app = createRouter();
  const id = z.object({ id: z.string().min(1).max(100) });
  const project = z.object({ project_id: z.string().min(1).max(100).optional() });
  const json = <T extends z.ZodType>(schema: T, description = "Channel result") => ({
    description,
    content: { "application/json": { schema } },
  });
  const pairing = z.object({
    id: z.string(),
    connection: z.string(),
    expires_at: z.number(),
    candidate: z.object({ chat_id: z.string(), user_id: z.string(), name: z.string() }).nullable(),
    confirmed: z.boolean(),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/channels/providers",
      tags: ["Channels"],
      responses: {
        200: json(
          z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              credentials: z.array(
                z.object({ key: z.string(), label: z.string(), env: z.string() }),
              ),
              documentation: z.string(),
              capabilities: z.record(z.string(), z.boolean()),
              setup: z.array(z.string()),
            }),
          ),
        ),
      },
    }),
    (c) =>
      c.json(
        channelProviders.map((p) => ({
          ...p,
          credentials: [...p.credentials],
          setup: [...p.setup],
        })),
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/channels/slack-manifest",
      tags: ["Channels"],
      responses: { 200: json(z.record(z.string(), z.unknown())) },
    }),
    (c) => c.json(slackManifest),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/channels",
      tags: ["Channels"],
      request: { query: project },
      responses: { 200: json(z.array(ChannelViewSchema)) },
    }),
    (c) => c.json(service().list(c.req.valid("query").project_id)),
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/channels/{id}",
      tags: ["Channels"],
      request: {
        params: id,
        body: { content: { "application/json": { schema: ChannelSaveSchema } } },
      },
      responses: { 200: json(ChannelViewSchema) },
    }),
    async (c) => {
      const input = c.req.valid("json");
      if (input.id !== c.req.valid("param").id)
        throw new ValidationError("Connection ID must match the URL");
      return c.json(await service().save(input));
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/channels/{id}/targets",
      tags: ["Channels"],
      request: { params: id, query: project },
      responses: { 200: json(z.array(ChannelViewSchema.shape.targets.element)) },
    }),
    (c) => {
      service().connection(c.req.valid("param").id);
      return c.json(
        getChannelService()
          .list(c.req.valid("query").project_id)
          .find((v) => v.id === c.req.valid("param").id)?.targets ?? [],
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/channels/{id}/verify",
      tags: ["Channels"],
      request: { params: id },
      responses: { 200: json(z.object({ id: z.string(), name: z.string() })) },
    }),
    async (c) => c.json(await service().verify(c.req.valid("param").id)),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/channels/{id}/pairings",
      tags: ["Channels"],
      request: { params: id },
      responses: {
        200: json(
          z.object({
            id: z.string(),
            url: z.string(),
            message: z.string(),
            expires_at: z.number(),
          }),
        ),
      },
    }),
    async (c) => c.json(await service().beginPairing(c.req.valid("param").id)),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/channels/pairings/{id}",
      tags: ["Channels"],
      request: { params: id },
      responses: { 200: json(pairing) },
    }),
    (c) => c.json(service().store.pairing(c.req.valid("param").id)),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/channels/pairings/{id}/confirm",
      tags: ["Channels"],
      request: { params: id },
      responses: { 200: json(ChannelViewSchema.shape.targets.element) },
    }),
    async (c) => c.json(await service().confirmPairing(c.req.valid("param").id)),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/channels/messages",
      tags: ["Channels"],
      request: { body: { content: { "application/json": { schema: ChannelSendSchema } } } },
      responses: { 200: json(ChannelReceiptSchema.extend({ warnings: z.array(z.string()) })) },
    }),
    async (c) => c.json(await service().send(c.req.valid("json"))),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/channels/messages/{id}",
      tags: ["Channels"],
      request: { params: id, query: project },
      responses: { 200: json(ChannelReceiptSchema) },
    }),
    (c) => c.json(service().get(c.req.valid("param").id, c.req.valid("query").project_id)),
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/channels/messages/{id}",
      tags: ["Channels"],
      request: {
        params: id,
        body: { content: { "application/json": { schema: ChannelUpdateSchema } } },
      },
      responses: { 200: json(ChannelReceiptSchema) },
    }),
    async (c) => c.json(await service().edit(c.req.valid("param").id, c.req.valid("json"))),
  );

  const probe = z
    .object({
      sender: z.string().max(100),
      chat: z.string().max(200),
      thread: z.string().max(200).optional(),
      text: z.string().max(100000),
      is_direct: z.boolean(),
      is_mention: z.boolean(),
      kind: z.enum(["message", "action"]).default("message"),
    })
    .strict();
  app.openapi(
    createRoute({
      method: "post",
      path: "/channels/{id}/route-test",
      tags: ["Channels"],
      summary: "Preview first matching rule without invoking an agent",
      request: { params: id, body: { content: { "application/json": { schema: probe } } } },
      responses: {
        200: json(
          z.object({
            authorized: z.boolean(),
            route_id: z.string().nullable(),
            action: z.unknown().nullable(),
          }),
        ),
      },
    }),
    (c) => {
      const connection = service().connection(c.req.valid("param").id);
      const input = c.req.valid("json");
      const target = connection.targets.find(
        (t) =>
          t.inbound &&
          t.chat_id === input.chat &&
          (!t.thread_id || t.thread_id === input.thread) &&
          t.user_ids.includes(input.sender),
      );
      const route = target
        ? routeMessage(connection.routes, {
            ...input,
            connection: connection.id,
            message_id: "preview",
          })
        : undefined;
      const allowed =
        route?.action.type !== "agent" ||
        !target?.project_ids.length ||
        target.project_ids.includes(route.action.project_id);
      return c.json({
        authorized: !!target,
        route_id: allowed ? (route?.id ?? null) : null,
        action: allowed ? (route?.action ?? null) : null,
      });
    },
  );

  return app;
}
export const channelsRouter = createChannelsRouter();
