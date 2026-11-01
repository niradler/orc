import type { IntegrationConnectionSource } from "@orc/sdk/types";

export type ConnectionType = IntegrationConnectionSource["type"];
export type Pair = { key: string; value: string };

export const connectionTypes: { value: ConnectionType; label: string }[] = [
  { value: "http", label: "MCP HTTP" },
  { value: "sse", label: "MCP SSE" },
  { value: "stdio", label: "MCP stdio" },
  { value: "openapi", label: "OpenAPI" },
  { value: "graphql", label: "GraphQL" },
];

export const connectionTypeLabel = (type: string | null) =>
  connectionTypes.find((option) => option.value === type)?.label ?? type ?? "Unknown";

export const oauthFlows = ["browser", "device", "client_credentials"] as const;
export const oauthFlowLabels: Record<(typeof oauthFlows)[number], string> = {
  browser: "Browser sign-in",
  device: "Device code",
  client_credentials: "Client credentials",
};

export type AuthMode = "none" | "token" | "oauth";
export const authModes: { value: AuthMode; label: string }[] = [
  { value: "none", label: "None" },
  { value: "token", label: "Bearer token" },
  { value: "oauth", label: "OAuth" },
];

/** Flat form state for every connection type; `toSource` keeps only the fields the type uses. */
export type ConnectionDraft = {
  type: ConnectionType;
  authMode: AuthMode;
  description: string;
  url: string;
  source: string;
  baseUrl: string;
  command: string;
  args: string;
  cwd: string;
  auth: string;
  headers: Pair[];
  env: Pair[];
  oauthFlow: "" | (typeof oauthFlows)[number];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthCallbackPort: string;
  allowedTools: string;
  disabledTools: string;
};

export const emptyDraft: ConnectionDraft = {
  type: "http",
  authMode: "none",
  description: "",
  url: "",
  source: "",
  baseUrl: "",
  command: "",
  args: "",
  cwd: "",
  auth: "",
  headers: [],
  env: [],
  oauthFlow: "",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthCallbackPort: "",
  allowedTools: "",
  disabledTools: "",
};

const pairs = (map: Record<string, string> | undefined): Pair[] =>
  Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));
const map = (list: Pair[]) => {
  const entries = list
    .filter((pair) => pair.key.trim())
    .map((pair) => [pair.key.trim(), pair.value]);
  return entries.length ? Object.fromEntries(entries) : undefined;
};
const list = (text: string, separator = /[\n,]/) => {
  const items = text
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};
const text = (value: string) => value.trim() || undefined;

export function toDraft(source: IntegrationConnectionSource): ConnectionDraft {
  const draft: ConnectionDraft = {
    ...emptyDraft,
    type: source.type,
    description: source.description ?? "",
    allowedTools: source.allowedTools?.join("\n") ?? "",
    disabledTools: source.disabledTools?.join("\n") ?? "",
  };
  switch (source.type) {
    case "stdio":
      return {
        ...draft,
        command: source.command,
        args: source.args?.join("\n") ?? "",
        cwd: source.cwd ?? "",
        env: pairs(source.env),
      };
    case "http":
    case "sse": {
      const oauth = Boolean(source.oauthFlow || source.oauthClientId || source.oauthCallbackPort);
      return {
        ...draft,
        authMode: oauth ? "oauth" : source.auth ? "token" : "none",
        url: source.url,
        auth: source.auth ?? "",
        headers: pairs(source.headers),
        oauthFlow: source.oauthFlow ?? "",
        oauthClientId: source.oauthClientId ?? "",
        oauthCallbackPort: source.oauthCallbackPort?.toString() ?? "",
      };
    }
    default:
      return {
        ...draft,
        authMode: source.auth ? "token" : "none",
        source: source.source,
        baseUrl: source.type === "openapi" ? (source.baseUrl ?? "") : "",
        auth: source.auth ?? "",
        headers: pairs(source.headers),
      };
  }
}

/** OAuth only applies to remote MCP servers; stdio servers take credentials from their env. */
export const authModesFor = (type: ConnectionType) =>
  type === "stdio"
    ? []
    : authModes.filter((mode) => mode.value !== "oauth" || type === "http" || type === "sse");

/** Fields the Advanced section holds; it opens by itself when an existing connection uses any. */
export const hasAdvanced = (draft: ConnectionDraft) =>
  Boolean(
    draft.headers.length ||
      draft.baseUrl.trim() ||
      draft.cwd.trim() ||
      draft.allowedTools.trim() ||
      draft.disabledTools.trim(),
  );

/**
 * Builds the source spec-cli stores. Unused fields, and those of auth modes other than the chosen
 * one, are left out so JSON drops them.
 */
export function toSource(draft: ConnectionDraft): IntegrationConnectionSource {
  const common = {
    description: text(draft.description),
    allowedTools: list(draft.allowedTools),
    disabledTools: list(draft.disabledTools),
  };
  const auth = draft.authMode === "token" ? text(draft.auth) : undefined;
  const oauth = draft.authMode === "oauth";
  switch (draft.type) {
    case "stdio":
      return {
        type: "stdio",
        command: draft.command.trim(),
        // Arguments are one per line, so values with spaces or commas stay intact.
        args: list(draft.args, /\n/),
        cwd: text(draft.cwd),
        env: map(draft.env),
        ...common,
      };
    case "http":
    case "sse":
      return {
        type: draft.type,
        url: draft.url.trim(),
        auth,
        headers: map(draft.headers),
        oauthFlow: (oauth && draft.oauthFlow) || undefined,
        oauthClientId: oauth ? text(draft.oauthClientId) : undefined,
        // Only the client-credentials flow uses a secret; sign-in flows register with PKCE.
        oauthClientSecret:
          oauth && draft.oauthFlow === "client_credentials"
            ? text(draft.oauthClientSecret)
            : undefined,
        // Not shown in the form (ORC is not where the browser lands), but a stored port is kept.
        oauthCallbackPort:
          oauth && draft.oauthCallbackPort.trim() ? Number(draft.oauthCallbackPort) : undefined,
        ...common,
      };
    case "openapi":
      return {
        type: "openapi",
        source: draft.source.trim(),
        baseUrl: text(draft.baseUrl),
        auth,
        headers: map(draft.headers),
        ...common,
      };
    case "graphql":
      return {
        type: "graphql",
        source: draft.source.trim(),
        auth,
        headers: map(draft.headers),
        ...common,
      };
  }
}

/** Header and variable names that usually hold credentials get a masked value. */
export const isSecretKey = (key: string) =>
  /auth|token|key|secret|password|passwd|cookie|credential/i.test(key);

export function draftError(name: string, draft: ConnectionDraft): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    return "Name can use only letters, numbers, hyphens and underscores.";
  if (draft.type === "stdio") return draft.command.trim() ? null : "Command is required.";
  if (draft.type === "http" || draft.type === "sse") {
    if (!draft.url.trim()) return "URL is required.";
  } else if (!draft.source.trim()) return "Spec URL or file is required.";
  if (draft.authMode === "token" && !draft.auth.trim()) return "Token is required.";
  if (draft.authMode === "oauth" && draft.oauthFlow === "client_credentials") {
    if (!draft.oauthClientId.trim()) return "Client credentials need a client ID.";
  }
  return null;
}
