import { configuredApiSecret } from "@orc/core/config";
import { UnauthorizedError } from "@orc/core/errors";
import { HANDOFF_UPLOAD_PATH_PATTERN } from "@orc/core/session-handoff";
import type { MiddlewareHandler } from "hono";

// Health checks must work without credentials so container/orchestrator probes
// (e.g. the Docker HEALTHCHECK) don't break when a secret is configured.
const PUBLIC_PATHS = new Set(["/health", "/api/health"]);

export function bearerAuth(secret: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const required = configuredApiSecret(secret);
    if (!required) return next();
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    // Only this PUT accepts an upload capability; its handler validates expiry and single use.
    if (c.req.method === "PUT" && HANDOFF_UPLOAD_PATH_PATTERN.test(c.req.path)) return next();
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== required) {
      throw new UnauthorizedError();
    }
    return next();
  };
}
