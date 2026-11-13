import { nativeChatResumeUnavailableReason } from "@orc/core/chat";
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Link2,
  MessageSquare,
  Pencil,
  Split,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type LiveSession } from "@/api/client";
import { RenameSession } from "@/components/RenameSession";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import { useUpdateLiveSession } from "@/hooks/useSessions";
import {
  forkCommand,
  resumeCommand,
  resumeUnavailableReason,
  scopedSessionPath,
} from "@/lib/live-sessions";
import {
  absoluteUrl,
  runningTerminalForSession,
  sessionTerminalPath,
  terminalPath,
} from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";

const ACTION =
  "inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-surface-highest disabled:opacity-50";

const ITEM = `${ACTION} min-h-11 w-full justify-start border-0`;

export function ResumeActions({ session }: { session: LiveSession }) {
  const { openLiveSession, info, terminals } = useTerminals();
  const navigate = useNavigate();
  const chat = useChat();
  const update = useUpdateLiveSession();
  const [params] = useSearchParams();
  const [pending, setPending] = useState(false);
  const [forkPending, setForkPending] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const command = resumeCommand(session);
  const fork = forkCommand(session);
  const existing = runningTerminalForSession(terminals, session.id);
  const scope = params.get("project") ?? session.project_id;
  // With nothing to resume the menu still holds rename and hide, so a dead or
  // noisy session can be cleared without opening it.
  const resumable = Boolean(command || existing || fork);
  const terminalReason = existing ? null : (info?.reason ?? "Integrated terminals are unavailable");
  const chatUnavailable =
    nativeChatResumeUnavailableReason(session.agent) ??
    (!command || !session.cwd ? "Session has no native session ID or working folder." : undefined);
  const busy = pending || chatPending || forkPending || update.isPending;
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function open(): Promise<void> {
    setError(null);
    if (existing) {
      navigate(scopedSessionPath(terminalPath(existing.id), scope));
      return;
    }
    setPending(true);
    try {
      await openLiveSession(session);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not open terminal");
    } finally {
      setPending(false);
    }
  }

  // A fork starts a new terminal and a new native session, so an existing resume
  // terminal for this session is neither reused nor affected.
  async function openFork(): Promise<void> {
    setError(null);
    setForkPending(true);
    try {
      await openLiveSession(session, undefined, true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not fork the session");
    } finally {
      setForkPending(false);
    }
  }

  async function setHidden(hidden: boolean): Promise<void> {
    setError(null);
    try {
      await update.mutateAsync({ id: session.id, hidden });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the session");
    }
  }

  async function copy(text: string, label: string): Promise<void> {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError("Clipboard access failed. Allow clipboard access and try again.");
    }
  }

  async function openChat(): Promise<void> {
    setChatPending(true);
    setError(null);
    try {
      chat.openThread(await api.chat.resume(session.id));
      const next = new URLSearchParams(params);
      next.delete("session");
      next.set("chat", "open");
      navigate({ search: next.toString() });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not resume in chat");
    } finally {
      setChatPending(false);
    }
  }

  const housekeeping = (close: () => void): ReactNode => (
    <>
      <button
        type="button"
        data-testid="rename-session"
        disabled={busy}
        onClick={() => {
          close();
          setRenaming(true);
        }}
        className={ITEM}
      >
        <Pencil size={13} />
        Rename
      </button>
      <button
        type="button"
        data-testid={session.hidden ? "unhide-session" : "hide-session"}
        disabled={busy}
        title={
          session.hidden
            ? "Show this session in the list again"
            : "Keep this session but leave it out of the list"
        }
        onClick={() => {
          close();
          void setHidden(!session.hidden);
        }}
        className={ITEM}
      >
        {session.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        {session.hidden ? "Show in list" : "Hide from list"}
      </button>
    </>
  );

  return (
    <div className="max-w-72 space-y-1 text-left">
      <div className="flex flex-wrap items-center gap-1">
        {resumable ? (
          <fieldset aria-label="Resume session" className="inline-flex">
            <button
              type="button"
              data-testid="open-chat-resume"
              disabled={busy || !!chatUnavailable}
              title={chatUnavailable ?? "Resume in chat"}
              onClick={() => void openChat()}
              className={`${ACTION} rounded-r-none`}
            >
              <MessageSquare size={13} />
              {chatPending ? "Resuming…" : "Resume"}
            </button>
            <SessionMenu
              triggerTestId="resume-actions-menu"
              triggerLabel="More session actions"
              triggerClass={`${ACTION} rounded-l-none border-l-0 px-2`}
              extra={(close) => (
                <>
                  <button
                    type="button"
                    data-testid="open-terminal-resume"
                    disabled={busy || (!existing && !info?.ready)}
                    title={terminalReason ?? "Resume in terminal"}
                    onClick={() => {
                      close();
                      void open();
                    }}
                    className={ITEM}
                  >
                    <SquareTerminal size={13} />
                    {pending ? "Resuming…" : "Terminal"}
                  </button>
                  {fork && (
                    <button
                      type="button"
                      data-testid="fork-terminal-session"
                      disabled={busy || !info?.ready}
                      title={
                        info?.ready
                          ? "Open a new session that starts from this history; the original stays untouched"
                          : (info?.reason ?? "Integrated terminals are unavailable")
                      }
                      onClick={() => {
                        close();
                        void openFork();
                      }}
                      className={ITEM}
                    >
                      <Split size={13} />
                      {forkPending ? "Forking…" : "Fork in terminal"}
                    </button>
                  )}
                  {command && (
                    <button
                      type="button"
                      data-testid="copy-resume"
                      className={ITEM}
                      title={command}
                      onClick={() => {
                        close();
                        void copy(command, "Resume command copied");
                      }}
                    >
                      {copied === "Resume command copied" ? (
                        <Check size={13} />
                      ) : (
                        <Copy size={13} />
                      )}
                      Copy resume command
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="copy-terminal-link"
                    className={ITEM}
                    aria-label="Copy terminal link"
                    title="Copy terminal link"
                    onClick={() => {
                      close();
                      void copy(
                        absoluteUrl(scopedSessionPath(sessionTerminalPath(session.id), scope)),
                        "Terminal link copied",
                      );
                    }}
                  >
                    <Link2 size={13} />
                    Copy terminal link
                  </button>
                </>
              )}
              housekeeping={housekeeping}
            />
          </fieldset>
        ) : (
          <div className="flex flex-wrap items-center gap-1">
            <span data-testid="resume-unavailable" className="max-w-56 text-xs text-outline">
              {resumeUnavailableReason(session)}
            </span>
            <SessionMenu
              triggerTestId="session-actions-menu"
              triggerLabel="Session actions"
              triggerClass={`${ACTION} px-2`}
              housekeeping={housekeeping}
            />
          </div>
        )}
      </div>
      {chatUnavailable && resumable && (
        <p data-testid="chat-resume-unavailable" className="text-xs text-outline">
          {chatUnavailable}
        </p>
      )}
      {copied && (
        <p role="status" data-testid="resume-feedback" className="text-xs text-outline">
          {copied}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-error wrap-break-word">
          {error}
        </p>
      )}
      <RenameSession session={session} open={renaming} onClose={() => setRenaming(false)} />
    </div>
  );
}

function SessionMenu({
  triggerTestId,
  triggerLabel,
  triggerClass,
  extra,
  housekeeping,
}: {
  triggerTestId: string;
  triggerLabel: string;
  triggerClass: string;
  extra?: (close: () => void) => ReactNode;
  housekeeping: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={triggerTestId}
          aria-label={triggerLabel}
          className={triggerClass}
        >
          <ChevronDown size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={4}
        collisionPadding={8}
        aria-label="Session actions"
        data-testid="resume-actions-dropdown"
        className="z-50 w-56 rounded-md border border-border bg-surface-high p-1 shadow-lg"
      >
        {extra?.(close)}
        {housekeeping(close)}
      </PopoverContent>
    </Popover>
  );
}
