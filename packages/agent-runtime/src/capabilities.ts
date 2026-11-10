import { chatRuntimeFor } from "@orc/core/coding-agents";
import { loadConfig } from "@orc/core/config";
import type { AgentCapabilities } from "@orc/core/types";

export const UNKNOWN_CAPABILITIES: AgentCapabilities = Object.freeze({
  version: 1,
  source: "unknown",
  resume: false,
  modelSelection: false,
  images: false,
  toolOutput: false,
  approvals: false,
  questions: false,
  livePermissions: false,
  interrupt: false,
  steering: false,
  mcp: false,
  fork: false,
  rollback: false,
});
export const ACPX_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...UNKNOWN_CAPABILITIES,
  source: "adapter",
  resume: true,
  modelSelection: true,
  toolOutput: true,
  mcp: true,
});
export const CLAUDE_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...ACPX_CAPABILITIES,
  images: true,
  approvals: true,
  questions: true,
  livePermissions: true,
});
export const CODEX_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...CLAUDE_CAPABILITIES,
  interrupt: true,
  steering: true,
});
export const CODEX_EXEC_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...ACPX_CAPABILITIES,
});
export const ACP_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...UNKNOWN_CAPABILITIES,
  source: "adapter",
  toolOutput: true,
  approvals: true,
  interrupt: true,
});
/** What `opencode acp` advertises; re-negotiated from the live handshake on every session. */
export const OPENCODE_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...ACP_CAPABILITIES,
  resume: true,
  modelSelection: true,
  images: true,
  mcp: true,
});

export function chatBackendFor(agent: string): string {
  return loadConfig().agent_loop.acp_commands?.[agent] ? "acp" : chatRuntimeFor(agent);
}
