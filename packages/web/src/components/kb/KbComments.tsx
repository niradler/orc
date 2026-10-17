import type { KbComment, KbCommentStatus } from "@orc/core/kb";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client";
import { useAction } from "@/components/kb/KbDialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useInvalidateKb, useKbComments } from "@/hooks/useKnowledge";

type Filter = KbCommentStatus | "all";

/**
 * Comments on a knowledge base, or on one document when `documentId` is set. Closing a comment
 * needs a one-line reply; the server checks that the UI may edit this knowledge base.
 */
export function KbComments({
  kbId,
  documentId,
  onOpenDocument,
  heading: Heading = "h3",
}: {
  kbId: string;
  documentId?: string;
  onOpenDocument?: (documentId: string) => void;
  heading?: "h2" | "h3";
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const comments = useKbComments(kbId, {
    ...(documentId ? { document_id: documentId } : {}),
    ...(filter === "all" ? {} : { status: filter }),
  });
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
    <section
      data-testid="kb-comments"
      aria-labelledby={`kb-comments-heading-${documentId ?? kbId}`}
      className="min-w-0 space-y-2 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id={`kb-comments-heading-${documentId ?? kbId}`} className="font-medium">
          Comments
        </Heading>
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger
            aria-label="Comment status"
            data-testid="kb-comments-filter"
            className="h-8 w-32"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>
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
        <Button
          type="submit"
          size="sm"
          variant="outline"
          data-testid="kb-comment-add"
          disabled={!body.trim() || add.pending}
        >
          Comment
        </Button>
      </form>
      {(add.error || comments.error) && (
        <p role="alert" className="text-error" data-testid="kb-comments-error">
          {add.error ?? (comments.error as Error).message}
        </p>
      )}
      {comments.data?.length === 0 && (
        <p className="text-outline" data-testid="kb-comments-empty">
          {filter === "all" ? "No comments." : `No ${filter} comments.`}
        </p>
      )}
      <ul className="space-y-3">
        {comments.data?.map((c) => (
          <CommentRow
            key={c.id}
            comment={c}
            showDocument={!documentId}
            onOpenDocument={onOpenDocument}
          />
        ))}
      </ul>
    </section>
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
    <li data-testid="kb-comment" data-status={c.status} className="min-w-0 space-y-1">
      <p className="whitespace-pre-wrap break-words">{c.body}</p>
      <p className="break-words text-xs text-outline">
        {c.author} · {c.source} · {new Date(c.created_at).toLocaleString()} ·{" "}
        <span data-testid="kb-comment-status">{c.status}</span>
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
      </p>
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
        <div className="flex flex-wrap gap-1">
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
