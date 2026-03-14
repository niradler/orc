import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { getGatewayManager, getGatewayStatus, sendGatewayMessage } from "@orc/gateway";

const app = new OpenAPIHono();

const GatewayStatusSchema = z
  .object({
    running: z.boolean(),
    status: z.string(),
  })
  .openapi("GatewayStatus");

const GatewaySendSchema = z
  .object({
    platform: z.string(),
    chat_id: z.string(),
    text: z.string(),
    thread_id: z.string().optional(),
  })
  .openapi("GatewaySend");

const statusRoute = createRoute({
  method: "get",
  path: "/gateway/status",
  tags: ["Gateway"],
  summary: "Get gateway status",
  responses: {
    200: {
      content: { "application/json": { schema: GatewayStatusSchema } },
      description: "Gateway status",
    },
  },
});

const sendRoute = createRoute({
  method: "post",
  path: "/gateway/send",
  tags: ["Gateway"],
  summary: "Send a message via the gateway",
  request: { body: { content: { "application/json": { schema: GatewaySendSchema } } } },
  responses: {
    204: { description: "Message sent" },
    503: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Gateway not running",
    },
  },
});

app.openapi(statusRoute, async (c) => {
  const running = getGatewayManager() !== null;
  return c.json({ running, status: getGatewayStatus() });
});

app.openapi(sendRoute, async (c) => {
  if (!getGatewayManager()) {
    return c.json({ error: "Gateway is not running" }, 503);
  }
  const { platform, chat_id, text, thread_id } = c.req.valid("json");
  await sendGatewayMessage(
    platform,
    chat_id,
    text,
    thread_id ? { threadId: thread_id } : undefined,
  );
  return c.body(null, 204);
});

export { app as gatewayRouter };
