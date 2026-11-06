import { createRoute, z } from "@hono/zod-openapi";
import { sendTelegramToNir, telegramStatus } from "@orc/gateway";
import { createRouter } from "../lib/router.js";

const app = createRouter();

const recipient = z.object({
  name: z.string(),
  chat_id: z.string(),
  connection_id: z.string().nullable(),
  target_id: z.string().nullable(),
  project_ids: z.array(z.string()),
  enabled: z.boolean(),
  outbound: z.boolean(),
});

const statusSchema = z
  .object({
    ready: z.boolean(),
    via: z.enum(["channel", "gateway"]).nullable(),
    recipient: recipient.nullable(),
    recipients: z.array(recipient),
    token_configured: z.boolean(),
    setup: z.string().nullable(),
  })
  .openapi("TelegramStatus");

const sendResult = z
  .object({
    via: z.enum(["channel", "gateway"]),
    status: z.literal("accepted"),
    name: z.string(),
    chat_id: z.string(),
    connection_id: z.string().nullable(),
    target_id: z.string().nullable(),
    receipt_id: z.string().nullable(),
    provider_ids: z.array(z.string()),
    message_id: z.number().nullable(),
    warnings: z.array(z.string()),
  })
  .openapi("TelegramSendResult");

const statusRoute = createRoute({
  method: "get",
  path: "/telegram/status",
  tags: ["Telegram"],
  summary: "Whether Telegram can message Nir, without the bot token",
  request: {
    query: z.object({
      project_id: z.string().min(1).max(100).optional(),
      chat: z.string().min(1).max(200).optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: statusSchema } },
      description: "Telegram readiness and the recipient that would be used",
    },
  },
});

const sendBody = z
  .object({
    text: z.string().min(1).max(4096),
    chat: z.string().min(1).max(200).optional(),
    project_id: z.string().min(1).max(100).nullable().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .strict();

const sendRoute = createRoute({
  method: "post",
  path: "/telegram/send",
  tags: ["Telegram"],
  summary: "Send a message to Nir through Telegram",
  request: { body: { content: { "application/json": { schema: sendBody } } } },
  responses: {
    200: {
      content: { "application/json": { schema: sendResult } },
      description: "Telegram accepted the message",
    },
  },
});

app.openapi(statusRoute, (c) => {
  const query = c.req.valid("query");
  return c.json(
    telegramStatus({
      ...(query.project_id ? { projectId: query.project_id } : {}),
      ...(query.chat ? { chat: query.chat } : {}),
    }),
  );
});

app.openapi(sendRoute, async (c) => {
  const body = c.req.valid("json");
  return c.json(
    await sendTelegramToNir({
      text: body.text,
      ...(body.chat ? { chat: body.chat } : {}),
      ...(body.project_id ? { projectId: body.project_id } : {}),
      ...(body.idempotency_key ? { idempotencyKey: body.idempotency_key } : {}),
    }),
  );
});

export { app as telegramRouter };
