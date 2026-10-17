import { KB_COMMENT_STATUSES, type KbComment, type KbCommentStatus } from "@orc/core/kb";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client";
import { useAction } from "@/components/kb/KbDialogs";
import { KbSetupRow } from "@/components/kb/KbSetupRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useInvalidateKb, useKbComments } from "@/hooks/useKnowledge";
import { cn } from "@/lib/utils";

/** Open comments wait for an agent or a person, so they carry the review color. */
const STATUS_DOT: Record<KbCommentStatus, string> = {
  open: "bg-warning",
  resolved: "bg-secondary",
  dismissed: "bg-muted-foreground",
};

function StatusDot({ status }: { status: KbCommentStatus }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />;
}

/**
 * Comments on a knowledge base, or on one document when `documentId` is set. Collapsed to a
 * row with a count per status; a count opens the list filtered to that status. Closing a
 * comment needs a one-line reply; the server checks that the UI may edit this knowledge base.
 */
export function KbComments({
  kbId,
  documentId,
  onOpenDocument,
  heading = "h3",
  compact = false,
}: {
  kbId: string;
  documentId?: string;
  onOpenDocument?: (documentId: string) => void;
  heading?: "h2" | "h3";
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<KbCommentStatus | null>(null);
  const comments = useKbComments(kbId, {
    ...(documentId ? { document_id: documentId } : {}),
    ...(filter ? { status: filter } : {}),
  });
  const counts = comments.data?.counts;
  const total = counts ? counts.open + counts.resolved + counts.dismissed : 0;

  function show(status: KbCommentStatus) {
    const same = expanded && filter === status;
    setFilter(same ? null : status);
    setExpanded(true);
  }

  return (
    <KbSetupRow
      title="Comments"
      testId="kb-comments"
      toggleTestId="kb-comments-toggle"
      heading={heading}
      compact={compact}
      expanded={expanded}
      onExpandedChange={setExpanded}
      summary={
        <>
          {counts && total === 0 && (
            <span className="text-outline" data-testid="kb-comments-none">
              None yet
            </span>
          )}
          {counts &&
            KB_COMMENT_STATUSES.filter((s) => counts[s] > 0).map((s) => (
              <button
                type="button"
                key={s}
                data-testid={`kb-comments-count-${s}`}
                aria-pressed={expanded && filter === s}
                aria-label={`${counts[s]} ${s} ${counts[s] === 1 ? "comment" : "comments"}`}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 rounded px-1.5",
                  expanded && filter === s
                    ? "bg-surface-highest text-on-surface"
                    : "text-outline hover:bg-surface-high",
                )}
                onClick={() => show(s)}
              >
                <StatusDot status={s} />
                <span className="tabular-nums text-on-surface">{counts[s]}</span>
                {s}
              </button>
            ))}
          {comments.error && (
            <span role="alert" className="text-error" data-testid="kb-comments-error">
              {(comments.error as Error).message}
            </span>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <AddComment kbId={kbId} documentId={documentId} />
        {/* Unfiltered, an empty list is already said by "None yet" in the summary. */}
        {filter && comments.data?.comments.length === 0 && (
          <p className="text-outline" data-testid="kb-comments-empty">
            No {filter} comments.
          </p>
        )}
        <ul className="divide-y divide-outline-variant">
          {comments.data?.comments.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              showDocument={!documentId}
              onOpenDocument={onOpenDocument}
            />
          ))}
        </ul>
      </div>
    </KbSetupRow>
  );
}

