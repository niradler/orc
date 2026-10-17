import { createRoute, z } from "@hono/zod-openapi";
import { loadConfig, updateGlobalConfig } from "@orc/core/config";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const PreferencesSchema = z
  .object({
    theme: z.enum(["dark", "light"]).optional(),
    terminal_font: z.string().trim().max(200).optional(),
  })
  .strict();
const response = {
  200: {
    description: "Persistent workspace preferences; credentials are never returned",
    content: { "application/json": { schema: PreferencesSchema } },
  },
};

app.openapi(
  createRoute({
    method: "get",
    path: "/settings",
    tags: ["System"],
    summary: "Read workspace preferences",
    responses: response,
  }),
  (c) => c.json(PreferencesSchema.parse(loadConfig().preferences)),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/settings",
    tags: ["System"],
    summary: "Persist workspace preferences in the global config file",
    request: { body: { content: { "application/json": { schema: PreferencesSchema } } } },
    responses: response,
  }),
  (c) => {
    const preferences = c.req.valid("json");
    const config = updateGlobalConfig((raw) => {
      const existing = PreferencesSchema.parse(raw.preferences ?? {});
      raw.preferences = { ...existing, ...preferences };
    });
    return c.json(PreferencesSchema.parse(config.preferences));
  },
);

export { app as settingsRouter };
