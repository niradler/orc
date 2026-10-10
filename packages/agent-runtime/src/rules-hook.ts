import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { type RuleEvent, RuleEventSchema } from "@orc/core/rule-types";
import type { SessionRuleGuard } from "./rules.js";
import type { AgentEvent } from "./types.js";

export function createRulesHook(
  guard: SessionRuleGuard,
  cwd: string,
  emit: (event: AgentEvent) => void,
): HookCallback {
  return async (input, toolUseId) => {
    const phase: RuleEvent["phase"] =
      input.hook_event_name === "PreToolUse"
        ? "pre_tool"
        : input.hook_event_name === "SessionStart"
          ? "session_start"
          : input.hook_event_name === "SessionEnd"
            ? "session_end"
            : "post_tool";
    try {
      const result = guard.evaluate(
        RuleEventSchema.parse({
          id: toolUseId ?? `${input.hook_event_name}:${input.session_id}`,
          session_id: input.session_id,
          backend: "claude",
          cwd: cwd,
          phase,
          ...("tool_name" in input ? { tool: input.tool_name } : {}),
          input: "tool_input" in input ? input.tool_input : {},
          failed: input.hook_event_name === "PostToolUseFailure",
        }),
      );
      if (phase === "pre_tool" && result?.decision === "deny") {
        const reason = result.reasons.map((r) => `${r.rule_id}: ${r.reason}`).join("; ");
        emit({ type: "system_status", data: `ORC rule denied tool: ${reason}` });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      }
      if (phase === "session_start")
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: result?.context.join("\n") ?? "",
          },
        };
      return {};
    } catch (error) {
      const reason = `ORC rule evaluation unavailable: ${String(error)}`;
      emit({ type: "system_status", data: reason });
      if (phase === "pre_tool")
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      return { continue: false, stopReason: reason };
    }
  };
}
