import { configuredApiSecret } from "@orc/core/config";
import { UnauthorizedError } from "@orc/core/errors";
import { SESSION_SYNC_PATH_PATTERN } from "@orc/core/session-archive";
import { HANDOFF_UPLOAD_PATH_PATTERN } from "@orc/core/session-handoff";
import { SKILL_DOWNLOAD_PATH_PATTERN } from "@orc/core/skill-download";
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
    // This GET validates a signed, expiring, one-file capability in its handler.
    if (c.req.method === "GET" && SKILL_DOWNLOAD_PATH_PATTERN.test(c.req.path)) return next();
    // Only these upload/manifest/project-discovery routes validate a scoped sync capability.
    if (
      SESSION_SYNC_PATH_PATTERN.test(c.req.path) &&
      ((c.req.method === "POST" && /\/(upload|manifest)$/.test(c.req.path)) ||
        (c.req.method === "GET" && c.req.path.endsWith("/projects")))
    )
      return next();
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== required) {
      throw new UnauthorizedError();
    }
    return next();
  };
}
