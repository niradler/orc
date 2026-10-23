import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns2, ExternalLink, List, MessageSquarePlus, RefreshCw, X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { api, type PullCommentInput, type PullReview } from "@/api/client";
import { type DiffLine, diffLines, pairDiffLines } from "@/lib/git-diff";
import { TerminalSelect } from "./TerminalSelect";

type CommentTarget = { path: string; line: number; side: "LEFT" | "RIGHT"; head: string };
type ReviewComment = PullReview["comments"][number];

function CommentComposer({
  terminalId,
  number,
  input,
  label,
  onSent,
  onClose,
  drafts,
  disabled = false,
}: {
  terminalId: string;
  number: number;
  input: PullCommentInput;
  label: string;
  onSent: () => void;
  onClose: () => void;
  drafts: Map<string, string>;
  disabled?: boolean;
}) {
  const draftKey =
    input.kind === "inline"
      ? `inline:${input.path}:${input.side}:${input.line}`
      : input.kind === "reply"
        ? `reply:${input.comment_id}`
        : "discussion";
  const [body, setBody] = useState(() => drafts.get(draftKey) ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textarea.current?.focus();
  }, []);
  const send = useMutation({
    mutationKey: ["git", terminalId, "pull", number, "comment"],
    mutationFn: () => api.git.postPullComment(terminalId, number, { ...input, body }),
    onSuccess: () => {
      setBody("");
      drafts.delete(draftKey);
      onSent();
    },
    retry: false,
  });
  const pending =
    useIsMutating({ mutationKey: ["git", terminalId, "pull", number, "comment"] }) > 0;
  return (
    <form
      className="pr-comment-composer"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing && !pending) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (body.trim() && !pending && !disabled) send.mutate();
      }}
    >
      <div className="pr-composer-heading">
        <label htmlFor={`pr-draft-${terminalId}-${number}-${draftKey}`}>{label}</label>
        <button
          type="button"
          className="git-icon-button"
          data-testid="pr-comment-close"
          aria-label="Close comment editor"
          title="Close comment editor (draft retained)"
          disabled={pending}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <textarea
        ref={textarea}
        id={`pr-draft-${terminalId}-${number}-${draftKey}`}
        data-testid="pr-comment-input"
        className="terminal-field"
        value={body}
        maxLength={20_000}
        onChange={(event) => {
          setBody(event.target.value);
          drafts.set(draftKey, event.target.value);
        }}
        placeholder="Write a comment…"
        rows={3}
        disabled={pending}
      />
      <div>
        <button
          type="submit"
          data-testid="pr-comment-send"
          disabled={!body.trim() || pending || disabled}
        >
          {pending ? "Sending…" : "Send comment"}
        </button>
      </div>
      {send.error && (
        <p role="alert">
          {send.error.message} Your draft is retained. Check GitHub before retrying if the result is
          uncertain.
        </p>
      )}
    </form>
  );
}

function Comment({ comment }: { comment: ReviewComment }) {
  const safeUrl = /^https:\/\/github\.com\//.test(comment.html_url) ? comment.html_url : undefined;
  return (
    <article className="pr-comment" data-testid="pr-comment">
      <div>
        <strong>{comment.user?.login ?? "Deleted user"}</strong>
        {comment.state && <span>{comment.state.replace(/_/g, " ").toLowerCase()}</span>}
        {comment.path && (
          <span>
            {comment.path}:{comment.line ?? comment.original_line ?? "file"}
            {comment.line === null ? " · Outdated" : ""}
          </span>
        )}
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open comment on GitHub"
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
      <p>{comment.body}</p>
    </article>
  );
}

