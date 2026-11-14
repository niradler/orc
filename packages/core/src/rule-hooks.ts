import { ChatQuestionSchema } from "./chat.js";
import { createRuleAdapter } from "./rule-adapter.js";
import type { RuleHookBackend } from "./rule-events.js";
import type { RuleDecision, RuleEvent } from "./rules.js";

export type { RuleHookBackend } from "./rule-events.js";
export function nativeHookQuestions(event: RuleEvent) {
  if (event.backend !== "claude" || event.phase !== "pre_tool" || event.tool !== "AskUserQuestion")
    return [];
  const source = event.input.questions;
  if (!Array.isArray(source)) throw new Error("Unsupported native questions");
  return ChatQuestionSchema.parse({
    requestId: event.id,
    questions: source.map((raw, index) => {
      const value = raw as Record<string, unknown>;
      return { ...value, id: `q-${index}`, header: value.header ?? "Question" };
    }),
  }).questions;
}

export function normalizeRuleHook(
  backend: RuleHookBackend,
  event: string,
  raw: unknown,
): RuleEvent {
  return createRuleAdapter(backend).normalize(event, raw);
}

export function ruleHookOutput(
  backend: RuleHookBackend,
  event: RuleEvent,
  result: RuleDecision,
): Record<string, unknown> {
  return createRuleAdapter(backend).output(event, result);
}
