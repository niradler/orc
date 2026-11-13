import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configuredApiSecret, loadConfig, type OrcConfig, resolveApiBase } from "@orc/core/config";
import {
  type ExecHost,
  ensureSshMaster,
  hostExec,
  orcUrlOnHost,
  remoteTempPath,
  removeHostFile,
  resolveExecHost,
  type SshExecHost,
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
  mode: OrcMcpMode = loadConfig().mcp.default_mode,
  project?: string,
  previewSession?: string,
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
  if (previewSession) {
    query.set("preview_session", previewSession);
    query.set("session", previewSession);
  }
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
  mode: OrcMcpMode = loadConfig().mcp.default_mode,
  project?: string,
  previewSession?: string,
): Record<string, OrcHttpMcpServer> {
  return {
    [ORC_MCP_SERVER_NAME]: buildOrcMcpServer(host, alwaysLoad, mode, project, previewSession),
  };
}

export type OrcMcpConfigFile = { path: string; cleanup: () => Promise<void> };

// The bearer secret must not appear on argv (visible in process listings), so the
// CLI backend receives the MCP config as a private temp file instead of inline JSON.
export async function writeOrcMcpConfigFile(
  host: ExecHost = resolveExecHost(),
  project?: string,
  mode: OrcMcpMode = loadConfig().mcp.default_mode,
  format: "claude" | "acpx" = "claude",
  stableName?: string,
  previewSession?: string,
): Promise<OrcMcpConfigFile> {
  if (host.kind === "ssh") await ensureSshMaster(host);
  const servers = buildOrcMcpServers(host, false, mode, project, previewSession);
  const mcpServers =
    format === "acpx"
      ? Object.entries(servers).map(([name, server]) => ({
          name,
          type: server.type,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        }))
      : servers;
  const content = JSON.stringify({ mcpServers });
  const name = stableName?.replace(/[^A-Za-z0-9_-]/g, "_");
  if (host.kind === "ssh") {
    const path = name
      ? await writePrivateHostFile(host, name, content)
      : remoteTempPath(".mcp.json");
    if (!name) await writeHostFile(host, path, content);
    return { path, cleanup: () => removeHostFile(host, path) };
  }
  if (name) {
    const dir = join(homedir(), ".orc", "mcp");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {}
    const path = join(dir, `${name}.json`);
    removeLocal(path);
    writeFileSync(path, content, { mode: 0o600 });
    return { path, cleanup: async () => removeLocal(path) };
  }
  const dir = mkdtempSync(join(tmpdir(), "orc-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return { path, cleanup: async () => removeLocal(dir) };
}

async function writePrivateHostFile(host: SshExecHost, name: string, content: string) {
  const script =
    'umask 077 && d="$HOME/.orc/mcp" && mkdir -p "$d" && chmod 700 "$d" && f="$d/$1.json" && rm -f "$f" && : > "$f" && chmod 600 "$f" && cat > "$f" && printf %s "$f"';
  const result = await hostExec(host, ["/bin/sh", "-c", script, "sh", name], {
    input: content,
    login: false,
  });
  const path = result.stdout.trim();
  if (result.code !== 0 || !path)
    throw new Error(`Could not write the ORC MCP config on ${host.alias}: ${result.stderr.trim()}`);
  return path;
}

function removeLocal(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}
