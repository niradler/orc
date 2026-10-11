import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";
import {
  type ExecHost,
  orcUrlOnHost,
  remoteTempPath,
  removeHostFile,
  resolveExecHost,
  writeHostFile,
} from "@orc/core/exec-host";

export const ORC_MCP_SERVER_NAME = "orc";
export const ORC_TOOL_PREFIX = `mcp__${ORC_MCP_SERVER_NAME}__`;

export type OrcHttpMcpServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

// ORC tools a tool-restricted session always gets: what the built-in worker skills use,
// plus read-only lookups. Anything that runs commands, starts agents (job_run, flow_*,
// task_create/update) or persists prompts (skill/agent create) must be named in the profile.
const IMPLICIT_ORC_TOOLS = [
  "flow_report",
  "flow_status",
  "task_get",
  "task_list",
  "memory_search",
  "memory_get",
  "memory_store",
  "knowledge_search",
  "knowledge_get",
  "skill_list",
  "skill_read",
].map((tool) => `${ORC_TOOL_PREFIX}${tool}`);

export function isImplicitOrcTool(toolName: string): boolean {
  return IMPLICIT_ORC_TOOLS.includes(toolName);
}

export function buildOrcMcpServer(host: ExecHost = resolveExecHost()): OrcHttpMcpServer {
  let api: { host: string; port: number; secret?: string | undefined };
  try {
    api = loadConfig().api;
  } catch (err) {
    throw new Error(
      `Cannot start a tool-restricted agent session: ORC config unavailable, so the ORC MCP server (mcp__orc__*) cannot be injected: ${String(err)}`,
    );
  }
  return {
    type: "http",
    url: host.kind === "ssh" ? `${orcUrlOnHost(host)}/mcp` : `http://${api.host}:${api.port}/mcp`,
    ...(api.secret ? { headers: { Authorization: `Bearer ${api.secret}` } } : {}),
  };
}

export function buildOrcMcpServers(
  host: ExecHost = resolveExecHost(),
): Record<string, OrcHttpMcpServer> {
  return { [ORC_MCP_SERVER_NAME]: buildOrcMcpServer(host) };
}

export function withOrcAllowedTools(allowed: readonly string[]): string[] {
  return [...new Set([...allowed, ...IMPLICIT_ORC_TOOLS])];
}

export type OrcMcpConfigFile = { path: string; cleanup: () => void };

// The bearer secret must not appear on argv (visible in process listings), so the
// CLI backend receives the MCP config as a private temp file instead of inline JSON.
export async function writeOrcMcpConfigFile(
  host: ExecHost = resolveExecHost(),
): Promise<OrcMcpConfigFile> {
  const content = JSON.stringify({ mcpServers: buildOrcMcpServers(host) });
  if (host.kind === "ssh") {
    const path = remoteTempPath(".mcp.json");
    await writeHostFile(host, path, content);
    return { path, cleanup: () => void removeHostFile(host, path) };
  }
  const dir = mkdtempSync(join(tmpdir(), "orc-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