function ReviewDiff({
  patch,
  split,
  onComment,
  commentable,
  inline,
}: {
  patch: string;
  split: boolean;
  onComment: (line: number, side: "LEFT" | "RIGHT", trigger: HTMLButtonElement) => void;
  commentable: boolean;
  inline?: { line: number; side: "LEFT" | "RIGHT"; content: ReactNode };
}) {
  const lines = diffLines(patch).filter((line) => line.kind !== "meta");
  const matches = (line: DiffLine | null) =>
    inline && (inline.side === "LEFT" ? line?.old : line?.next) === inline.line;
  const hasAnchor = inline && lines.some(matches);
  function gutter(line: DiffLine | null, side: "LEFT" | "RIGHT") {
    const number = side === "LEFT" ? line?.old : line?.next;
    if (!number) return <span className="pr-line-number" />;
    return (
      <button
        type="button"
        data-testid="pr-comment-line"
        data-line={number}
        data-side={side}
        className="pr-line-number"
        disabled={!commentable}
        title={`Comment on ${side === "LEFT" ? "old" : "new"} line ${number}`}
        aria-label={`Comment on ${side === "LEFT" ? "old" : "new"} line ${number}`}
        onClick={(event) => onComment(number, side, event.currentTarget)}
      >
        {number}
      </button>
    );
  }
  return (
    <div data-testid="pr-diff" className={`pr-diff ${split ? "pr-diff-split" : ""}`}>
      {split
        ? pairDiffLines(lines).map((pair) =>
            pair.full ? (
              <div key={pair.id} className="pr-diff-hunk">
                {pair.full.text}
              </div>
            ) : (
              <Fragment key={pair.id}>
                <div className="pr-diff-pair">
                  {(["left", "right"] as const).map((side) => {
                    const line = pair[side];
                    return (
                      <div key={side} className={`pr-diff-line pr-line-${line?.kind ?? "empty"}`}>
                        {gutter(line, side === "left" ? "LEFT" : "RIGHT")}
                        <code>{line?.text.slice(1) ?? " "}</code>
                      </div>
                    );
                  })}
                </div>
                {inline && matches(inline.side === "LEFT" ? pair.left : pair.right) && (
                  <div className="pr-diff-comment-row">{inline.content}</div>
                )}
              </Fragment>
            ),
          )
        : lines.map((line) =>
            line.kind === "hunk" ? (
              <div key={line.id} className="pr-diff-hunk">
                {line.text}
              </div>
            ) : (
              <Fragment key={line.id}>
                <div className={`pr-diff-line pr-line-${line.kind}`}>
                  {gutter(line, "LEFT")}
                  {gutter(line, "RIGHT")}
                  <code>{line.text}</code>
                </div>
                {inline && matches(line) && (
                  <div className="pr-diff-comment-row">{inline.content}</div>
                )}
              </Fragment>
            ),
          )}
      {inline && !hasAnchor && (
        <div className="pr-diff-comment-row">
          <p className="pr-review-notice">
            The selected line is no longer in this diff. Choose a current line to continue.
          </p>
          {inline.content}
        </div>
      )}
    </div>
  );
}

