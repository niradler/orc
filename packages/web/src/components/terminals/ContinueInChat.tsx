import { nativeChatAgent } from "@orc/core/chat";
import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type Terminal } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { useSessionHome } from "@/hooks/useSessionHome";

export function ContinueInChat({
  terminal,
  showLabel = false,
  onContinued,
  inWorkspace = false,
}: {
  terminal: Terminal;
  showLabel?: boolean;
  onContinued?: () => void;
  inWorkspace?: boolean;
}) {
  const chat = useChat();
  const home = useSessionHome();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!nativeChatAgent(terminal.kind)) return null;
  async function open() {
    if (!terminal.live_session_id) return;
    setPending(true);
    setError("");
    try {
      const thread = await api.chat.resume(terminal.live_session_id);
      chat.openThread(thread);
      if (inWorkspace) {
        home.go({ terminalId: null }, { chatThread: thread.id });
        onContinued?.();
        return;
      }
      const next = new URLSearchParams(params);
      next.delete("session");
      next.set("chat", "open");
      navigate({ search: next.toString() });
      onContinued?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue in chat.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-testid="terminal-continue-chat"
        aria-label={inWorkspace ? "Show chat" : "Resume"}
        title={
          terminal.live_session_id
            ? "Resume in chat"
            : "Waiting for the agent session to be registered"
        }
        disabled={pending || !terminal.live_session_id}
        onClick={() => void open()}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm text-on-surface-variant hover:bg-surface disabled:opacity-40"
      >
        <MessageSquare size={17} />
        {showLabel && (inWorkspace ? "Chat" : "Resume")}
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
