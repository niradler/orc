import { z } from "zod";

const ExecutablePathSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) =>
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    "Use an executable path without control characters",
  );

export const ProviderPathsSchema = z
  .object({
    claude: ExecutablePathSchema.optional(),
    codex: ExecutablePathSchema.optional(),
  })
  .strict();
export type ProviderPaths = z.infer<typeof ProviderPathsSchema>;

export function supportsManualCompaction(agent: string): boolean {
  return agent === "claude" || agent === "codex" || agent === "pi";
}

/**
 * Agents whose model catalog ORC can discover without starting a conversation turn.
 */
export function supportsModelDiscovery(agent: string): boolean {
  return agent === "claude" || agent === "codex" || agent === "pi" || agent === "opencode";
}

export type ChatRuntime = "claude" | "codex-cli" | "acpx" | "opencode" | "pi";

export type CodingAgent = {
  id: string;
  label: string;
  binaries: readonly string[];
  chatRuntime: ChatRuntime;
  sessionBackends: readonly string[];
  resumeArgs?: (sessionId: string) => string[];
  /** Native CLI fork: a new session that starts from this session's history. */
  forkArgs?: (sessionId: string) => string[];
};

export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    id: "pi",
    label: "Pi",
    binaries: ["pi"],
    chatRuntime: "pi",
    sessionBackends: ["pi"],
    resumeArgs: (id) => ["--session", id],
    // Copies the source conversation into a new native identity.
    forkArgs: (id) => ["--fork", id],
  },
  {
    id: "claude",
    label: "Claude Code",
    binaries: ["claude"],
    chatRuntime: "claude",
    sessionBackends: ["claude"],
    resumeArgs: (id) => ["--resume", id],
    // --fork-session gives the resumed history a new session id; the source is not written.
    forkArgs: (id) => ["--resume", id, "--fork-session"],
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
    chatRuntime: "opencode",
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

export const DEFAULT_ENABLED_AGENTS = ["codex", "claude", "cursor", "gemini", "opencode"] as const;

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const AGENT_ALIASES: Record<string, string> = {
  "claude-cli": "claude",
  "claude-code": "claude",
  "codex-cli": "codex",
  "cursor-agent": "cursor",
};

export function canonicalAgentId(name: string): string {
  const lower = name.trim().toLowerCase();
  if (!lower) return name;
  const direct = codingAgent(lower);
  if (direct) return direct.id;
  const alias = AGENT_ALIASES[lower];
  if (alias) return alias;
  const byBackend = agentForSessionBackend(lower);
  if (byBackend) return byBackend.id;
  if (lower !== "acpx") {
    const byRuntime = CODING_AGENTS.filter((agent) => agent.chatRuntime === lower);
    if (byRuntime.length === 1 && byRuntime[0]) return byRuntime[0].id;
  }
  return name;
}

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
  const ids = configured ?? DEFAULT_ENABLED_AGENTS;
  return Array.from(new Set(ids.filter((id) => AGENT_ID_PATTERN.test(id))));
}

export function agentLabel(id: string): string {
  return codingAgent(id)?.label ?? id;
}
