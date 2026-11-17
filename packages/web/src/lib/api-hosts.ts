/**
 * Saved ORC server targets for the browser dashboard. The desktop app manages its own single
 * target in `connection.json`, so these entries only apply when the page runs in a plain browser.
 *
 * `orc_api_url` remains the active address (the API client reads it for every request). A host is
 * just a saved address plus optional Authorization token and proxy headers; switching writes the
 * address and lets `API_ACCESS_CHANGED` reload the workspace.
 */

export const API_HOSTS_KEY = "orc_api_hosts";
export const API_URL_KEY = "orc_api_url";
export const API_ACTIVE_HOST_KEY = "orc_api_active_host";
export const API_PREVIOUS_URL_KEY = "orc_api_previous_url";
export const API_PREVIOUS_HOST_KEY = "orc_api_previous_host";
export const DEFAULT_API_URL = "/api";
export const CURRENT_HOST_ID = "__current__";

export type ApiHostHeader = { name: string; value: string };

export type ApiHost = {
  id: string;
  label: string;
  url: string;
  /** Revocable access token sent as `Authorization: Bearer …`. */
  token: string;
  headers: ApiHostHeader[];
};

export type ApiHostDraft = Omit<ApiHost, "id"> & { id?: string };

export const CURRENT_HOST: ApiHost = {
  id: CURRENT_HOST_ID,
  label: "Local",
  url: DEFAULT_API_URL,
  token: "",
  headers: [],
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Request headers the client owns. A saved proxy header must not replace them, or every write
 * loses its JSON content type and streams lose their `Accept`. Desktop blocks the same set.
 */
const BLOCKED_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "host",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** `crypto.randomUUID` needs a secure context; self-hosted dashboards on plain http do not have one. */
function newHostId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const baseUrl = (): string =>
  typeof window === "undefined" ? "http://localhost/" : window.location.href;

/** Absolute form used to compare addresses; invalid values fall back to their trimmed text. */
export function normalizeApiUrl(url: string): string {
  const trimmed = url.trim() || DEFAULT_API_URL;
  try {
    return new URL(trimmed, baseUrl()).href.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Stored form of an address: no trailing slash, so `${url}${path}` never doubles the separator. */
function canonicalApiUrl(url: string): string {
  return (url.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function isDesktopShell(): boolean {
  return (
    typeof window !== "undefined" && !!(window as Window & { orcDesktop?: unknown }).orcDesktop
  );
}

/** The active API address, matching `getApiUrl` in the client. */
export function readApiUrl(): string {
  if (typeof window === "undefined" || isDesktopShell()) return DEFAULT_API_URL;
  try {
    return canonicalApiUrl(localStorage.getItem(API_URL_KEY) ?? DEFAULT_API_URL);
  } catch {
    return DEFAULT_API_URL;
  }
}

export function writeApiUrl(url: string): void {
  if (typeof window === "undefined" || isDesktopShell()) return;
  const target = canonicalApiUrl(url);
  try {
    localStorage.setItem(API_URL_KEY, target);
  } catch {
    // Storage can be blocked; the address still applies for this page load.
  }
}

/** Saved hosts can share a URL with different tokens, so the active row is tracked by id. */
export function readActiveHostId(): string | null {
  if (typeof window === "undefined" || isDesktopShell()) return null;
  try {
    return localStorage.getItem(API_ACTIVE_HOST_KEY);
  } catch {
    return null;
  }
}

export function writeActiveHostId(id: string | null): void {
  if (typeof window === "undefined" || isDesktopShell()) return;
  try {
    if (id) localStorage.setItem(API_ACTIVE_HOST_KEY, id);
    else localStorage.removeItem(API_ACTIVE_HOST_KEY);
  } catch {
    // Storage can be blocked; headers then fall back to a URL match.
  }
}

/** Remembered so a server switch that needs sign-in can be undone from the login screen. */
export function readPreviousApiUrl(): string | null {
  if (typeof window === "undefined" || isDesktopShell()) return null;
  try {
    const value = localStorage.getItem(API_PREVIOUS_URL_KEY);
    return value && value !== readApiUrl() ? value : null;
  } catch {
    return null;
  }
}

export function writePreviousApiUrl(url: string): void {
  if (typeof window === "undefined" || isDesktopShell()) return;
  try {
    localStorage.setItem(API_PREVIOUS_URL_KEY, url);
  } catch {
    // Storage can be blocked; the previous server is then only available in this page load.
  }
}

/** Stores the active server before switching, including its id and therefore its headers. */
export function rememberApiHostSwitch(): void {
  if (typeof window === "undefined" || isDesktopShell()) return;
  writePreviousApiUrl(readApiUrl());
  try {
    localStorage.setItem(API_PREVIOUS_HOST_KEY, readActiveHostId() ?? CURRENT_HOST_ID);
  } catch {
    // Storage can be blocked; the URL still restores the previous server.
  }
}

/** Restores the address and saved host of the server that was active before the last switch. */
export function restorePreviousApiHost(): string | null {
  const url = readPreviousApiUrl();
  if (!url) return null;
  writeApiUrl(url);
  if (typeof window !== "undefined" && !isDesktopShell()) {
    try {
      writeActiveHostId(localStorage.getItem(API_PREVIOUS_HOST_KEY) ?? CURRENT_HOST_ID);
    } catch {
      writeActiveHostId(CURRENT_HOST_ID);
    }
  }
  return url;
}

function normalizeHeader(value: unknown): ApiHostHeader[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const name = text(record.name).trim();
  if (!name) return [];
  return [{ name, value: text(record.value) }];
}

function normalizeHost(value: unknown): ApiHost[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const id = text(record.id).trim();
  const url = text(record.url).trim();
  if (!id || !url) return [];
  const headers = Array.isArray(record.headers) ? record.headers.flatMap(normalizeHeader) : [];
  return [
    {
      id,
      label: text(record.label).trim() || url,
      url,
      token: text(record.token),
      headers: uniqueHeaders(headers),
    },
  ];
}

function uniqueHeaders(headers: ApiHostHeader[]): ApiHostHeader[] {
  const byName = new Map<string, ApiHostHeader>();
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), { name, value: header.value });
  }
  return [...byName.values()];
}

/** Saved hosts, excluding the built-in "Local" row. */
export function readApiHosts(): ApiHost[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(API_HOSTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap(normalizeHost) : [];
  } catch {
    return [];
  }
}

export function listApiHosts(): ApiHost[] {
  return [CURRENT_HOST, ...readApiHosts()];
}

function persist(hosts: ApiHost[]): boolean {
  try {
    localStorage.setItem(API_HOSTS_KEY, JSON.stringify(hosts));
    return true;
  } catch {
    return false;
  }
}

/** Creates or replaces a host. Returns the stored copy with its final id. */
export function saveApiHost(draft: ApiHostDraft): ApiHost {
  const host: ApiHost = {
    id: draft.id?.trim() || newHostId(),
    label: draft.label.trim() || canonicalApiUrl(draft.url),
    url: canonicalApiUrl(draft.url),
    token: draft.token.trim(),
    headers: uniqueHeaders(
      draft.headers
        .map((header) => ({ name: header.name.trim(), value: header.value }))
        .filter((header) => header.name && header.value),
    ),
  };
  const hosts = readApiHosts();
  const index = hosts.findIndex((item) => item.id === host.id);
  if (index === -1) hosts.push(host);
  else hosts[index] = host;
  if (!persist(hosts)) throw new Error("The host list could not be written to this browser.");
  return host;
}

/** Removes a saved host. Returns false when the browser refused the write. */
export function deleteApiHost(id: string): boolean {
  if (!persist(readApiHosts().filter((host) => host.id !== id))) return false;
  if (readActiveHostId() === id) writeActiveHostId(null);
  // A stale previous server would offer a target that no longer exists.
  try {
    if (localStorage.getItem(API_PREVIOUS_HOST_KEY) === id) {
      localStorage.removeItem(API_PREVIOUS_HOST_KEY);
      localStorage.removeItem(API_PREVIOUS_URL_KEY);
    }
  } catch {
    // Storage can be blocked; the fallback simply stays unavailable.
  }
  return true;
}

/** Addresses match after normalisation, which is how a saved row is found for the active URL. */
export function sameApiUrl(left: string, right: string): boolean {
  return normalizeApiUrl(left) === normalizeApiUrl(right);
}

export function findApiHost(url: string, hosts: ApiHost[] = listApiHosts()): ApiHost | undefined {
  const target = normalizeApiUrl(url);
  return hosts.find((host) => sameApiUrl(host.url, target));
}

/** The selected saved host, or a host at the active address for older links. */
export function activeApiHost(hosts: ApiHost[] = listApiHosts()): ApiHost | undefined {
  const url = readApiUrl();
  const id = readActiveHostId();
  if (id) {
    const selected = hosts.find((host) => host.id === id);
    if (selected && sameApiUrl(selected.url, url)) return selected;
  }
  return findApiHost(url, hosts);
}

/** Headers sent to the active server: its proxy headers plus the saved token. */
export function hostHeaders(host: ApiHost): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of host.headers) {
    const name = header.name.trim();
    if (!name || !header.value || BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = header.value;
  }
  const token = host.token.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Saved headers for `url`, which defaults to the active server. A host's token and proxy headers
 * are only released to the address they were saved for.
 */
export function activeApiHeaders(url: string = readApiUrl()): Record<string, string> {
  if (isDesktopShell() || !sameApiUrl(url, readApiUrl())) return {};
  const host = activeApiHost();
  return host ? hostHeaders(host) : {};
}

/** A plain-http remote address sends the token and proxy headers over the network in clear text. */
export function apiHostWarning(draft: Pick<ApiHost, "url">): string | null {
  const url = draft.url.trim();
  if (!/^http:\/\//i.test(url)) return null;
  try {
    const { hostname } = new URL(url);
    if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) return null;
  } catch {
    return null;
  }
  return "This address is not HTTPS, so its token and headers travel unencrypted.";
}

export function apiHostError(draft: Pick<ApiHost, "url" | "headers">): string | null {
  const url = draft.url.trim();
  if (!url) return "Enter the server URL.";
  if (!url.startsWith("/") && !/^https?:\/\//i.test(url))
    return "Use a relative API path or an http(s) server URL.";
  if (url === "/") return "Enter the API path, for example /api.";
  try {
    const parsed = new URL(url, baseUrl());
    if (parsed.search || parsed.hash)
      return "The server URL cannot include a query string or fragment.";
    if (url.startsWith("/") && !parsed.pathname.replace(/\/+$/, ""))
      return "Enter the API path, for example /api.";
  } catch {
    return "Enter a valid server URL.";
  }
  const seen = new Set<string>();
  for (const header of draft.headers) {
    const name = header.name.trim();
    if (!name) return "Each header needs a name.";
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
      return `“${name}” is not a valid header name.`;
    const key = name.toLowerCase();
    if (BLOCKED_HEADERS.has(key)) return `The ${name} header is managed by this dashboard.`;
    if (seen.has(key)) return `The ${name} header is listed twice.`;
    seen.add(key);
    if (/[\r\n]/.test(header.value)) return `The ${name} header value cannot have line breaks.`;
  }
  return null;
}