function AddComment({ kbId, documentId }: { kbId: string; documentId?: string }) {
  const invalidate = useInvalidateKb();
  const add = useAction();
  const [body, setBody] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const created = await add.run(() =>
      api.kb.addComment(kbId, {
        body: body.trim(),
        ...(documentId ? { document_id: documentId } : {}),
      }),
    );
    if (!created) return;
    setBody("");
    await invalidate();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea
        aria-label={documentId ? "Comment on this document" : "Comment on this knowledge base"}
        placeholder={documentId ? "Ask for a change to this document" : "Ask for a change"}
        data-testid="kb-comment-input"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        maxLength={10_000}
      />
      {body.trim() && (
        <Button
          type="submit"
          size="sm"
          variant="outline"
          data-testid="kb-comment-add"
          disabled={add.pending}
        >
          Add comment
        </Button>
      )}
      {add.error && (
        <p role="alert" className="text-error" data-testid="kb-comment-add-error">
          {add.error}
        </p>
      )}
    </form>
  );
}

function CommentRow({
  comment: c,
  showDocument,
  onOpenDocument,
}: {
  comment: KbComment;
  showDocument: boolean;
  onOpenDocument?: (documentId: string) => void;
}) {
  const invalidate = useInvalidateKb();
  const action = useAction();
  const [closing, setClosing] = useState<"resolved" | "dismissed" | null>(null);
  const [reply, setReply] = useState("");

  async function close(e: FormEvent) {
    e.preventDefault();
    if (!closing) return;
    const status = closing;
    const res = await action.run(() => api.kb.closeComment(c.id, { status, reply: reply.trim() }));
    if (!res) return;
    setClosing(null);
    setReply("");
    await invalidate();
  }
  async function reopen() {
    const res = await action.run(() => api.kb.reopenComment(c.id));
    if (res) await invalidate();
  }

  return (
    <li data-testid="kb-comment" data-status={c.status} className="min-w-0 space-y-1 py-2">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-outline">
        <span className="inline-flex items-center gap-1.5 text-on-surface">
          <StatusDot status={c.status} />
          <span data-testid="kb-comment-status">{c.status}</span>
        </span>
        <span className="min-w-0 break-words">
          {/* The source only adds information when it differs from the author, e.g. "ui". */}
          {c.source === c.author ? c.author : `${c.author} via ${c.source}`} ·{" "}
          {new Date(c.created_at).toLocaleString()}
          {showDocument && c.document_id && (
            <>
              {" · on "}
              {onOpenDocument ? (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => c.document_id && onOpenDocument(c.document_id)}
                >
                  {c.document_title ?? "a deleted document"}
                </button>
              ) : (
                (c.document_title ?? "a deleted document")
              )}
            </>
          )}
        </span>
      </p>
      <p className="whitespace-pre-wrap break-words">{c.body}</p>
      {c.reply && (
        <p className="break-words text-xs" data-testid="kb-comment-reply-text">
          <span className="text-outline">
            {c.status === "dismissed" ? "Dismissed" : "Resolved"}
            {c.resolved_by ? ` by ${c.resolved_by}` : ""}:
          </span>{" "}
          {c.reply}
        </p>
      )}
      {closing ? (
        <form onSubmit={close} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={closing === "resolved" ? "Resolution reply" : "Reason for dismissing"}
            placeholder={closing === "resolved" ? "What changed" : "Why not"}
            data-testid="kb-comment-reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            maxLength={4000}
            autoFocus
            className="min-w-0 flex-1 basis-48"
          />
          <Button
            type="submit"
            size="sm"
            data-testid="kb-comment-close-submit"
            disabled={!reply.trim() || action.pending}
          >
            {closing === "resolved" ? "Resolve" : "Dismiss"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setClosing(null);
              setReply("");
              action.setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : c.status === "open" ? (
        <div className="-ml-2 flex flex-wrap">
          <Button
            size="sm"
            variant="ghost"
            data-testid="kb-comment-resolve"
            onClick={() => setClosing("resolved")}
          >
            Resolve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="kb-comment-dismiss"
            onClick={() => setClosing("dismissed")}
          >
            Dismiss
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2"
          data-testid="kb-comment-reopen"
          onClick={reopen}
          disabled={action.pending}
        >
          Reopen
        </Button>
      )}
      {action.error && (
        <p role="alert" className="text-xs text-error" data-testid="kb-comment-error">
          {action.error}
        </p>
      )}
    </li>
  );
}
