import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Copy, Link2, MessageSquare, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type LiveSession } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { resumeCommand, resumeUnavailableReason, scopedSessionPath } from "@/lib/live-sessions";
import {
  absoluteUrl,
  runningTerminalForSession,
  sessionTerminalPath,
  terminalPath,
} from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";

const ACTION =
  "inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-surface-highest disabled:opacity-50";

export function ResumeActions({ session }: { session: LiveSession }) {
  const { openLiveSession, info, terminals } = useTerminals();
  const navigate = useNavigate();
  const chat = useChat();
  const [params] = useSearchParams();
  const [pending, setPending] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const command = resumeCommand(session);
  const existing = runningTerminalForSession(terminals, session.id);
  const scope = params.get("project") ?? session.project_id;
  const chatUnavailable = !["claude", "codex"].includes(session.agent)
    ? "Chat currently supports Claude and Codex sessions."
    : !command || !session.cwd
      ? "Session has no native session ID or working folder."
      : session.status === "running" || session.status === "idle"
        ? "End the original agent session before resuming it in chat."
        : undefined;
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

  async function copy(text: string, label: string): Promise<void> {
    setMenuOpen(false);
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError("Clipboard access failed. Allow clipboard access and try again.");
    }
  }

  async function openChat(): Promise<void> {
    setMenuOpen(false);
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

  if (!command && !existing)
    return (
      <span data-testid="resume-unavailable" className="block max-w-64 text-xs text-outline">
        {resumeUnavailableReason(session)}
      </span>
    );

  return (
    <div className="max-w-72 space-y-1 text-left">
      <fieldset aria-label="Resume session" className="inline-flex">
        <button
          type="button"
          data-testid="open-terminal-resume"
          disabled={pending || chatPending || (!existing && !info?.ready)}
          onClick={() => void open()}
          className={`${ACTION} rounded-r-none`}
        >
          <SquareTerminal size={13} />
          {pending ? "Resuming…" : "Resume in terminal"}
        </button>
        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="resume-actions-menu"
              aria-label="More session actions"
              className={`${ACTION} rounded-l-none border-l-0 px-2`}
            >
              <ChevronDown size={13} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={4}
              collisionPadding={8}
              aria-label="Session actions"
              data-testid="resume-actions-dropdown"
              className="z-50 w-56 rounded-md border border-border bg-surface-high p-1 shadow-lg"
            >
              <button
                type="button"
                data-testid="open-chat-resume"
                disabled={pending || chatPending || !!chatUnavailable}
                title={chatUnavailable}
                onClick={() => void openChat()}
                className={`${ACTION} min-h-11 w-full justify-start border-0`}
              >
                <MessageSquare size={13} />
                {chatPending ? "Resuming…" : "Continue in chat"}
              </button>
              {command && (
                <button
                  type="button"
                  data-testid="copy-resume"
                  className={`${ACTION} w-full justify-start border-0`}
                  title={command}
                  onClick={() => void copy(command, "Resume command copied")}
                >
                  {copied === "Resume command copied" ? <Check size={13} /> : <Copy size={13} />}
                  Copy resume command
                </button>
              )}
              <button
                type="button"
                data-testid="copy-terminal-link"
                className={`${ACTION} w-full justify-start border-0`}
                aria-label="Copy terminal link"
                title="Copy terminal link"
                onClick={() =>
                  void copy(
                    absoluteUrl(scopedSessionPath(sessionTerminalPath(session.id), scope)),
                    "Terminal link copied",
                  )
                }
              >
                <Link2 size={13} />
                Copy terminal link
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </fieldset>
      {info && !info.ready && !existing && (
        <p className="text-xs text-outline">
          {info.reason ??
            "Integrated terminals unavailable. Use the copied command in your own terminal."}
        </p>
      )}
      {copied && (
        <p role="status" data-testid="resume-feedback" className="text-xs text-outline">
          {copied}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-error break-words">
          {error}
        </p>
      )}
    </div>
  );
}
