import type { ChatSettings } from "@orc/core/chat";

export const API_ACCESS_CHANGED = "orc-api-access-changed";
const LEGACY_SECRET_PREFIX = "orc_api_secret";

export type BrowserSession = {
  required: boolean;
  signed_in: boolean;
  expires_at: number | null;
  default_expires_at: number;
};

export type WorkspacePreferences = {
  attention_retention_hours?: number;
  notification_retention_days?: number;
  audit_retention_days?: number;
  theme?: "dark" | "light";
  terminal_font?: string;
  chat?: ChatSettings;
  agents?: string[];
};

const endpoint = (apiUrl: string, path: string) => `${apiUrl.replace(/\/$/, "")}${path}`;

/** The session cookie is HttpOnly; `include` also sends it to an API on another allowed origin. */
export async function readBrowserSession(
  apiUrl: string,
  signal?: AbortSignal,
): Promise<BrowserSession> {
  const response = await fetch(endpoint(apiUrl, "/auth/session"), {
    credentials: "include",
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not connect to the ORC API. Try again.");
  return (await response.json()) as BrowserSession;
}

/** Returns false for a wrong secret; the secret itself is never stored. */
export async function signIn(apiUrl: string, secret: string, expiresAt?: number): Promise<boolean> {
  const response = await fetch(endpoint(apiUrl, "/auth/session"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, ...(expiresAt ? { expires_at: expiresAt } : {}) }),
  });
  if (response.status === 401) return false;
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not sign in. Try again.");
  }
  return true;
}

export async function signOut(apiUrl: string): Promise<void> {
  await fetch(endpoint(apiUrl, "/auth/session"), { method: "DELETE", credentials: "include" });
  window.dispatchEvent(new Event(API_ACCESS_CHANGED));
}

/**
 * Earlier builds kept the API secret in localStorage. Exchange it for a session cookie once and
 * delete every copy, so upgrading does not sign anyone out and no secret stays in the browser.
 */
export async function migrateStoredSecret(apiUrl: string): Promise<void> {
  let secret = "";
  try {
    const own = `${LEGACY_SECRET_PREFIX}:${new URL(apiUrl, window.location.href).href.replace(/\/$/, "")}`;
    secret = localStorage.getItem(own) ?? localStorage.getItem(LEGACY_SECRET_PREFIX) ?? "";
    for (const key of Object.keys(localStorage))
      if (key.startsWith(LEGACY_SECRET_PREFIX)) localStorage.removeItem(key);
  } catch {
    return;
  }
  if (secret) await signIn(apiUrl, secret).catch(() => false);
}

export async function checkApiAccess(
  apiUrl: string,
  signal?: AbortSignal,
): Promise<WorkspacePreferences | null> {
  const response = await fetch(endpoint(apiUrl, "/settings"), {
    credentials: "include",
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Could not connect to the ORC API. Try again.");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("The server did not return an ORC access check. Check the API connection.");
  const preferences = body as WorkspacePreferences;
  if (
    (preferences.theme !== undefined &&
      preferences.theme !== "dark" &&
      preferences.theme !== "light") ||
    (preferences.terminal_font !== undefined && typeof preferences.terminal_font !== "string")
  )
    throw new Error("The server returned invalid workspace preferences.");
  return preferences;
}

/** Date input value (YYYY-MM-DD, local) for a Unix time, and the end of that local day back. */
export const toDateInput = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const endOfDateInput = (value: string) =>
  Math.floor(new Date(`${value}T23:59:59`).getTime() / 1000);

/** A Bearer token for scripts and other API clients; the server returns it once and keeps no copy. */
export async function createAccessToken(
  apiUrl: string,
  secret: string,
  expiresAt: number,
): Promise<{ token: string; expires_at: number }> {
  const response = await fetch(endpoint(apiUrl, "/auth/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, expires_at: expiresAt }),
  });
  const body = (await response.json().catch(() => null)) as {
    token: string;
    expires_at: number;
    error?: string;
  } | null;
  if (response.status === 401) throw new Error("Incorrect API secret.");
  if (!response.ok || !body) throw new Error(body?.error ?? "Could not create a token. Try again.");
  return body;
}
