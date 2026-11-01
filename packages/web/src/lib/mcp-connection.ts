export const MCP_CLIENTS = ["url", "claude-json", "claude-cli", "codex", "spec"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export const MCP_CLIENT_LABELS: Record<McpClient, string> = {
  url: "URL",
  "claude-json": "Claude Code .mcp.json",
  "claude-cli": "Claude Code CLI",
  codex: "Codex config.toml",
  spec: "spec CLI",
};

export type McpConnection = {
  baseUrl: string;
  mode: "meta" | "full";
  projects: readonly string[];
  name: string;
  /** Env var holding the API secret; empty when the server has no secret. */
  secretEnv: string;
};

export const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function mcpBaseUrl(apiUrl: string, browserOrigin: string): string {
  return new URL("/mcp", new URL(apiUrl, browserOrigin)).href;
}

// Meta is the server default, so it is left out to keep the URL short.
export function mcpUrl({
  baseUrl,
  mode,
  projects,
}: Pick<McpConnection, "baseUrl" | "mode" | "projects">) {
  const url = new URL(baseUrl);
  if (mode === "full") url.searchParams.set("mode", "full");
  if (projects.length === 1) url.searchParams.set("project", projects[0] ?? "");
  else if (projects.length > 1) url.searchParams.set("projects", projects.join(","));
  return url.href;
}

// Snippets reference the secret by env var name; the literal secret is never rendered.
export function mcpSnippet(client: McpClient, connection: McpConnection): string {
  const url = mcpUrl(connection);
  const { name, secretEnv } = connection;
  const quoted = `'${url}'`;
  switch (client) {
    case "url":
      return url;
    case "claude-json":
      return JSON.stringify(
        {
          mcpServers: {
            [name]: {
              type: "http",
              url,
              ...(secretEnv ? { headers: { Authorization: `Bearer \${${secretEnv}}` } } : {}),
            },
          },
        },
        null,
        2,
      );
    case "claude-cli":
      return `claude mcp add --transport http ${name} ${quoted}${secretEnv ? ` --header 'Authorization: Bearer \${${secretEnv}}'` : ""}`;
    case "codex":
      return [
        `[mcp_servers.${name}]`,
        `url = ${JSON.stringify(url)}`,
        ...(secretEnv ? [`bearer_token_env_var = ${JSON.stringify(secretEnv)}`] : []),
      ].join("\n");
    case "spec":
      return `spec add ${name} --mcp-http ${quoted}${secretEnv ? ` --auth env:${secretEnv}` : ""}`;
  }
}
