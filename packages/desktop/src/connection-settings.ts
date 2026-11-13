import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ConnectionMode = "local" | "remote";

export type HeaderPair = { name: string; value: string };

export type RemoteConnection = {
  url: string;
  token?: string;
  headers?: HeaderPair[];
};

/** The desktop shell's client-side target. The server it points at keeps its own config. */
export type ConnectionSettings = {
  mode: ConnectionMode;
  remote?: RemoteConnection;
};

export type ConnectionDraft = {
  mode: ConnectionMode;
  url?: string;
  token?: string;
  clear_token?: boolean;
  headers?: HeaderPair[];
};

export type PublicConnection = {
  mode: ConnectionMode;
  /** Which server this window is showing now, which differs while the local editor is open. */
  current: ConnectionMode;
  url: string;
  has_token: boolean;
  headers: HeaderPair[];
  editable: boolean;
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

export const localConnection = (): ConnectionSettings => ({ mode: "local" });

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
export function parseConnectionDraft(input: unknown): ConnectionDraft {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid connection settings.");
  const value = input as Record<string, unknown>;
  if (value.mode !== "local" && value.mode !== "remote")
    throw new Error("Choose the local or a remote server.");
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
    mode: value.mode,
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

/** Applies a form draft to the stored target, keeping a saved token when its URL is unchanged. */
export function applyConnectionDraft(
  input: ConnectionDraft,
  current: ConnectionSettings,
): ConnectionSettings {
  if (input.mode === "local") return { ...current, mode: "local" };
  const url = normalizeServerUrl(input.url ?? "");
  const headers = normalizeHeaders(input.headers);
  const sameUrl = current.remote?.url === url;
  const supplied = normalizeToken(input.token);
  const token = supplied || (sameUrl && !input.clear_token ? current.remote?.token : undefined);
  return {
    mode: "remote",
    remote: {
      url,
      ...(token ? { token } : {}),
      ...(headers.length ? { headers } : {}),
    },
  };
}

export function publicConnection(
  settings: ConnectionSettings,
  editable: boolean,
  current: ConnectionMode = settings.mode,
): PublicConnection {
  return {
    mode: settings.mode,
    current,
    url: settings.remote?.url ?? "",
    has_token: Boolean(settings.remote?.token),
    // A remote page must not learn the proxy headers or token configured for it.
    headers: editable ? (settings.remote?.headers ?? []) : [],
    editable,
  };
}

export function readConnectionSettings(path: string): ConnectionSettings {
  if (!existsSync(path)) return localConnection();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return localConnection();
    const value = raw as { mode?: unknown; remote?: unknown };
    const mode = value.mode === "remote" ? "remote" : "local";
    if (!value.remote || typeof value.remote !== "object" || Array.isArray(value.remote))
      return localConnection();
    const remote = value.remote as { url?: unknown; token?: unknown; headers?: unknown };
    if (typeof remote.url !== "string") return localConnection();
    let url: string;
    try {
      url = normalizeServerUrl(remote.url);
    } catch {
      return localConnection();
    }
    const headers = Array.isArray(remote.headers)
      ? normalizeHeaders(
          remote.headers.filter(
            (pair): pair is HeaderPair =>
              Boolean(pair) &&
              typeof pair === "object" &&
              typeof (pair as HeaderPair).name === "string" &&
              typeof (pair as HeaderPair).value === "string",
          ),
        )
      : [];
    const token =
      typeof remote.token === "string" && remote.token.trim() ? remote.token : undefined;
    return {
      mode,
      remote: { url, ...(token ? { token } : {}), ...(headers.length ? { headers } : {}) },
    };
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
