import type { McpExposure, PorcConfig } from "./config.js";

export type McpRegistration =
  | {
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      exposure?: McpExposure;
      enabled?: boolean;
      description?: string;
      timeout?: number;
    }
  | {
      url: string;
      headers?: Record<string, string>;
      exposure?: McpExposure;
      enabled?: boolean;
      description?: string;
      timeout?: number;
    };

/** ORC serves MCP at `/mcp`; mode and project are connection-level query parameters. */
export function buildMcpUrl(
  config: Pick<PorcConfig, "apiBase" | "mode">,
  project?: string,
): string {
  const url = new URL(`${config.apiBase.replace(/\/+$/, "")}/mcp`);
  url.searchParams.set("mode", config.mode);
  if (project) url.searchParams.set("project", project);
  return url.toString();
}

/**
 * A stdio registration inherits the ORC API base, secret and active project, so
 * the model's native ORC tools use the same scope as porc's own tool calls.
 */
export function buildMcpRegistration(
  config: Pick<
    PorcConfig,
    "apiBase" | "mode" | "transport" | "command" | "secret" | "exposure" | "timeoutMs"
  >,
  project?: string,
  sessionId?: string,
  cwd?: string,
): McpRegistration {
  const timeout = Math.max(Math.ceil(config.timeoutMs / 1000), 1);
  if (config.transport === "http") {
    return {
      url: buildMcpUrl(config, project),
      ...(config.secret ? { headers: { Authorization: `Bearer ${config.secret}` } } : {}),
      exposure: config.exposure,
      enabled: true,
      description: "ORC project context, memories, skills, tasks and sessions",
      timeout,
    };
  }
  const env: Record<string, string> = { ORC_API_BASE: config.apiBase };
  if (config.secret) env.ORC_API_SECRET = config.secret;
  if (project) env.ORC_ACTIVE_PROJECT = project;
  if (sessionId) env.ORC_SESSION_ID = sessionId;
  return {
    command: config.command,
    args: ["mcp", "--mode", config.mode],
    env,
    ...(cwd ? { cwd } : {}),
    exposure: config.exposure,
    enabled: true,
    description: "ORC project context, memories, skills, tasks and sessions",
    timeout,
  };
}

export function redact(value: string, secret: string | undefined): string {
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}
