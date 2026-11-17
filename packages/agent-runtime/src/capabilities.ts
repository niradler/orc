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
export const CLAUDE_CAPABILITIES: AgentCapabilities = Object.freeze<AgentCapabilities>({
  ...ACPX_CAPABILITIES,
  images: true,
  approvals: true,
  questions: true,
  livePermissions: true,
  permissionModes: ["default", "plan", "acceptEdits", "auto", "bypassPermissions"],
  interrupt: true,
  steering: true,
  // Both the Claude SDK (forkSession) and the CLI (--fork-session) fork natively.
  fork: true,
  subagents: true,
});
export const CODEX_CAPABILITIES: AgentCapabilities = Object.freeze<AgentCapabilities>({
  ...CLAUDE_CAPABILITIES,
  permissionModes: ["default", "plan", "acceptEdits", "bypassPermissions"],
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
export const OPENCODE_CAPABILITIES: AgentCapabilities = Object.freeze<AgentCapabilities>({
  ...ACP_CAPABILITIES,
  permissionModes: ["default", "plan"],
  resume: true,
  modelSelection: true,
  images: true,
  mcp: true,
  // OpenCode accepts steering: 2.x through the `_session/steering` extension,
  // 1.x as a second session/prompt during a turn (verified against 1.19.5 over
  // `opencode acp`). steer() downgrades per session if an agent rejects one.
  steering: true,
  subagents: true,
});

export function chatBackendFor(agent: string): string {
  return loadConfig().agent_loop.acp_commands?.[agent] ? "acp" : chatRuntimeFor(agent);
}
