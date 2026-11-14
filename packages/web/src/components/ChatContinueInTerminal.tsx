import { useQuery } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Terminal } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { useChat } from "@/hooks/useChat";
import { runningTerminalForSession } from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";

/** Continues the chat in a native terminal. Inside the chat page the caller swaps
 *  the chat body to that terminal, so the conversation and the PTY stay one view. */
export function useChatContinueInTerminal({
  inChat = false,
  onOpened,
}: {
  inChat?: boolean;
  onOpened?: (terminal: Terminal) => void;
} = {}) {
  const { thread, streaming, refreshing, reconnecting, responding } = useChat();
  const { openLiveSession, terminals } = useTerminals();
  // The same query ChatPanel uses: a turn may still run in another browser or in
  // the native agent after this chat's stream has closed.
  const sessionState = useQuery({
    queryKey: ["chat-threads", "session", thread?.id],
    queryFn: () => api.chat.session(thread?.id ?? ""),
    enabled: !!thread?.runtimeId,
  });
  const sessionRunning = !!sessionState.data?.running;
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
      const matches = () =>
        api.sessions
          .live({ active: false, limit: 5000 })
          .then(({ sessions }) =>
            sessions.find(
              (session) =>
                session.session_id === thread.runtimeId &&
                session.agent === thread.config.agent &&
                session.host === thread.host,
            ),
          );
      let session = await matches();
      if (!session) {
        // Discovery polls agent storage, so a fresh session (notably OpenCode)
        // may not be listed yet. Sync once and retry before giving up.
        await api.sessions.sync().catch(() => {});
        session = await matches();
      }
      if (!session)
        throw new Error(
          "This session is not available in Sessions yet. Try again after session discovery refreshes.",
        );
      const existing = runningTerminalForSession(terminals, session.id);
      if (existing && inChat) {
        onOpened?.(existing);
        return true;
      }
      const terminal = await openLiveSession(session, thread.config.providerId, false, {
        navigate: !inChat,
      });
      if (inChat) onOpened?.(terminal);
      return true;
    } catch (cause) {
      if (threadId.current === thread.id)
        setError(cause instanceof Error ? cause.message : "Could not continue in terminal.");
      return false;
    } finally {
      if (threadId.current === thread.id) setPending(false);
    }
  }
  const reason = streaming
    ? "Available when the current response finishes."
    : sessionRunning
      ? "Wait for the session to become idle."
      : !thread?.runtimeId
        ? "Send a message before continuing in a terminal."
        : undefined;
  return {
    available: !!thread && ["codex", "claude", "opencode"].includes(thread.config.agent),
    disabled:
      streaming ||
      refreshing ||
      reconnecting ||
      responding ||
      sessionRunning ||
      pending ||
      !thread?.runtimeId,
    reason,
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
      title={control.reason}
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
    <div className={labelled ? undefined : "relative"}>
      {labelled ? (
        button
      ) : (
        <ActionHelp label="Continue in terminal" description={control.reason}>
          {button}
        </ActionHelp>
      )}
      {control.error &&
        (labelled ? (
          // Inside the actions menu: an absolute popup wider than the menu is
          // clipped by its scroll area, so keep the message in flow.
          <p
            role="alert"
            data-testid="chat-continue-terminal-error"
            className="px-2 pb-1 text-xs text-error wrap-break-word"
          >
            {control.error}
          </p>
        ) : (
          <p
            role="alert"
            data-testid="chat-continue-terminal-error"
            className="absolute right-0 top-full z-50 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-background p-3 text-sm text-error wrap-break-word"
          >
            {control.error}
          </p>
        ))}
    </div>
  );
}
