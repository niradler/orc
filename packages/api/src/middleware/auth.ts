import { configuredApiSecret } from "@orc/core/config";
import { ForbiddenError, UnauthorizedError } from "@orc/core/errors";
import { SCRATCHPAD_CONTENT_PATH_PATTERN } from "@orc/core/scratchpad";
import { SESSION_SYNC_PATH_PATTERN } from "@orc/core/session-archive";
import { HANDOFF_UPLOAD_PATH_PATTERN } from "@orc/core/session-handoff";
import { SKILL_DOWNLOAD_PATH_PATTERN } from "@orc/core/skill-download";
import type { MiddlewareHandler } from "hono";
import {
  accessTokenExpiry,
  browserSessionExpiry,
  cookieWriteAllowed,
  secretMatches,
} from "../lib/access-tokens.js";

// Health checks must work without credentials so container/orchestrator probes
// (e.g. the Docker HEALTHCHECK) don't break when a secret is configured.
// The sign-in routes verify the secret themselves (or only clear a cookie).
const PUBLIC_PATHS = new Set(["/health", "/api/health", "/api/auth/session", "/api/auth/token"]);

export function bearerAuth(secret: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    const required = configuredApiSecret(secret);
    if (!required) return next();
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    // Only this PUT accepts an upload capability; its handler validates expiry and single use.
    if (c.req.method === "PUT" && HANDOFF_UPLOAD_PATH_PATTERN.test(c.req.path)) return next();
    // This GET validates a signed, expiring, one-file capability in its handler.
    if (c.req.method === "GET" && SKILL_DOWNLOAD_PATH_PATTERN.test(c.req.path)) return next();
    // This GET/PUT validates a signed, expiring, one-pad capability in its handler; a PUT is
    // bound to the revision it was minted at, so a replay is a 409.
    if (
      (c.req.method === "GET" || c.req.method === "PUT") &&
      SCRATCHPAD_CONTENT_PATH_PATTERN.test(c.req.path)
    )
      return next();
    // Only these upload/manifest/project-discovery routes validate a scoped sync capability.
    if (
      SESSION_SYNC_PATH_PATTERN.test(c.req.path) &&
      ((c.req.method === "POST" && /\/(upload|manifest)$/.test(c.req.path)) ||
        (c.req.method === "GET" && c.req.path.endsWith("/projects")))
    )
      return next();
    const auth = c.req.header("Authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (
      bearer &&
      (secretMatches(bearer, required) || (await accessTokenExpiry(bearer, required)) !== null)
    )
      return next();
    if ((await browserSessionExpiry(c, required)) !== null) {
      if (!cookieWriteAllowed(c)) throw new ForbiddenError("Cross-site request refused");
      return next();
    }
    throw new UnauthorizedError();
  };
}
