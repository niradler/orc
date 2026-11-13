import { ChatTurnSchema } from "@orc/core/chat";
import { Check, Copy, GitFork, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { foldTurn, formatDuration } from "@/lib/chat-activity";
import { cn } from "@/lib/utils";

const button =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 max-sm:size-11 pointer-coarse:size-11";
// Touch and coarse pointers keep both actions discoverable without hover.
const reveal =
  "opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100";

export function ChatMessageActions({
  threadId,
  messageId,
  role,
  content,
  turn,
  forkDisabledReason,
}: {
  threadId: string | undefined;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  turn: unknown;
  forkDisabledReason?: string | undefined;
}) {
  const chat = useChat();
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const timing = ChatTurnSchema.safeParse(turn);
  const duration = timing.success ? foldTurn([], timing.data).durationMs : null;
  const outcome = timing.success ? timing.data.outcome : undefined;
  const finishedAt = timing.success ? timing.data.finishedAt : undefined;
  const ended = finishedAt
    ? new Date(finishedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const durationVerb =
    outcome === "stopped" ? "Stopped after" : outcome === "failed" ? "Failed after" : "Worked for";
  const durationText = duration === null ? null : `${durationVerb} ${formatDuration(duration)}`;
  const durationLabel = ended ? `${durationText}, ended ${ended}` : durationText;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setError(null);
    } catch {
      setError("Clipboard access failed. Allow clipboard access and try again.");
    }
  }

  async function fork(): Promise<void> {
    if (!threadId) return;
    setForking(true);
    setError(null);
    try {
      chat.openThread(await api.chat.fork(threadId, messageId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The session could not be forked.");
    } finally {
      setForking(false);
    }
  }

  return (
    <div
      data-testid="chat-message-meta"
      className={cn(
        "mt-1 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-variant",
        role === "user" && "justify-end",
      )}
    >
      {duration !== null && (
        <time
          role="timer"
          data-testid="chat-message-duration"
          dateTime={finishedAt ? new Date(finishedAt).toISOString() : undefined}
          title={durationLabel ?? undefined}
          aria-label={durationLabel ?? undefined}
          className="tabular-nums"
        >
          <span aria-hidden="true">{formatDuration(duration)}</span>
        </time>
      )}
      <div data-testid="chat-message-actions" className={cn("flex items-center gap-0.5", reveal)}>
        {content.trim() && (
          <button
            type="button"
            data-testid="chat-message-copy"
            aria-label={copied ? "Copied" : role === "user" ? "Copy your message" : "Copy response"}
            title={copied ? "Copied" : "Copy message"}
            onClick={() => void copy()}
            className={button}
          >
            {copied ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
          </button>
        )}
        {role === "assistant" && (
          <button
            type="button"
            data-testid="chat-message-fork"
            aria-label="Fork to new session"
            title={forkDisabledReason ?? "Fork to a new session from this response"}
            disabled={!threadId || !!forkDisabledReason || forking}
            onClick={() => void fork()}
            className={button}
          >
            {forking ? (
              <LoaderCircle aria-hidden="true" size={14} className="motion-safe:animate-spin" />
            ) : (
              <GitFork aria-hidden="true" size={14} />
            )}
          </button>
        )}
      </div>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
      {error && (
        <p role="alert" data-testid="chat-message-action-error" className="w-full text-error">
          {error}
        </p>
      )}
    </div>
  );
}
