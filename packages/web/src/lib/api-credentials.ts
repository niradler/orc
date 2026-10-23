import type { ChatSettings } from "@orc/core/chat";

const STORAGE_PREFIX = "orc_api_secret:";
export const API_ACCESS_CHANGED = "orc-api-access-changed";
let current: { url: string; secret: string } | undefined;

function storageKey(apiUrl: string): string {
  return `${STORAGE_PREFIX}${new URL(apiUrl, window.location.href).href.replace(/\/$/, "")}`;
}

export function readApiSecret(apiUrl: string): string {
  const url = storageKey(apiUrl);
  if (current?.url === url) return current.secret;
  try {
    return localStorage.getItem(url) ?? "";
  } catch {
    return "";
  }
}

export function saveApiSecret(apiUrl: string, secret: string, remember: boolean): void {
  const url = storageKey(apiUrl);
  if (remember) localStorage.setItem(url, secret);
  else {
    try {
      localStorage.removeItem(url);
    } catch {
      /* Browser storage may be disabled. */
    }
  }
  try {
    localStorage.removeItem("orc_api_secret");
  } catch {
    /* Legacy storage may be unavailable. */
  }
  current = { url, secret };
}

export function forgetApiSecret(apiUrl: string): void {
  current = undefined;
  try {
    localStorage.removeItem(storageKey(apiUrl));
    localStorage.removeItem("orc_api_secret");
  } catch {
    // A blocked storage provider must not prevent the login prompt.
  }
}

export type WorkspacePreferences = {
  theme?: "dark" | "light";
  terminal_font?: string;
  chat?: ChatSettings;
};

export async function checkApiAccess(
  apiUrl: string,
  secret: string,
  signal?: AbortSignal,
): Promise<WorkspacePreferences | null> {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/settings`, {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
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
