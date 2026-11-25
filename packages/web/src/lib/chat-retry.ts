import type { ChatMessage } from "@orc/core/chat";

export type ChatRetry = {
  /** The prompt to send again. */
  prompt: string;
  /**
   * Whether the interrupted turn recorded any work. When it recorded none the
   * prompt may never have reached the agent, so a resend risks doing nothing
   * twice; when it recorded work the agent may repeat what it already did.
   */
  received: boolean;
};

/**
 * The prompt to resend for an interrupted turn, or null when resending it would
 * not be faithful: the turn was not interrupted, no user prompt precedes it, or
 * that prompt carried attachments a resend would silently drop.
 */
export function retryPrompt(
  messages: readonly ChatMessage[],
  assistantId: string,
): ChatRetry | null {
  const index = messages.findIndex((message) => message.id === assistantId);
  const segment = messages[index];
  if (!segment) return null;
  if (segment.turn?.outcome !== "interrupted") return null;
  let source: ChatMessage | undefined;
  for (let at = index - 1; at >= 0; at -= 1) {
    const candidate = messages[at];
    if (candidate?.role !== "user") continue;
    source = candidate;
    break;
  }
  if (!source) return null;
  if (!source.content.trim() || source.attachments?.length) return null;
  return {
    prompt: source.content,
    received: Boolean(segment.content.trim()) || (segment.activity?.length ?? 0) > 0,
  };
}
