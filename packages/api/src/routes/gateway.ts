import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

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

type GatewayModule = {
  getGatewayManager: () => unknown;
  getGatewayStatus: () => string;
  sendGatewayMessage: (
    platform: string,
    chatId: string,
    text: string,
    opts?: { threadId?: string },
  ) => Promise<void>;
};

app.openapi(statusRoute, async (c) => {
  const gw = (await import("@orc/gateway" as string)) as GatewayModule;
  const running = gw.getGatewayManager() !== null;
  return c.json({ running, status: gw.getGatewayStatus() });
});

app.openapi(sendRoute, async (c) => {
  const gw = (await import("@orc/gateway" as string)) as GatewayModule;
  if (!gw.getGatewayManager()) {
    return c.json({ error: "Gateway is not running" }, 503);
  }
  const { platform, chat_id, text, thread_id } = c.req.valid("json");
  await gw.sendGatewayMessage(platform, chat_id, text, thread_id ? { threadId: thread_id } : undefined);
  return c.body(null, 204);
});

export { app as gatewayRouter };
