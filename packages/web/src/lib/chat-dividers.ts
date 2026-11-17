import { formatTokenCount } from "./token-count";

export type CompactionTrigger = "manual" | "auto" | null;

export type ChatDivider =
  | { type: "model"; model: string }
  | {
      type: "compact";
      pre: number | null;
      post: number | null;
      trigger: CompactionTrigger;
    };

type DividerMessage = {
  id: string;
  role: "user" | "assistant";
  timestamp: number;
  model?: string | undefined;
};

type DividerCompaction = {
  recorded_at: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
  trigger?: CompactionTrigger | undefined;
};

/**
 * Dividers mark real boundaries only: a recorded model change between
 * consecutive assistant turns, and a recorded compaction placed on the first
 * message that follows it. Anything without a recorded time or model is left
 * out rather than guessed.
 */
export function chatDividers(
  messages: readonly DividerMessage[],
  compactions: readonly DividerCompaction[] = [],
): { byMessage: Map<string, ChatDivider[]>; trailing: ChatDivider[] } {
  const byMessage = new Map<string, ChatDivider[]>();
  const trailing: ChatDivider[] = [];
  const push = (id: string | null, divider: ChatDivider) => {
    if (!id) trailing.push(divider);
    else byMessage.set(id, [...(byMessage.get(id) ?? []), divider]);
  };

  let previousModel: string | undefined;
  let turnStart: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      turnStart ??= message.id;
      continue;
    }
    if (message.model) {
      if (previousModel && previousModel !== message.model)
        push(turnStart ?? message.id, { type: "model", model: message.model });
      previousModel = message.model;
    }
    turnStart = null;
  }

  for (const compaction of compactions) {
    const at = compaction.recorded_at ? Date.parse(compaction.recorded_at) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    push(messages.find((message) => message.timestamp >= at)?.id ?? null, {
      type: "compact",
      pre: compaction.pre_tokens,
      post: compaction.post_tokens,
      trigger: compaction.trigger ?? null,
    });
  }
  return { byMessage, trailing };
}

/**
 * The divider's words. Only a recorded trigger is named, and the drop appears
 * only when both sizes were recorded, so a missing value never reads as zero.
 */
export function compactionDividerLabel(divider: {
  pre: number | null;
  post: number | null;
  trigger: CompactionTrigger;
}): { label: string; drop: string | null } {
  const label =
    divider.trigger === "auto"
      ? "Context compacted automatically"
      : divider.trigger === "manual"
        ? "Context compacted manually"
        : "Context compacted";
  return {
    label,
    drop:
      divider.pre !== null && divider.post !== null
        ? `${formatTokenCount(divider.pre, false)} → ${formatTokenCount(divider.post, false)} tokens`
        : null,
  };
}
