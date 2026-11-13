import type { ChatThread } from "@orc/core/chat";
import { GitFork } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";

/**
 * A fork is only trustworthy if the user can see which mode it used and what
 * context it carried. Native forks keep the provider session; context forks
 * replay a bounded, tool-aware transcript and must never look identical.
 */
export function ChatForkNotice({ thread }: { thread: ChatThread | undefined }) {
  const chat = useChat();
  const [error, setError] = useState<string | null>(null);
  const fork = thread?.forkedFrom;
  if (!thread || !fork) return null;
  const sourceThreadId = fork.threadId;

  const sourceTitle = fork.sourceTitle ?? "another chat";
  const mode =
    fork.mode === "native"
      ? thread.forkPending
        ? "The native fork starts with the next message."
        : "Continues the source agent session natively."
      : "Carries a bounded context replay into this chat.";
  const details = [
    fork.fallbackReason,
    fork.partial ? "Older messages were not available in the copied transcript." : null,
  ].filter((detail): detail is string => !!detail);

  async function openSource(): Promise<void> {
    setError(null);
    try {
      chat.openThread(await api.chat.get(sourceThreadId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The source chat could not be opened.");
    }
  }

  return (
    <div
      data-testid="chat-fork-notice"
      role="note"
      className="mx-auto mb-3 flex w-full max-w-3xl items-start gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-xs text-on-surface-variant"
    >
      <GitFork aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p>
          Forked from <span className="font-medium text-on-surface">{sourceTitle}</span> at this
          response. {mode}
        </p>
        {fork.mode === "context" && thread.forkContext && (
          <p className="mt-0.5">
            {thread.forkContext.messageCount} messages ·{" "}
            {thread.forkContext.includesActivity ? "tool work summarized" : "text only"}
            {thread.forkContext.truncated ? " · earlier messages omitted" : ""}
          </p>
        )}
        {details.map((detail) => (
          <p key={detail} className="mt-0.5">
            {detail}
          </p>
        ))}
        <button
          type="button"
          className="mt-1 underline underline-offset-2 hover:text-on-surface"
          onClick={() => void openSource()}
        >
          Open source chat
        </button>
        {error && (
          <p role="alert" className="mt-1 text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
