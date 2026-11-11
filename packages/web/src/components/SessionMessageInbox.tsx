import {
  SESSION_MESSAGE_MAX_BODY,
  type SessionMessage,
  sessionMessageHookSupported,
} from "@orc/core/session-messages";
import { ChevronDown, ChevronRight, ChevronUp, Send, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { LiveSession } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import {
  useCancelSessionMessage,
  useMoveSessionMessage,
  useSendSessionMessage,
  useSessionMessages,
} from "@/hooks/useSessions";
import { formatWhen } from "@/lib/live-sessions";

const STATE_LABEL: Record<SessionMessage["state"], string> = {
  queued: "queued",
  delivering: "delivering",
  delivered: "delivered",
  cancelled: "cancelled",
  interrupted: "interrupted",
  failed: "failed",
};

const STATE_STYLE: Record<SessionMessage["state"], string> = {
  queued: "text-primary",
  delivering: "text-tertiary",
  delivered: "text-outline",
  cancelled: "text-outline",
  interrupted: "text-tertiary",
  failed: "text-error",
};

export function SessionMessageInbox({ session, live }: { session: LiveSession; live: boolean }) {
  const { data: messages = [], error } = useSessionMessages(session.id, live);
  const send = useSendSessionMessage(session.id);
  const cancel = useCancelSessionMessage(session.id);
  const move = useMoveSessionMessage(session.id);
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");

  const supported = session.status === "stopped" || sessionMessageHookSupported(session.agent);
  const queued = messages.filter((message) => message.state === "queued").length;
  const delivering = messages.filter((message) => message.state === "delivering").length;
  const summary = queued
    ? `${queued} queued`
    : delivering
      ? "delivering"
      : messages.length
        ? "none queued"
        : "empty";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate(body, {
      onSuccess: () => {
        setDraft("");
        setComposing(false);
        setOpen(true);
      },
    });
  };

  return (
    <section data-testid="session-messages" className="mt-2 border-t border-border pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="session-messages-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex min-h-11 items-center gap-1.5 font-label text-xs font-medium text-on-surface-variant hover:text-on-surface"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          )}
          Messages
          <span className="font-normal text-outline">{summary}</span>
        </button>
        <HelpPopover label="session messages" testId="session-messages-help">
          A message is delivered to this session at its next safe point: after its current tool
          call, or when an ended session is resumed. It is not approval, and the agent cannot use it
          to change configuration.
        </HelpPopover>
        <button
          type="button"
          data-testid="session-message-compose"
          disabled={!supported}
          onClick={() => {
            setComposing(true);
            setOpen(true);
          }}
          className="ml-auto inline-flex min-h-11 items-center gap-1.5 px-2 font-label text-xs font-medium text-primary hover:text-on-surface disabled:text-outline"
        >
          <Send className="h-3.5 w-3.5" aria-hidden />
          Send message
        </button>
      </div>

      {!supported && (
        <p data-testid="session-messages-unsupported" className="px-1 pb-2 text-xs text-outline">
          {session.agent} has no safe delivery point while it is running. Send a message after this
          session ends.
        </p>
      )}

      {open && (
        <div className="space-y-2 pb-2">
          {composing && supported && (
            <form onSubmit={submit} className="space-y-2">
              <textarea
                data-testid="session-message-input"
                aria-label="Message to this session"
                value={draft}
                maxLength={SESSION_MESSAGE_MAX_BODY}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Delivered at the session's next safe point"
                className="min-h-[72px] w-full resize-y rounded-lg border border-control-border bg-background px-2 py-2 font-body text-xs text-on-surface"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-label text-[10px] text-outline tabular-nums">
                  {draft.length}/{SESSION_MESSAGE_MAX_BODY}
                </span>
                <button
                  type="submit"
                  data-testid="session-message-send"
                  disabled={!draft.trim() || send.isPending}
                  className="min-h-11 rounded-lg border border-control-border px-3 font-label text-xs font-medium text-primary hover:bg-surface-bright disabled:text-outline"
                >
                  {send.isPending ? "Sending…" : "Send"}
                </button>
                <button
                  type="button"
                  data-testid="session-message-compose-cancel"
                  onClick={() => {
                    setComposing(false);
                    setDraft("");
                    send.reset();
                  }}
                  className="min-h-11 px-2 font-label text-xs font-medium text-outline hover:text-on-surface"
                >
                  Cancel
                </button>
              </div>
              {send.error && (
                <p data-testid="session-message-error" className="text-xs text-error">
                  {send.error.message}
                </p>
              )}
            </form>
          )}

          {error ? (
            <p data-testid="session-messages-error" className="text-xs text-error">
              Could not load messages: {error.message}
            </p>
          ) : messages.length === 0 ? (
            <p data-testid="session-messages-empty" className="px-1 text-xs text-outline">
              No messages queued.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {messages.slice(0, 20).map((message) => (
                <li
                  key={message.id}
                  data-testid="session-message-row"
                  data-state={message.state}
                  className="flex items-start gap-2 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-label text-[10px] uppercase tracking-wide">
                      <span
                        data-testid="session-message-state"
                        className={STATE_STYLE[message.state]}
                      >
                        {STATE_LABEL[message.state]}
                      </span>
                      <span className="text-outline">{message.sender_label}</span>
                      {message.hop > 0 && <span className="text-outline">hop {message.hop}</span>}
                      <span className="text-outline normal-case tracking-normal">
                        {formatWhen(new Date(message.created_at).toISOString())}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 font-body text-xs text-on-surface-variant wrap-break-word whitespace-pre-wrap">
                      {message.body}
                    </p>
                    {message.delivery_error && (
                      <p className="mt-1 line-clamp-2 text-xs text-error">
                        {message.delivery_error}
                      </p>
                    )}
                  </div>
                  {message.state === "queued" && (
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        aria-label="Move message up"
                        title="Move up"
                        disabled={move.isPending}
                        onClick={() => move.mutate({ messageId: message.id, direction: "up" })}
                        className="min-h-11 min-w-9 text-outline hover:text-on-surface disabled:opacity-50"
                      >
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label="Move message down"
                        title="Move down"
                        disabled={move.isPending}
                        onClick={() => move.mutate({ messageId: message.id, direction: "down" })}
                        className="min-h-11 min-w-9 text-outline hover:text-on-surface disabled:opacity-50"
                      >
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel message"
                        title="Cancel"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(message.id)}
                        className="min-h-11 min-w-9 text-outline hover:text-error disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
