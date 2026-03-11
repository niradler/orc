import { UnauthorizedError } from "@orc/core/errors";
import type { MiddlewareHandler } from "hono";

export function bearerAuth(secret: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!secret) return next();
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== secret) {
      throw new UnauthorizedError();
    }
    return next();
  };
}
