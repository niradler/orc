import { createHash, randomUUID } from "node:crypto";
import { RULE_EVENT_ADAPTERS, type RuleHookBackend, ruleEventCapability } from "./rule-events.js";
import { type RuleDecision, type RuleEvent, RuleEventSchema } from "./rules.js";

export type { RuleHookBackend } from "./rule-events.js";
export function normalizeRuleHook(
  backend: RuleHookBackend,
  event: string,
  raw: unknown,
): RuleEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Hook input must be an object");
  const input = raw as Record<string, unknown>;
  const capability = RULE_EVENT_ADAPTERS[backend]?.find((entry) => entry.native === event);
  const phase = capability?.event;
  if (!phase) throw new Error("Unsupported rule hook event");
  const session =
    input.session_id ??
    input.conversation_id ??
    (phase === "workspace_open" ? "workspace" : undefined);
  const id = input.tool_use_id ?? input.tool_call_id ?? input.event_id;
  if (
    ["pre_tool", "post_tool", "post_tool_failure"].includes(phase) &&
    typeof id !== "string" &&
    backend !== "gemini"
  )
    throw new Error("Tool hook requires a stable tool-call identity");
  const cwd =
    input.cwd ?? (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined);
  return RuleEventSchema.parse({
    id:
      typeof id === "string"
        ? id
        : createHash("sha256")
            .update(
              JSON.stringify([
                session,
                event,
                input.generation_id ?? input.turn_id ?? randomUUID(),
                input,
              ]),
            )
            .digest("hex"),
    session_id: session,
    backend,
    cwd,
    phase,
    native_event: event,
    payload: input,
    tool: input.tool_name,
    input: input.tool_input ?? input,
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
  const capability = ruleEventCapability(
    backend,
    event.native_event ? `native:${event.native_event}` : event.phase,
  );
  const denied = result.decision === "deny";
  const context = result.context.join("\n");
  if (denied && !capability?.block)
    throw new Error("Rule denied an event without blocking support");
  if (context && !capability?.context)
    throw new Error("Rule context cannot be delivered on this event");
  if (!denied && !context) return {};
  const native = capability?.native;
  if (backend === "cursor") {
    if (denied)
      return event.phase === "prompt_submit"
        ? { continue: false }
        : { permission: "deny", user_message: reason, agent_message: reason };
    return { additional_context: context };
  }
  if (backend === "gemini")
    return {
      ...(denied ? { decision: "deny", reason } : {}),
      ...(context
        ? { hookSpecificOutput: { hookEventName: native, additionalContext: context } }
        : {}),
    };
  if (denied && event.phase !== "pre_tool") return { decision: "block", reason };
  return {
    hookSpecificOutput: {
      hookEventName: native,
      ...(denied ? { permissionDecision: "deny", permissionDecisionReason: reason } : {}),
      ...(context ? { additionalContext: context } : {}),
    },
  };
}
