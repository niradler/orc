import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { runRuleBuiltinActions } from "@orc/core/rule-builtin";
import { processRuleCommand } from "@orc/core/rule-command";
import { normalizeRuleHook, ruleHookOutput } from "@orc/core/rule-hooks";
import type { SessionRuleGuard } from "./rules.js";
import type { AgentEvent } from "./types.js";

export async function sessionStartRuleContext(
  guard: SessionRuleGuard,
  cwd: string,
  sessionId: string,
  eventId: string,
  source: "startup" | "resume",
): Promise<string> {
  const event = normalizeRuleHook("claude", "SessionStart", {
    session_id: sessionId,
    event_id: eventId,
    cwd,
    source,
    hook_event_name: "SessionStart",
  });
  const result =
    guard.builtinActions === false
      ? guard.evaluate(event)
      : await runRuleBuiltinActions(event, guard.evaluate(event));
  ruleHookOutput("claude", event, result);
  return [
    ...result.context,
    ...(result.action_errors ?? []).map((error) => `${error.rule_id}: ${error.reason}`),
  ].join("\n");
}

export function createRulesHook(
  guard: SessionRuleGuard,
  cwd: string,
  emit: (event: AgentEvent) => void,
): HookCallback {
  return async (input, toolUseId) => {
    try {
      const event = normalizeRuleHook("claude", input.hook_event_name, {
        ...input,
        cwd,
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      });
      const decision = guard.evaluateCommand
        ? guard.evaluateCommand(event)
        : processRuleCommand(event, guard.evaluate(event), (replacement) =>
            guard.evaluate(replacement, true),
          );
      const result =
        guard.builtinActions === false ? decision : await runRuleBuiltinActions(event, decision);
      for (const error of result.action_errors ?? [])
        emit({ type: "system_status", data: `${error.rule_id}: ${error.reason}` });
      if (result?.decision === "deny") {
        const reason = result.reasons.map((r) => `${r.rule_id}: ${r.reason}`).join("; ");
        emit({
          type: "system_status",
          data: `ORC rule denied tool: ${reason}`,
        });
      }
      return ruleHookOutput("claude", event, result) as SyncHookJSONOutput;
    } catch (error) {
      const reason = `ORC rule evaluation unavailable: ${String(error)}`;
      emit({ type: "system_status", data: reason });
      if (input.hook_event_name === "PreToolUse")
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
