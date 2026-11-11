import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { runHumanRuleActions } from "@orc/core/human-request-client";
import { runRuleBuiltinActions } from "@orc/core/rule-builtin";
import { processRuleCommand } from "@orc/core/rule-command";
import { ruleEventCapability } from "@orc/core/rule-events";
import { normalizeRuleHook, ruleHookOutput } from "@orc/core/rule-hooks";
import type { SessionRuleGuard } from "./rules.js";
import type { AgentEvent } from "./types.js";

type PendingMessages = {
  deliver: () => void;
  interrupt: (error: string) => void;
  context: string;
};

async function pendingSessionMessages(
  backend: string,
  sessionId: string | undefined,
): Promise<PendingMessages | null> {
  if (!sessionId) return null;
  try {
    const [{ getSqlite }, { SessionMessageStore }, { sessionMessageContext }] = await Promise.all([
      import("@orc/db/client"),
      import("@orc/db/session-messages"),
      import("@orc/core/session-messages"),
    ]);
    const store = new SessionMessageStore(getSqlite());
    const messages = store.claim(backend, sessionId);
    if (!messages.length) return null;
    return {
      context: sessionMessageContext(messages),
      deliver: () =>
        store.deliver(
          messages.map((message) => message.id),
          "hook",
        ),
      interrupt: (error) =>
        store.interrupted(
          messages.map((message) => message.id),
          error,
        ),
    };
  } catch {
    return null;
  }
}

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

export function createSessionMessagesHook(sessionId: string | undefined): HookCallback {
  return async (input) => {
    try {
      if (!ruleEventCapability("claude", `native:${input.hook_event_name}`)?.context) return {};
      const pending = await pendingSessionMessages("claude", input.session_id ?? sessionId);
      if (!pending) return {};
      pending.deliver();
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          additionalContext: pending.context,
        },
      } as SyncHookJSONOutput;
    } catch {
      return {};
    }
  };
}

export function createRulesHook(
  guard: SessionRuleGuard,
  cwd: string,
  emit: (event: AgentEvent) => void,
  onHumanWait?: (waiting: boolean) => void,
  onHumanResponse?: (toolUseId: string, receipts: { id: string; version: number }[]) => void,
): HookCallback {
  return async (input, toolUseId, options) => {
    let waiting = false;
    const finishWaiting = () => {
      if (waiting) {
        waiting = false;
        onHumanWait?.(false);
      }
    };
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
      if (decision.decision !== "deny" && decision.human_requests?.length) {
        waiting = true;
        onHumanWait?.(true);
      }
      const result = await runHumanRuleActions(
        event,
        guard.builtinActions === false ? decision : await runRuleBuiltinActions(event, decision),
        options.signal,
      );
      finishWaiting();
      if (result.human_receipts?.length) onHumanResponse?.(event.id, result.human_receipts);
      for (const error of result.action_errors ?? [])
        emit({ type: "system_status", data: `${error.rule_id}: ${error.reason}` });
      if (result?.decision === "deny") {
        const reason = result.reasons.map((r) => `${r.rule_id}: ${r.reason}`).join("; ");
        emit({
          type: "system_status",
          data: `ORC rule denied tool: ${reason}`,
        });
      }
      const pending =
        result.decision === "deny" ||
        !ruleEventCapability("claude", `native:${input.hook_event_name}`)?.context
          ? null
          : await pendingSessionMessages("claude", event.session_id);
      if (pending) result.context.push(pending.context);
      let output: SyncHookJSONOutput;
      try {
        output = ruleHookOutput("claude", event, result) as SyncHookJSONOutput;
      } catch (error) {
        pending?.interrupt("The hook could not return the message to the agent");
        throw error;
      }
      pending?.deliver();
      return output;
    } catch (error) {
      finishWaiting();
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
