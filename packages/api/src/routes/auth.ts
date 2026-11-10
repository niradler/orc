import { createRoute, z } from "@hono/zod-openapi";
import { configuredApiSecret, loadConfig } from "@orc/core/config";
import { UnauthorizedError, ValidationError } from "@orc/core/errors";
import type { Context } from "hono";
import {
  browserSessionExpiry,
  endBrowserSession,
  issueAccessToken,
  secretMatches,
  startBrowserSession,
  tokenExpiry,
} from "../lib/access-tokens.js";
import { recordAudit } from "../lib/audit-actor.js";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const SignInSchema = z.object({
  secret: z.string().min(1).max(4096),
  expires_at: z
    .number()
    .int()
    .optional()
    .describe("Unix seconds; defaults to api.session_days from now, at most 365 days"),
});
const SessionSchema = z
  .object({
    required: z.boolean().describe("False when the server has no API secret configured"),
    signed_in: z.boolean().describe("True when no secret is required or the cookie is valid"),
    expires_at: z.number().nullable().describe("Unix seconds when the session expires"),
    default_expires_at: z
      .number()
      .describe("Expiry a sign-in gets without expires_at, from api.session_days"),
  })
  .openapi("BrowserSession");
const AccessTokenSchema = z
  .object({ token: z.string(), expires_at: z.number() })
  .openapi("AccessToken");

const FAILED_AUDIT_INTERVAL_MS = 60_000;
let lastFailedAudit = 0;

// Failures are sampled to one per minute so guessing the secret cannot flood the audit log.
function verifiedSecret(c: Context, candidate: string, method: "session" | "token") {
  const required = configuredApiSecret(loadConfig().api.secret);
  if (required && !secretMatches(candidate, required)) {
    const now = Date.now();
    if (now - lastFailedAudit >= FAILED_AUDIT_INTERVAL_MS) {
      lastFailedAudit = now;
      recordAudit(c, { action: "auth.sign_in_failed", subject_ids: [], snapshot: { method } });
    }
    throw new UnauthorizedError();
  }
  return required;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/auth/session",
    tags: ["System"],
    summary: "Read the web UI session",
    description: "Public: tells the web UI whether it must sign in and when its cookie expires.",
    responses: {
      200: {
        description: "Session state",
        content: { "application/json": { schema: SessionSchema } },
      },
    },
  }),
  async (c) => {
    const required = configuredApiSecret(loadConfig().api.secret);
    const expires_at = required ? await browserSessionExpiry(c, required) : null;
    return c.json(
      {
        required: Boolean(required),
        signed_in: !required || expires_at !== null,
        expires_at,
        default_expires_at: tokenExpiry(),
      },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/auth/session",
    tags: ["System"],
    summary: "Sign the web UI in with the API secret",
    description:
      "Verifies the API secret and sets an HttpOnly signed session cookie that lasts until expires_at, so the browser never stores the secret.",
    request: { body: { content: { "application/json": { schema: SignInSchema } } } },
    responses: {
      200: {
        description: "Signed in",
        content: { "application/json": { schema: SessionSchema } },
      },
      400: { description: "Expiry outside the allowed range" },
      401: { description: "Incorrect secret" },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const required = verifiedSecret(c, body.secret, "session");
    const default_expires_at = tokenExpiry();
    if (!required)
      return c.json(
        { required: false, signed_in: true, expires_at: null, default_expires_at },
        200,
      );
    const exp = tokenExpiry(body.expires_at);
    await startBrowserSession(c, required, exp);
    recordAudit(c, {
      action: "auth.signed_in",
      subject_ids: [],
      snapshot: { method: "session", expires_at: exp },
    });
    return c.json({ required: true, signed_in: true, expires_at: exp, default_expires_at }, 200);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/auth/session",
    tags: ["System"],
    summary: "Sign the web UI out",
    responses: { 204: { description: "Session cookie cleared" } },
  }),
  (c) => {
    endBrowserSession(c);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/auth/token",
    tags: ["System"],
    summary: "Create an API access token",
    description:
      "Exchanges the API secret for a signed token that works as a Bearer credential until expires_at. Rotating the API secret revokes every token.",
    request: { body: { content: { "application/json": { schema: SignInSchema } } } },
    responses: {
      200: {
        description: "Token created",
        content: { "application/json": { schema: AccessTokenSchema } },
      },
      400: { description: "No API secret configured, or expiry outside the allowed range" },
      401: { description: "Incorrect secret" },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const required = verifiedSecret(c, body.secret, "token");
    if (!required)
      throw new ValidationError("This server has no API secret, so no token is needed.");
    const exp = tokenExpiry(body.expires_at);
    const token = await issueAccessToken(required, exp);
    recordAudit(c, {
      action: "auth.token_issued",
      subject_ids: [],
      snapshot: { expires_at: exp },
    });
    return c.json({ token, expires_at: exp }, 200);
  },
);

export { app as authRouter };
