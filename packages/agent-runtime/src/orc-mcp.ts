import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredApiSecret, loadConfig, type OrcConfig, resolveApiBase } from "@orc/core/config";
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
// Permission rule matching every tool of the orc server; the served set is chosen by the MCP URL.
export const ORC_TOOLS_RULE = `mcp__${ORC_MCP_SERVER_NAME}`;

/** Served tool surface: every tool, or meta tools that search, describe and invoke them. */
export type OrcMcpMode = "full" | "meta";

export type OrcHttpMcpServer = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
};

export function buildOrcMcpServer(
  host: ExecHost = resolveExecHost(),
  alwaysLoad = false,
  mode: OrcMcpMode = "meta",
  project?: string,
): OrcHttpMcpServer {
  let config: OrcConfig;
  try {
    config = loadConfig();
  } catch (err) {
    throw new Error(
      `Cannot start a tool-restricted agent session: ORC config unavailable, so the ORC MCP server (mcp__orc__*) cannot be injected: ${String(err)}`,
    );
  }
  const secret = configuredApiSecret(config.api.secret);
  const base = `${host.kind === "ssh" ? orcUrlOnHost(host) : resolveApiBase(config)}/mcp`;
  const query = new URLSearchParams();
  query.set("mode", mode);
  if (project) query.set("project", project);
  return {
    type: "http",
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
    url: query.size ? `${base}?${query}` : base,
    ...(secret ? { headers: { Authorization: `Bearer ${secret}` } } : {}),
  };
}

export function buildOrcMcpServers(
  host: ExecHost = resolveExecHost(),
  alwaysLoad = false,
  mode: OrcMcpMode = "meta",
  project?: string,
): Record<string, OrcHttpMcpServer> {
  return { [ORC_MCP_SERVER_NAME]: buildOrcMcpServer(host, alwaysLoad, mode, project) };
}

export type OrcMcpConfigFile = { path: string; cleanup: () => void };

// The bearer secret must not appear on argv (visible in process listings), so the
// CLI backend receives the MCP config as a private temp file instead of inline JSON.
export async function writeOrcMcpConfigFile(
  host: ExecHost = resolveExecHost(),
  project?: string,
  mode: OrcMcpMode = "meta",
): Promise<OrcMcpConfigFile> {
  if (host.kind === "ssh") await ensureSshMaster(host);
  const content = JSON.stringify({ mcpServers: buildOrcMcpServers(host, false, mode, project) });
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
