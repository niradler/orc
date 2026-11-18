import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ConnectionMode = "local" | "remote";

export type HeaderPair = { name: string; value: string };

export type SavedServer = {
  id: string;
  label: string;
  url: string;
  token?: string;
  headers?: HeaderPair[];
};

/** The desktop shell's saved remote servers and the one it opens; `active: null` is the local server. */
export type ConnectionSettings = {
  active: string | null;
  servers: SavedServer[];
};

export type ServerDraft = {
  id?: string;
  label?: string;
  url?: string;
  token?: string;
  clear_token?: boolean;
  headers?: HeaderPair[];
};

export type PublicServer = {
  id: string;
  label: string;
  url: string;
  has_token: boolean;
  headers: HeaderPair[];
};

export type PublicConnection = {
  mode: ConnectionMode;
  /** Which server this window is showing now, which differs while the local editor is open. */
  current: ConnectionMode;
  url: string;
  has_token: boolean;
  headers: HeaderPair[];
  editable: boolean;
  active: string | null;
  servers: PublicServer[];
};

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// These are owned by the HTTP client or carry the dashboard session, so a proxy
// header must not replace them. Authorization comes from the token field.
const BLOCKED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
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

export const localConnection = (): ConnectionSettings => ({ active: null, servers: [] });

export function activeServer(settings: ConnectionSettings): SavedServer | undefined {
  return settings.servers.find((server) => server.id === settings.active);
}

/** A full server address without a trailing slash or the API-only `/api` suffix. */
export function normalizeServerUrl(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Enter the remote server URL.");
  if (text.length > 2048) throw new Error("The remote server URL is too long.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter a full http:// or https:// server URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("The remote server URL must use http:// or https://.");
  if (url.username || url.password)
    throw new Error("Do not put a username or password in the server URL.");
  if (url.search || url.hash)
    throw new Error("The remote server URL cannot include a query string or fragment.");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "/api" ? "" : path;
  return url.toString().replace(/\/+$/, "");
}

/** Header values may use visible characters, but never a line break or control byte. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Drops empty rows and validates names before they reach Electron's request headers. */
export function normalizeHeaders(pairs: HeaderPair[] | undefined): HeaderPair[] {
  const seen = new Set<string>();
  const headers: HeaderPair[] = [];
  if ((pairs?.length ?? 0) > 32) throw new Error("Use at most 32 headers.");
  for (const pair of pairs ?? []) {
    const name = pair.name.trim();
    const value = pair.value.trim();
    if (!name && !value) continue;
    if (!name) throw new Error("Each header needs a name.");
    if (name.length > 256) throw new Error("A header name is too long.");
    if (value.length > 8192) throw new Error(`The ${name} header value is too long.`);
    if (!HEADER_NAME.test(name))
      throw new Error(
        `"${name}" is not a valid header name. Use letters, numbers and -_. symbols.`,
      );
    const key = name.toLowerCase();
    if (BLOCKED_HEADERS.has(key)) throw new Error(`The ${name} header cannot be set here.`);
    if (seen.has(key)) throw new Error(`The ${name} header is listed twice.`);
    if (hasControlCharacter(pair.value))
      throw new Error(`The ${name} header value cannot have line breaks or control characters.`);
    seen.add(key);
    headers.push({ name, value });
  }
  return headers;
}

/** IPC input is untrusted: keep only the fields and value types the form owns. */
export function parseServerDraft(input: unknown): ServerDraft {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid server settings.");
  const value = input as Record<string, unknown>;
  const headers = Array.isArray(value.headers)
    ? value.headers
        .filter(
          (pair): pair is HeaderPair =>
            Boolean(pair) &&
            typeof pair === "object" &&
            typeof (pair as HeaderPair).name === "string" &&
            typeof (pair as HeaderPair).value === "string",
        )
        .map((pair) => ({ name: pair.name, value: pair.value }))
    : [];
  return {
    ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
    label: typeof value.label === "string" ? value.label : "",
    url: typeof value.url === "string" ? value.url : "",
    token: typeof value.token === "string" ? value.token : "",
    clear_token: value.clear_token === true,
    headers,
  };
}

/** An HTTP(S) origin for a page or WebSocket URL, so both compare against the same initiator. */
export function webOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") return `http://${url.host}`;
    if (url.protocol === "wss:") return `https://${url.host}`;
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    return null;
  } catch {
    return null;
  }
}

export function appMicrophoneAllowed(
  url: string,
  appOrigin: string | null | undefined,
  mediaTypes: readonly string[],
): boolean {
  return (
    !!appOrigin &&
    webOrigin(url) === appOrigin &&
    mediaTypes.length > 0 &&
    mediaTypes.every((type) => type === "audio")
  );
}

/**
 * A request may carry a credential only when the document that issued it shares the
 * destination origin. Without an initiator the browser itself started the request,
 * such as the top-level document navigation, which does not need the credential.
 */
export function requestOrigin(initiator: string | undefined, url: string): string | null {
  const origin = webOrigin(url);
  return origin !== null && initiator === origin ? origin : null;
}

export function normalizeToken(value: string | undefined): string {
  const token = value?.trim() ?? "";
  if (token.length > 4096) throw new Error("The access token is too long.");
  if (hasControlCharacter(token)) throw new Error("The access token has invalid characters.");
  return token;
}

