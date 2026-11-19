import { z } from "zod";
import { ChatAgentOptionsSchema } from "./chat-options.js";

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
  profile: z.string().min(1).max(100).optional(),
  options: ChatAgentOptionsSchema.optional(),
  permissions: z.enum(AgentPermissions).default("ask"),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

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
    orcMcp: permissions !== "read_only",
    ...(permissions === "read_only" ? { toolAllowlist: READ_ONLY_TOOLS } : {}),
    ...(run.options ? { chatAgentOptions: run.options } : {}),
  };
}
