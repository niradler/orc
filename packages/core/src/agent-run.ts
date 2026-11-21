import { z } from "zod";
import { type ChatAgentOptions, ChatAgentOptionsSchema, withChatEffort } from "./chat-options.js";

export const AgentPermissions = ["ask", "read_only", "accept_edits", "auto"] as const;
export type AgentPermission = (typeof AgentPermissions)[number];
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch"];

export const AgentRunSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_-]*$/),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._:/@+-]*$/i)
    .optional(),
  /** Reasoning effort for runtimes that take one. `""` clears any effort stored
   *  in `options`; absent leaves those launch options untouched. */
  effort: z
    .string()
    .trim()
    .regex(/^$|^[a-z][a-z0-9_-]{0,31}$/i)
    .optional(),
  profile: z.string().min(1).max(100).optional(),
  options: ChatAgentOptionsSchema.optional(),
  permissions: z.enum(AgentPermissions).default("ask"),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

const permissionRank: Record<AgentPermission, number> = {
  read_only: 0,
  ask: 1,
  accept_edits: 2,
  auto: 3,
};

export function optionsExceedPermissions(
  options: ChatAgentOptions | undefined,
  permissions: AgentPermission,
): boolean {
  if (!options) return false;
  const granted: AgentPermission | null =
    (options.runtime === "claude-sdk" && options.options.permissionMode === "bypassPermissions") ||
    (options.runtime === "acpx" && options.args.includes("--approve-all"))
      ? "auto"
      : (options.runtime === "claude-sdk" && options.options.permissionMode === "acceptEdits") ||
          (options.runtime === "acpx" && options.args.includes("--approve-reads"))
        ? "accept_edits"
        : null;
  return granted !== null && permissionRank[granted] > permissionRank[permissions];
}

export function agentRunSessionOptions(
  run: Pick<AgentRun, "permissions" | "options">,
  trusted: boolean,
) {
  const permissions: AgentPermission =
    !trusted && (run.permissions === "auto" || run.permissions === "accept_edits")
      ? "read_only"
      : run.permissions;
  return {
    permissions,
    autoApprove: permissions === "auto",
    permissionMode:
      permissions === "accept_edits"
        ? ("acceptEdits" as const)
        : permissions === "auto"
          ? ("bypassPermissions" as const)
          : ("default" as const),
    orcMcp: trusted && permissions !== "read_only",
    ...(permissions === "read_only" ? { toolAllowlist: READ_ONLY_TOOLS } : {}),
    ...(run.options && !optionsExceedPermissions(run.options, permissions)
      ? { chatAgentOptions: run.options }
      : {}),
  };
}

/** Applies a run's effort to the launch options the same way chat does.
 *  `codex-cli` shares Codex's runtime. An absent effort leaves the options
 *  untouched (channel defaults keep theirs); `""` clears a stored one. Runtimes
 *  without effort keep their options even if a value slips through. */
export function withAgentRunEffort(
  agent: string,
  options: ChatAgentOptions | undefined,
  effort: string | undefined,
): ChatAgentOptions | undefined {
  if (effort === undefined) return options;
  // Nothing to clear: leave the provider profile's defaults in place.
  if (effort === "" && !options) return undefined;
  return withChatEffort(agent === "codex-cli" ? "codex" : agent, options, effort) ?? options;
}
