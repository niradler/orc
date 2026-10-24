import { SquareTerminal } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { useTerminals } from "@/lib/terminals";

export function ChatContinueInTerminal() {
  const { thread, streaming } = useChat();
  const { openLiveSession } = useTerminals();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!thread || !["codex", "claude"].includes(thread.config.agent)) return null;
  async function open() {
    if (!thread) return;
    setPending(true);
    setError("");
    try {
      const { sessions } = await api.sessions.live({ active: false, limit: 5000 });
      const session = sessions.find(
        (session) =>
          session.session_id === thread.runtimeId &&
          session.agent === thread.config.agent &&
          session.host === thread.host,
      );
      if (!session)
        throw new Error(
          "This conversation is not available in Sessions yet. Try again after session discovery refreshes.",
        );
      await openLiveSession(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue in terminal.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="chat-continue-terminal"
        aria-label="Continue in terminal"
        title="Continue in terminal"
        disabled={streaming || pending || !thread.runtimeId}
        onClick={() => void open()}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface disabled:opacity-40"
      >
        <SquareTerminal size={17} />
      </button>
      {error && (
        <p
          role="alert"
          className="absolute right-0 top-full z-50 w-64 rounded-md border border-border bg-background p-3 text-sm text-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