export function PullReviewPanel({
  terminalId,
  number,
  active,
}: {
  terminalId: string;
  number: number;
  active: boolean;
}) {
  const client = useQueryClient();
  const commentPending =
    useIsMutating({ mutationKey: ["git", terminalId, "pull", number, "comment"] }) > 0;
  const drafts = useRef(new Map<string, string>());
  const queryKey = ["git", terminalId, "pull", number] as const;
  const review = useQuery({
    queryKey,
    queryFn: () => api.git.pullReview(terminalId, number),
    enabled: active,
    staleTime: 30_000,
    retry: false,
  });
  const [tab, setTab] = useState("files");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [reply, setReply] = useState<number | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const scroll = useRef<HTMLDivElement>(null);
  const inlineTrigger = useRef<HTMLButtonElement | null>(null);
  const replyTrigger = useRef<HTMLButtonElement | null>(null);
  const discussionTrigger = useRef<HTMLButtonElement>(null);
  const data = review.data;
  const files =
    data?.files.filter((file) =>
      `${file.filename} ${file.previous_filename ?? ""}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  const file =
    files.find((file) => file.filename === selected) ??
    files.find((file) => file.patch) ??
    files[0];
  const onSent = () => {
    setSent(true);
    void client.invalidateQueries({ queryKey });
  };
  const selectFile = (path: string) => {
    setSelected(path);
    setSent(false);
    requestAnimationFrame(() => fileRefs.current.get(path)?.scrollIntoView({ block: "start" }));
  };
  return (
    <div
      data-testid="pr-review-panel"
      className="pr-review-panel"
      style={{ display: active ? undefined : "none" }}
    >
      <header className="pr-review-heading">
        <div>
          <strong>{data?.title ?? `Pull request #${number}`}</strong>
          {data && (
            <p>
              {data.author} · {data.branch} into {data.base} · {data.head.slice(0, 7)}
            </p>
          )}
        </div>
        <button
          type="button"
          className="git-icon-button"
          data-testid="pr-refresh"
          title="Refresh PR"
          aria-label="Refresh PR"
          onClick={() => void review.refetch()}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {review.isPending && <p className="git-review-empty">Loading pull request…</p>}
      {review.error && (
        <p role="alert" className="git-review-error">
          {review.error.message}
        </p>
      )}
      {data && (
        <>
          <fieldset className="pr-review-tabs" aria-label="Pull request review">
            <button
              type="button"
              aria-pressed={tab === "files"}
              data-testid="pr-files-tab"
              onClick={() => setTab("files")}
            >
              Files changed <span>{data.changed_files}</span>
            </button>
            <button
              type="button"
              aria-pressed={tab === "discussion"}
              data-testid="pr-discussion-tab"
              onClick={() => setTab("discussion")}
            >
              Discussion{" "}
              <span>{data.discussion.length + data.reviews.length + data.comments.length}</span>
            </button>
          </fieldset>
          {data.truncated && (
            <p className="pr-review-notice">
              Showing limited results. Open GitHub for the full review.
            </p>
          )}
          {data.state !== "open" && (
            <p className="pr-review-notice">
              This PR is {data.state}. Comments are read-only here.
            </p>
          )}
          {sent && (
            <p role="status" className="pr-review-notice">
              Comment sent to GitHub.
            </p>
          )}
          <div className="pr-files-view" style={{ display: tab === "files" ? undefined : "none" }}>
            <div className="git-review-filters">
              <input
                data-testid="pr-file-filter"
                className="terminal-field"
                aria-label="Filter PR files"
                placeholder="Find a PR file…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <fieldset className="git-diff-layout" aria-label="PR diff layout">
                <button
                  type="button"
                  data-testid="pr-layout-unified"
                  aria-pressed={!split}
                  onClick={() => setSplit(false)}
                  title="Unified"
                >
                  <List size={14} />
                  <span>Unified</span>
                </button>
                <button
                  type="button"
                  data-testid="pr-layout-split"
                  aria-pressed={split}
                  onClick={() => setSplit(true)}
                  title="Split"
                >
                  <Columns2 size={14} />
                  <span>Split</span>
                </button>
              </fieldset>
            </div>
            <div className="pr-file-picker">
              <TerminalSelect
                aria-label="PR file"
                data-testid="pr-file-select"
                value={file?.filename ?? ""}
                onChange={(event) => selectFile(event.target.value)}
              >
                {files.map((file) => (
                  <option key={file.filename} value={file.filename}>
                    {file.filename}
                  </option>
                ))}
              </TerminalSelect>
            </div>
            <div className="git-review-body">
              <aside className="git-change-list" aria-label="PR changed files">
                <div className="git-list-heading">
                  Files changed<span>{files.length}</span>
                </div>
                <section>
                  {files.map((item) => (
                    <button
                      type="button"
                      data-testid="pr-file-entry"
                      key={item.filename}
                      aria-current={file?.filename === item.filename ? "true" : undefined}
                      title={item.filename}
                      onClick={() => selectFile(item.filename)}
                    >
                      <span className="git-change-name">{item.filename.split("/").pop()}</span>
                      <span className="git-change-parent">
                        {item.filename.includes("/")
                          ? item.filename.slice(0, item.filename.lastIndexOf("/"))
                          : ""}
                      </span>
                      <span className="text-on-surface-variant">
                        {item.status.slice(0, 1).toUpperCase()}
                      </span>
                    </button>
                  ))}
                </section>
              </aside>
              <div
                className="git-diff-scroll"
                ref={scroll}
                data-testid="pr-diff-scroll"
                onScroll={() => {
                  const top = scroll.current?.getBoundingClientRect().top ?? 0;
                  const current = files.find((item) => {
                    const rect = fileRefs.current.get(item.filename)?.getBoundingClientRect();
                    return rect && rect.bottom > top + 40;
                  });
                  if (current) setSelected(current.filename);
                }}
              >
                {files.length === 0 && (
                  <p className="git-review-empty">No PR files match this filter.</p>
                )}
                {files.map((file) => {
                  const comments = data.comments.filter(
                    (comment) => comment.path === file.filename,
                  );
                  const inlineEditor =
                    target?.path === file.filename && data.state === "open" ? (
                      <div
                        data-testid="pr-inline-composer"
                        className="pr-inline-compose"
                        style={{ display: target.path === file.filename ? undefined : "none" }}
                      >
                        <MessageSquarePlus size={14} />
                        <CommentComposer
                          drafts={drafts.current}
                          key={`inline:${target.path}:${target.side}:${target.line}`}
                          disabled={target.head !== data.head}
                          terminalId={terminalId}
                          number={number}
                          input={{ kind: "inline", ...target, body: "" }}
                          label={`Comment on ${target.path}, ${target.side === "LEFT" ? "old" : "new"} line ${target.line}`}
                          onClose={() => {
                            setTarget(null);
                            const trigger = inlineTrigger.current?.isConnected
                              ? inlineTrigger.current
                              : fileRefs.current
                                  .get(target.path)
                                  ?.querySelector<HTMLButtonElement>(
                                    '[data-testid="pr-comment-line"][data-side="' +
                                      target.side +
                                      '"][data-line="' +
                                      target.line +
                                      '"]',
                                  );
                            trigger?.focus();
                          }}
                          onSent={() => {
                            onSent();
                            setTarget((current) =>
                              current?.path === target.path &&
                              current.side === target.side &&
                              current.line === target.line
                                ? null
                                : current,
                            );
                          }}
                        />
                        {target.head !== data.head && (
                          <p role="alert">
                            The PR has new commits. Select a line in the latest diff before sending
                            this draft.
                          </p>
                        )}
                      </div>
                    ) : null;
                  return (
                    <section
                      key={file.filename}
                      data-testid="pr-file-diff"
                      data-path={file.filename}
                      ref={(element) => {
                        if (element) fileRefs.current.set(file.filename, element);
                        else fileRefs.current.delete(file.filename);
                      }}
                    >
                      <div className="pr-file-heading">
                        <span>
                          {file.previous_filename ? `${file.previous_filename} → ` : ""}
                          {file.filename}
                        </span>
                        <span>
                          <span className="text-secondary">+{file.additions}</span>{" "}
                          <span className="text-error">−{file.deletions}</span>
                        </span>
                      </div>
                      {file.patch ? (
                        <ReviewDiff
                          inline={
                            target && inlineEditor
                              ? { line: target.line, side: target.side, content: inlineEditor }
                              : undefined
                          }
                          patch={file.patch}
                          split={split}
                          commentable={data.state === "open" && !commentPending}
                          onComment={(line, side, trigger) => {
                            inlineTrigger.current = trigger;
                            if (target?.path === file.filename && target.head !== data.head) {
                              const oldKey = `inline:${target.path}:${target.side}:${target.line}`;
                              const nextKey = `inline:${file.filename}:${side}:${line}`;
                              const draft = drafts.current.get(oldKey);
                              if (draft && !drafts.current.get(nextKey))
                                drafts.current.set(nextKey, draft);
                            }
                            setTarget({ path: file.filename, head: data.head, line, side });
                            setSent(false);
                          }}
                        />
                      ) : (
                        <p className="pr-review-notice">
                          No text patch available for this file. Open the PR in GitHub to inspect
                          binary or unavailable changes.
                        </p>
                      )}
                      {file.patch_truncated && (
                        <p className="pr-review-notice">
                          Patch truncated. Open GitHub for the complete diff.
                        </p>
                      )}
                      {comments
                        .filter((comment) => !comment.in_reply_to_id)
                        .map((root) => (
                          <section
                            key={root.id}
                            className="pr-thread"
                            data-testid="pr-review-thread"
                          >
                            <Comment comment={root} />
                            {comments
                              .filter((comment) => comment.in_reply_to_id === root.id)
                              .map((comment) => (
                                <Comment key={comment.id} comment={comment} />
                              ))}
                            {data.state === "open" && (
                              <button
                                type="button"
                                data-testid="pr-reply"
                                disabled={commentPending}
                                onClick={(event) => {
                                  replyTrigger.current = event.currentTarget;
                                  setReply(reply === root.id ? null : root.id);
                                }}
                              >
                                Reply
                              </button>
                            )}
                            {reply === root.id && data.state === "open" && (
                              <CommentComposer
                                drafts={drafts.current}
                                terminalId={terminalId}
                                number={number}
                                input={{
                                  kind: "reply",
                                  head: data.head,
                                  comment_id: root.id,
                                  body: "",
                                }}
                                label={`Reply to ${root.user?.login ?? "reviewer"}`}
                                onClose={() => {
                                  setReply(null);
                                  replyTrigger.current?.focus();
                                }}
                                onSent={() => {
                                  onSent();
                                  setReply((current) => (current === root.id ? null : current));
                                }}
                              />
                            )}
                          </section>
                        ))}
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
          <div
            data-testid="pr-discussion-panel"
            className="pr-discussion"
            style={{ display: tab === "discussion" ? undefined : "none" }}
          >
            <article className="pr-description">
              <h3>Description</h3>
              <p>{data.body || "No description provided."}</p>
            </article>
            {[...data.discussion, ...data.reviews]
              .sort((left, right) => left.created_at.localeCompare(right.created_at))
              .map((comment) => (
                <Comment key={`${comment.state ?? "comment"}:${comment.id}`} comment={comment} />
              ))}
            {data.comments
              .filter((comment) => !comment.in_reply_to_id)
              .map((root) => (
                <section key={`thread:${root.id}`} className="pr-thread">
                  <Comment comment={root} />
                  {data.comments
                    .filter((comment) => comment.in_reply_to_id === root.id)
                    .map((comment) => (
                      <Comment key={comment.id} comment={comment} />
                    ))}
                  {data.files.some((file) => file.filename === root.path) && (
                    <button
                      type="button"
                      data-testid="pr-open-thread"
                      onClick={() => {
                        setFilter("");
                        setTab("files");
                        if (root.path) selectFile(root.path);
                      }}
                    >
                      Open thread in Files
                    </button>
                  )}
                </section>
              ))}
            {data.state === "open" && !discussionOpen && (
              <button
                type="button"
                className="pr-add-comment"
                data-testid="pr-add-comment"
                disabled={commentPending}
                ref={discussionTrigger}
                onClick={() => setDiscussionOpen(true)}
              >
                <MessageSquarePlus size={14} /> Add comment
              </button>
            )}
            {data.state === "open" && discussionOpen && (
              <CommentComposer
                drafts={drafts.current}
                terminalId={terminalId}
                number={number}
                input={{ kind: "discussion", head: data.head, body: "" }}
                label="Comment on this PR"
                onClose={() => {
                  setDiscussionOpen(false);
                  requestAnimationFrame(() => discussionTrigger.current?.focus());
                }}
                onSent={() => {
                  onSent();
                  setDiscussionOpen(false);
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
