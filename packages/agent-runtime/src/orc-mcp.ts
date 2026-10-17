import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredApiSecret, loadConfig } from "@orc/core/config";
import {
  type ExecHost,
  ensureSshMaster,
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
  alwaysLoad?: boolean;
};

// ORC tools a tool-restricted session always gets: what the built-in worker skills use,
// plus read-only lookups. Anything that runs commands, starts agents (job_run, flow_*,
// task_create/update) or persists prompts (skill/agent create) must be named in the profile.
const IMPLICIT_ORC_TOOLS = [
  "flow_report",
  "flow_status",
  "task_get",
  "task_list",
  "memory_list",
  "memory_read",
  "memory_create",
  "memory_update",
  "memory_history",
  "search",
  "wiki_index",
  "wiki_search",
  "wiki_get",
  "wiki_history",
  "wiki_write",
  "audit_list",
  "kb_list",
  "kb_search",
  "kb_evidence",
  "kb_read",
  "kb_documents",
  "kb_maintenance",
  "kb_write",
  "skill_list",
  "skill_read",
].map((tool) => `${ORC_TOOL_PREFIX}${tool}`);

export function isImplicitOrcTool(toolName: string): boolean {
  return IMPLICIT_ORC_TOOLS.includes(toolName);
}

export function buildOrcMcpServer(
  host: ExecHost = resolveExecHost(),
  alwaysLoad = false,
): OrcHttpMcpServer {
  let api: { host: string; port: number; secret?: string | undefined };
  try {
    api = loadConfig().api;
  } catch (err) {
    throw new Error(
      `Cannot start a tool-restricted agent session: ORC config unavailable, so the ORC MCP server (mcp__orc__*) cannot be injected: ${String(err)}`,
    );
  }
  const secret = configuredApiSecret(api.secret);
  return {
    type: "http",
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
    url: host.kind === "ssh" ? `${orcUrlOnHost(host)}/mcp` : `http://${api.host}:${api.port}/mcp`,
    ...(secret ? { headers: { Authorization: `Bearer ${secret}` } } : {}),
  };
}

export function buildOrcMcpServers(
  host: ExecHost = resolveExecHost(),
  alwaysLoad = false,
): Record<string, OrcHttpMcpServer> {
  return { [ORC_MCP_SERVER_NAME]: buildOrcMcpServer(host, alwaysLoad) };
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
  if (host.kind === "ssh") await ensureSshMaster(host);
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
