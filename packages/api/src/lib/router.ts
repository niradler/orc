import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Every API router. Request validation failures answer with the same `{ error, code }` body as
 * every other API error, so clients can show why a request was rejected.
 */
export function createRouter(): OpenAPIHono {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json({ error: z.prettifyError(result.error), code: "VALIDATION_ERROR" }, 400);
    },
  });
}