export function headerRecord(headers: HeaderPair[] = []): Record<string, string> {
  return Object.fromEntries(headers.map(({ name, value }) => [name.toLowerCase(), value]));
}

/** Replaces managed headers case-insensitively so a page cannot shadow the shell credential. */
export function mergeHeaders(
  existing: Record<string, string>,
  injected: Record<string, string>,
): Record<string, string> {
  const managed = new Set(Object.keys(injected).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(existing))
    if (!managed.has(name.toLowerCase())) merged[name] = value;
  return { ...merged, ...injected };
}

/** The token a draft should use: a new one, or the saved one while its address is unchanged. */
export function draftToken(
  draft: ServerDraft,
  saved: SavedServer | undefined,
  url: string,
): string {
  const supplied = normalizeToken(draft.token);
  if (supplied) return supplied;
  return saved && saved.url === url && !draft.clear_token ? (saved.token ?? "") : "";
}

/** Creates or replaces a saved server; a new one becomes the active target. */
export function applyServerDraft(
  draft: ServerDraft,
  current: ConnectionSettings,
): { settings: ConnectionSettings; server: SavedServer } {
  const saved = draft.id ? current.servers.find((server) => server.id === draft.id) : undefined;
  if (draft.id && !saved) throw new Error("That server is no longer saved.");
  const url = normalizeServerUrl(draft.url ?? "");
  const headers = normalizeHeaders(draft.headers);
  const token = draftToken(draft, saved, url);
  const label = (draft.label ?? "").trim() || new URL(url).host;
  if (label.length > 200) throw new Error("The server name is too long.");
  const server: SavedServer = {
    id: saved?.id ?? randomUUID(),
    label,
    url,
    ...(token ? { token } : {}),
    ...(headers.length ? { headers } : {}),
  };
  const servers = saved
    ? current.servers.map((item) => (item.id === server.id ? server : item))
    : [...current.servers, server];
  return { settings: { active: saved ? current.active : server.id, servers }, server };
}

export function selectServer(current: ConnectionSettings, id: string | null): ConnectionSettings {
  if (id !== null && !current.servers.some((server) => server.id === id))
    throw new Error("That server is no longer saved.");
  return { ...current, active: id };
}

export function removeServer(current: ConnectionSettings, id: string): ConnectionSettings {
  return {
    active: current.active === id ? null : current.active,
    servers: current.servers.filter((server) => server.id !== id),
  };
}

export function publicConnection(
  settings: ConnectionSettings,
  editable: boolean,
  current?: ConnectionMode,
): PublicConnection {
  const server = activeServer(settings);
  const mode = server ? "remote" : "local";
  return {
    mode,
    current: current ?? mode,
    url: server?.url ?? "",
    has_token: Boolean(server?.token),
    // A remote page must not learn the proxy headers, tokens or other servers saved here.
    headers: editable ? (server?.headers ?? []) : [],
    editable,
    active: settings.active,
    servers: editable
      ? settings.servers.map((item) => ({
          id: item.id,
          label: item.label,
          url: item.url,
          has_token: Boolean(item.token),
          headers: item.headers ?? [],
        }))
      : [],
  };
}

function readServer(raw: unknown, fallbackId: string): SavedServer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as {
    id?: unknown;
    label?: unknown;
    url?: unknown;
    token?: unknown;
    headers?: unknown;
  };
  if (typeof value.url !== "string") return null;
  let url: string;
  try {
    url = normalizeServerUrl(value.url);
  } catch {
    return null;
  }
  const headers = Array.isArray(value.headers)
    ? normalizeHeaders(
        value.headers.filter(
          (pair): pair is HeaderPair =>
            Boolean(pair) &&
            typeof pair === "object" &&
            typeof (pair as HeaderPair).name === "string" &&
            typeof (pair as HeaderPair).value === "string",
        ),
      )
    : [];
  const token = typeof value.token === "string" && value.token.trim() ? value.token : undefined;
  return {
    id: typeof value.id === "string" && value.id ? value.id : fallbackId,
    label: typeof value.label === "string" && value.label.trim() ? value.label : new URL(url).host,
    url,
    ...(token ? { token } : {}),
    ...(headers.length ? { headers } : {}),
  };
}

export function readConnectionSettings(path: string): ConnectionSettings {
  if (!existsSync(path)) return localConnection();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return localConnection();
    const value = raw as { active?: unknown; servers?: unknown; mode?: unknown; remote?: unknown };
    if (Array.isArray(value.servers)) {
      const servers = value.servers.flatMap((item) => readServer(item, randomUUID()) ?? []);
      const active = servers.some((server) => server.id === value.active)
        ? (value.active as string)
        : null;
      return { active, servers };
    }
    // Before the saved list, the file held one remote target and a local/remote switch.
    const legacy = readServer(value.remote, randomUUID());
    if (!legacy) return localConnection();
    return { active: value.mode === "remote" ? legacy.id : null, servers: [legacy] };
  } catch (error) {
    // A damaged client setting must not stop the desktop from opening its local server.
    console.warn(
      `[orc-desktop] ignoring connection settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    return localConnection();
  }
}

export function writeConnectionSettings(path: string, settings: ConnectionSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows applies its own ACL to the app data folder.
  }
}
