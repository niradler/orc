export type ChatRuntime = "claude" | "codex-cli" | "acpx";

export type CodingAgent = {
  id: string;
  label: string;
  binaries: readonly string[];
  chatRuntime: ChatRuntime;
  sessionBackends: readonly string[];
  resumeArgs?: (sessionId: string) => string[];
};

export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    id: "claude",
    label: "Claude Code",
    binaries: ["claude"],
    chatRuntime: "claude",
    sessionBackends: ["claude"],
    resumeArgs: (id) => ["--resume", id],
  },
  {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    chatRuntime: "codex-cli",
    sessionBackends: ["codex"],
    resumeArgs: (id) => ["resume", id],
  },
  {
    id: "cursor",
    label: "Cursor",
    binaries: ["cursor-agent", "agent"],
    chatRuntime: "acpx",
    sessionBackends: ["cursor-agent"],
    resumeArgs: (id) => ["--resume", id],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    binaries: ["gemini"],
    chatRuntime: "acpx",
    sessionBackends: ["gemini"],
    resumeArgs: (id) => ["--resume", id],
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    binaries: ["copilot"],
    chatRuntime: "acpx",
    sessionBackends: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    binaries: ["opencode"],
    chatRuntime: "acpx",
    sessionBackends: ["opencode"],
    resumeArgs: (id) => ["--session", id],
  },
  { id: "qwen", label: "Qwen Code", binaries: ["qwen"], chatRuntime: "acpx", sessionBackends: [] },
  {
    id: "droid",
    label: "Factory Droid",
    binaries: ["droid"],
    chatRuntime: "acpx",
    sessionBackends: [],
  },
  { id: "kimi", label: "Kimi CLI", binaries: ["kimi"], chatRuntime: "acpx", sessionBackends: [] },
  {
    id: "kiro",
    label: "Kiro CLI",
    binaries: ["kiro-cli"],
    chatRuntime: "acpx",
    sessionBackends: [],
  },
];

export const DEFAULT_ENABLED_AGENTS = ["codex", "claude", "cursor", "gemini", "copilot"] as const;

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function codingAgent(id: string): CodingAgent | undefined {
  return CODING_AGENTS.find((agent) => agent.id === id);
}

export function agentForSessionBackend(backend: string): CodingAgent | undefined {
  return CODING_AGENTS.find((agent) => agent.sessionBackends.includes(backend));
}

export function chatRuntimeFor(agent: string): ChatRuntime {
  return codingAgent(agent)?.chatRuntime ?? "acpx";
}

export function enabledAgents(configured: readonly string[] | undefined): string[] {
  const ids = configured?.length ? configured : DEFAULT_ENABLED_AGENTS;
  return Array.from(new Set(ids.filter((id) => AGENT_ID_PATTERN.test(id))));
}

export function agentLabel(id: string): string {
  return codingAgent(id)?.label ?? id;
}
