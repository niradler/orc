import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import { deriveSecretKey } from "@orc/core/secrets";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";

/**
 * Signing in with the API secret yields a JWT with an expiry the consumer picks: the web UI holds
 * it in an HttpOnly cookie, API clients send it as a Bearer token. The signing key mixes the
 * machine key with the secret, so tokens survive restarts and rotating the secret revokes them all.
 */
export const SESSION_COOKIE = "orc_session";
export const MAX_TOKEN_DAYS = 365;
export const UI_SOURCE_HEADER = "X-Orc-Source";
const AUDIENCE = "orc";

const signingKey = (secret: string) =>
  deriveSecretKey(`orc-access-token:${secret}`).toString("base64url");

export function secretMatches(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Defaults to api.session_days from now; an explicit expiry must fall within a year. */
export function tokenExpiry(expiresAt?: number): number {
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt === undefined) return now + loadConfig().api.session_days * 86_400;
  if (expiresAt <= now + 60) throw new ValidationError("Choose an expiry in the future.");
  if (expiresAt > now + MAX_TOKEN_DAYS * 86_400)
    throw new ValidationError(`Tokens can last at most ${MAX_TOKEN_DAYS} days.`);
  return expiresAt;
}

export function issueAccessToken(secret: string, exp: number): Promise<string> {
  return sign(
    { aud: AUDIENCE, iat: Math.floor(Date.now() / 1000), exp },
    signingKey(secret),
    "HS256",
  );
}

/** The token's expiry in Unix seconds, or null when it is forged, expired or from an old secret. */
export async function accessTokenExpiry(token: string, secret: string): Promise<number | null> {
  try {
    const payload = await verify(token, signingKey(secret), { alg: "HS256", aud: AUDIENCE });
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Cross-origin web UIs need SameSite=None, which browsers accept only on Secure cookies. */
function cookieOptions(c: Context) {
  const crossOrigin = loadConfig().api.cors_origins.length > 0;
  const https =
    new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  return {
    httpOnly: true,
    path: "/",
    sameSite: crossOrigin ? ("None" as const) : ("Strict" as const),
    secure: crossOrigin || https,
  };
}

export async function startBrowserSession(c: Context, secret: string, exp: number): Promise<void> {
  const maxAge = exp - Math.floor(Date.now() / 1000);
  setCookie(c, SESSION_COOKIE, await issueAccessToken(secret, exp), {
    ...cookieOptions(c),
    maxAge,
  });
}

export function endBrowserSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c));
}

export async function browserSessionExpiry(c: Context, secret: string): Promise<number | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? accessTokenExpiry(token, secret) : null;
}

/**
 * SameSite does not cover other ports on the same host, so a cookie request that changes state
 * must carry the UI's custom header: browsers send one cross-origin only after a CORS preflight,
 * which succeeds only for api.cors_origins. Listed origins are also checked directly.
 */
export function cookieWriteAllowed(c: Context): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return true;
  if (!c.req.header(UI_SOURCE_HEADER)) return false;
  const origins = loadConfig().api.cors_origins;
  const origin = c.req.header("origin");
  if (!origins.length || !origin) return true;
  if (origins.includes(origin)) return true;
  try {
    return new URL(origin).host === c.req.header("host");
  } catch {
    return false;
  }
}
