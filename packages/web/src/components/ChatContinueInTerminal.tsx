import { SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { useChat } from "@/hooks/useChat";
import { useTerminals } from "@/lib/terminals";

export function useChatContinueInTerminal() {
  const { thread, streaming } = useChat();
  const { openLiveSession } = useTerminals();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const threadId = useRef(thread?.id);
  useEffect(() => {
    threadId.current = thread?.id;
    setError("");
    setPending(false);
  }, [thread?.id]);
  async function open() {
    if (!thread) return false;
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
          "This session is not available in Sessions yet. Try again after session discovery refreshes.",
        );
      await openLiveSession(session, thread.config.providerId);
      return true;
    } catch (cause) {
      if (threadId.current === thread.id)
        setError(cause instanceof Error ? cause.message : "Could not continue in terminal.");
      return false;
    } finally {
      if (threadId.current === thread.id) setPending(false);
    }
  }
  return {
    available: !!thread && ["codex", "claude"].includes(thread.config.agent),
    disabled: streaming || pending || !thread?.runtimeId,
    error,
    open,
  };
}

export function ChatContinueInTerminal({
  control,
  onOpen,
  labelled = false,
}: {
  control: ReturnType<typeof useChatContinueInTerminal>;
  onOpen?: () => void;
  labelled?: boolean;
}) {
  if (!control.available) return null;
  const button = (
    <button
      type="button"
      data-testid="chat-continue-terminal"
      aria-label="Continue in terminal"
      disabled={control.disabled}
      onClick={async () => {
        if (await control.open()) onOpen?.();
      }}
      className={
        labelled
          ? "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-on-surface-variant hover:bg-surface disabled:opacity-40"
          : "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface disabled:opacity-40"
      }
    >
      <SquareTerminal size={17} />
      {labelled && "Continue in terminal"}
    </button>
  );
  return (
    <div className="relative">
      {labelled ? button : <ActionHelp label="Continue in terminal">{button}</ActionHelp>}
      {control.error && (
        <p
          role="alert"
          className="absolute right-0 top-full z-50 w-64 rounded-md border border-border bg-background p-3 text-sm text-error"
        >
          {control.error}
        </p>
      )}
    </div>
  );
}
