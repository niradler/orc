import { createHash } from "node:crypto";
import { type RuleDecision, type RuleEvent, RuleEventSchema } from "./rules.js";

export type RuleHookBackend = "claude" | "cursor" | "gemini";
export function normalizeRuleHook(
  backend: RuleHookBackend,
  event: string,
  raw: unknown,
): RuleEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Hook input must be an object");
  const input = raw as Record<string, unknown>;
  const phases: Record<string, RuleEvent["phase"]> = {
    SessionStart: "session_start",
    sessionStart: "session_start",
    PreToolUse: "pre_tool",
    preToolUse: "pre_tool",
    BeforeTool: "pre_tool",
    PostToolUse: "post_tool",
    postToolUse: "post_tool",
    PostToolUseFailure: "post_tool",
    postToolUseFailure: "post_tool",
    AfterTool: "post_tool",
    SessionEnd: "session_end",
    sessionEnd: "session_end",
  };
  const phase = phases[event];
  if (!phase) throw new Error("Unsupported rule hook event");
  const session = input.session_id ?? input.conversation_id;
  const id = input.tool_use_id ?? input.tool_call_id;
  if ((phase === "pre_tool" || phase === "post_tool") && typeof id !== "string")
    throw new Error("Tool hook requires a stable tool-call identity");
  const cwd =
    input.cwd ?? (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined);
  return RuleEventSchema.parse({
    id:
      typeof id === "string"
        ? id
        : createHash("sha256")
            .update(JSON.stringify([session, event, input.generation_id ?? null]))
            .digest("hex"),
    session_id: session,
    backend,
    cwd,
    phase,
    tool: input.tool_name,
    input: input.tool_input ?? {},
    failed:
      event.endsWith("Failure") ||
      event.endsWith("Failure".toLowerCase()) ||
      (typeof input.tool_response === "object" &&
        input.tool_response !== null &&
        "error" in input.tool_response &&
        Boolean(input.tool_response.error)),
  });
}

export function ruleHookOutput(
  backend: RuleHookBackend,
  event: RuleEvent,
  result: RuleDecision,
): Record<string, unknown> {
  const reason = result.reasons.map((r) => `${r.rule_id}: ${r.reason}`).join("; ");
  if (event.phase === "pre_tool") {
    if (backend === "cursor")
      return result.decision === "deny"
        ? {
            permission: "deny",
            ...(reason ? { user_message: reason, agent_message: reason } : {}),
          }
        : {};
    if (backend === "gemini") return result.decision === "deny" ? { decision: "deny", reason } : {};
    return result.decision === "deny"
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }
      : {};
  }
  if (event.phase === "session_start" && result.context.length) {
    if (backend === "cursor") return { additional_context: result.context.join("\n") };
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: result.context.join("\n"),
      },
    };
  }
  return {};
}
