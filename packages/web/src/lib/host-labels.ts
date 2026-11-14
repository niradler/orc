import { readApiUrl } from "@/lib/api-hosts";

/** The machine running the connected ORC server, which can differ from the browser's machine. */
export const THIS_SERVER = "This ORC server";

/** Address the dashboard reaches ORC on, so "this server" is concrete for a remote install. */
export function orcServerAddress(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URL(readApiUrl(), window.location.href).host || null;
  } catch {
    return null;
  }
}
