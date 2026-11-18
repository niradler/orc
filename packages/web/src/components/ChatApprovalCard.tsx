import { useState } from "react";
import { Markdown } from "@/components/Markdown";

const button =
  "min-h-8 rounded-md border border-control-border px-3 disabled:opacity-50 max-md:min-h-11 pointer-coarse:min-h-11";
const primary =
  "min-h-8 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50 max-md:min-h-11 pointer-coarse:min-h-11";

function FeedbackForm({
  label,
  submit,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  submit: string;
  busy: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(text.trim());
      }}
    >
      <input
        data-testid="chat-approval-feedback"
        aria-label={label}
        placeholder={label}
        autoComplete="off"
        value={text}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        className="min-h-11 min-w-0 flex-1 basis-40 rounded-md border border-control-border bg-background px-3 text-base sm:min-h-8 sm:text-sm"
      />
      <button
        type="submit"
        data-testid="chat-approval-feedback-send"
        disabled={busy || !text.trim()}
        className={primary}
      >
        {submit}
      </button>
      <button type="button" disabled={busy} className={button} onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

export function ChatPlanReview({
  plan,
  busy,
  acceptEdits,
  onApprove,
  onRevise,
}: {
  plan?: string;
  busy: boolean;
  acceptEdits: boolean;
  onApprove: (mode: "acceptEdits" | "default") => Promise<unknown>;
  onRevise: (feedback: string) => void;
}) {
  const [revising, setRevising] = useState(false);
  const [approving, setApproving] = useState(false);
  const approve = (mode: "acceptEdits" | "default") => {
    setApproving(true);
    void onApprove(mode).finally(() => setApproving(false));
  };
  return (
    <div
      data-testid="chat-plan-review"
      className="shrink-0 border-t border-outline-variant px-4 py-3 text-sm"
    >
      <p className="font-medium">Plan ready</p>
      {plan && (
        <div className="my-2 max-h-[35vh] overflow-auto rounded-md border border-outline-variant px-3 py-2">
          <Markdown chat>{plan}</Markdown>
        </div>
      )}
      {revising ? (
        <FeedbackForm
          label="What should change?"
          submit="Revise"
          busy={busy || approving}
          onSubmit={onRevise}
          onCancel={() => setRevising(false)}
        />
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {acceptEdits && (
            <button
              type="button"
              data-testid="chat-plan-approve-edits"
              disabled={busy || approving}
              className={primary}
              onClick={() => approve("acceptEdits")}
            >
              Approve, accept edits
            </button>
          )}
          <button
            type="button"
            data-testid="chat-plan-approve"
            disabled={busy || approving}
            className={acceptEdits ? button : primary}
            onClick={() => approve("default")}
          >
            Approve
          </button>
          <button
            type="button"
            data-testid="chat-plan-revise"
            disabled={busy || approving}
            className={button}
            onClick={() => setRevising(true)}
          >
            Revise
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatPermissionPrompt({
  tool,
  command,
  busy,
  allowSession,
  feedback,
  onRespond,
  onAllowAll,
}: {
  tool: string;
  command: string;
  busy: boolean;
  allowSession: boolean;
  feedback: boolean;
  onRespond: (decision: "approved" | "session" | "denied", feedback?: string) => void;
  onAllowAll?: () => void;
}) {
  const [denying, setDenying] = useState(false);
  return (
    <div
      data-testid="chat-permission"
      className="shrink-0 max-h-52 overflow-auto border-t border-outline-variant px-4 py-3 text-sm"
    >
      <p className="font-medium">Allow {tool}?</p>
      <pre className="my-2 max-h-20 overflow-auto whitespace-pre-wrap wrap-break-word text-xs">
        {command}
      </pre>
      {denying ? (
        <FeedbackForm
          label="Tell the agent what to do instead"
          submit="Deny"
          busy={busy}
          onSubmit={(text) => onRespond("denied", text)}
          onCancel={() => setDenying(false)}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="chat-permission-allow"
            disabled={busy}
            className={primary}
            onClick={() => onRespond("approved")}
          >
            Allow once
          </button>
          {allowSession && (
            <button
              type="button"
              data-testid="chat-permission-allow-session"
              disabled={busy}
              title="Do not ask again for this in this session"
              className={button}
              onClick={() => onRespond("session")}
            >
              Allow for session
            </button>
          )}
          {onAllowAll && (
            <button
              type="button"
              data-testid="chat-permission-allow-all"
              disabled={busy}
              title="Switch this session to full access / bypass permissions"
              className={button}
              onClick={onAllowAll}
            >
              Allow all
            </button>
          )}
          <button
            type="button"
            data-testid="chat-permission-deny"
            disabled={busy}
            className={button}
            onClick={() => onRespond("denied")}
          >
            Deny
          </button>
          {feedback && (
            <button
              type="button"
              data-testid="chat-permission-deny-reason"
              disabled={busy}
              className={button}
              onClick={() => setDenying(true)}
            >
              Deny with reason
            </button>
          )}
        </div>
      )}
    </div>
  );
}
