import { UnauthorizedError } from "@orc/core/errors";
import type { MiddlewareHandler } from "hono";

// Health checks must work without credentials so container/orchestrator probes
// (e.g. the Docker HEALTHCHECK) don't break when a secret is configured.
const PUBLIC_PATHS = new Set(["/health", "/api/health"]);

export function bearerAuth(secret: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!secret) return next();
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== secret) {
      throw new UnauthorizedError();
    }
    return next();
  };
}
