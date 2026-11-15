import { DEFAULT_API_URL, readApiUrl } from "@/lib/api-hosts";

/** The machine running the connected ORC server, which can differ from the browser's machine. */
export const THIS_SERVER = "Local";

function addressOf(url: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URL(url, window.location.href).host || null;
  } catch {
    return null;
  }
}

/** Address the dashboard reaches the connected ORC server on, so "this server" stays concrete. */
export function orcServerAddress(): string | null {
  return addressOf(readApiUrl());
}

/**
 * Address of the dashboard's own origin, which is where the built-in "Local" row points
 * even while a saved remote server is the active target.
 */
export function defaultServerAddress(): string | null {
  return addressOf(DEFAULT_API_URL);
}
