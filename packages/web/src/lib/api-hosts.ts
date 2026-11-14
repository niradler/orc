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
  label: "This ORC server",
  url: DEFAULT_API_URL,
  token: "",
  headers: [],
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const baseUrl = (): string =>
  typeof window === "undefined" ? "http://localhost/" : window.location.href;

/** Absolute form used to compare addresses; invalid values fall back to their trimmed text. */
export function normalizeApiUrl(url: string): string {
  const trimmed = url.trim() || DEFAULT_API_URL;
  try {
    return new URL(trimmed, baseUrl()).href.replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
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
    return localStorage.getItem(API_URL_KEY) ?? DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

export function writeApiUrl(url: string): void {
  if (typeof window === "undefined" || isDesktopShell()) return;
  const target = url.trim() || DEFAULT_API_URL;
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

/** Saved hosts, excluding the built-in "This ORC server" row. */
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

function persist(hosts: ApiHost[]): void {
  try {
    localStorage.setItem(API_HOSTS_KEY, JSON.stringify(hosts));
  } catch {
    // Ignore quota or privacy-mode failures; the in-memory settings still work.
  }
}

/** Creates or replaces a host. Returns the stored copy with its final id. */
export function saveApiHost(draft: ApiHostDraft): ApiHost {
  const host: ApiHost = {
    id: draft.id?.trim() || crypto.randomUUID(),
    label: draft.label.trim() || draft.url.trim(),
    url: draft.url.trim(),
    token: draft.token.trim(),
    headers: uniqueHeaders(
      draft.headers
        .map((header) => ({ name: header.name.trim(), value: header.value }))
        .filter((header) => header.name),
    ),
  };
  const hosts = readApiHosts();
  const index = hosts.findIndex((item) => item.id === host.id);
  if (index === -1) hosts.push(host);
  else hosts[index] = host;
  persist(hosts);
  return host;
}

export function deleteApiHost(id: string): void {
  persist(readApiHosts().filter((host) => host.id !== id));
  if (readActiveHostId() === id) writeActiveHostId(null);
}

export function findApiHost(url: string, hosts: ApiHost[] = listApiHosts()): ApiHost | undefined {
  const target = normalizeApiUrl(url);
  return hosts.find((host) => normalizeApiUrl(host.url) === target);
}

/** The selected saved host, or a host at the active address for older links. */
export function activeApiHost(hosts: ApiHost[] = listApiHosts()): ApiHost | undefined {
  const url = readApiUrl();
  const id = readActiveHostId();
  if (id) {
    const selected = hosts.find((host) => host.id === id);
    if (selected && normalizeApiUrl(selected.url) === normalizeApiUrl(url)) return selected;
  }
  return findApiHost(url, hosts);
}

/** Headers sent to the active server: its proxy headers plus the saved token. */
export function hostHeaders(host: ApiHost): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of host.headers) {
    const name = header.name.trim();
    if (!name || !header.value) continue;
    headers[name] = header.value;
  }
  const token = host.token.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function activeApiHeaders(): Record<string, string> {
  if (isDesktopShell()) return {};
  const host = activeApiHost();
  return host ? hostHeaders(host) : {};
}

export function apiHostError(draft: Pick<ApiHost, "url" | "headers">): string | null {
  const url = draft.url.trim();
  if (!url) return "Enter the server URL.";
  if (!url.startsWith("/") && !/^https?:\/\//i.test(url))
    return "Use a relative API path or an http(s) server URL.";
  try {
    new URL(url, baseUrl());
  } catch {
    return "Enter a valid server URL.";
  }
  for (const header of draft.headers) {
    const name = header.name.trim();
    if (!name) return "Each header needs a name.";
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name))
      return `“${name}” is not a valid header name.`;
    if (/[\r\n]/.test(header.value)) return `The ${name} header value cannot contain a line break.`;
  }
  return null;
}
