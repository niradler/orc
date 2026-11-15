import { nativeChatAgent, nativeChatResumeUnavailableReason } from "@orc/core/chat";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Pencil,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type LiveSession, type TranscriptPage } from "@/api/client";
import { AgentMessageText } from "@/components/AgentMessageText";
import { ChatSessionAnalytics } from "@/components/ChatSessionAnalytics";
import { Markdown } from "@/components/Markdown";
import { RenameSession } from "@/components/RenameSession";
import { SessionCacheUsage } from "@/components/SessionCacheUsage";
import { SessionLineage } from "@/components/SessionLineage";
import { SessionMessageInbox } from "@/components/SessionMessageInbox";
import { SessionTaskLink } from "@/components/SessionTaskLink";
import { StateBadge } from "@/components/StateBadge";
import { SessionScratchpads } from "@/components/scratchpad/SessionScratchpads";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useChat } from "@/hooks/useChat";
import { useTranscript, useUpdateLiveSession } from "@/hooks/useSessions";
import { liveSessionState } from "@/lib/agent-state";
import { formatTokens, formatWhen, resumeCommand } from "@/lib/live-sessions";

type Turn = TranscriptPage["turns"][number];
type TurnBlock = Turn["blocks"][number];

const HIGHLIGHT = "session-search";

const ROLE_STYLE: Record<Turn["role"], string> = {
  user: "border-border/65",
  assistant: "border-border/65",
  tool: "border-border/65 bg-transparent",
  system: "border-border/65 bg-transparent",
};

const PREVIEW_KEYS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
];

const ACTION =
  "inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-surface-highest disabled:opacity-50";

function inputPreview(input: string): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      if (typeof parsed[key] === "string") return parsed[key] as string;
    }
  } catch {}
  return input;
}

function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

function useSearchHighlight(
  root: React.RefObject<HTMLElement | null>,
  query: string,
  dependency: unknown,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency re-runs highlighting when turns change
  useEffect(() => {
    const el = root.current;
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown })
      .Highlight;
    if (!el || !registry || !HighlightCtor) return;
    const needle = query.trim().toLowerCase();
    const paint = () => {
      registry.delete(HIGHLIGHT);
      if (needle.length < 2) return;
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.toLowerCase() ?? "";
        for (
          let at = text.indexOf(needle);
          at >= 0;
          at = text.indexOf(needle, at + needle.length)
        ) {
          const range = new Range();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          ranges.push(range);
        }
      }
      if (ranges.length > 0) registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
    };
    paint();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(paint, 150);
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      registry.delete(HIGHLIGHT);
    };
  }, [root, query, dependency]);
}

function ToolBox({
  block,
  open,
}: {
  block: Extract<TurnBlock, { type: "tool_use" }>;
  open: boolean;
}) {
  const done = block.result !== undefined;
  return (
    <details
      open={open || undefined}
      data-testid="tool-box"
      className="border-l border-border bg-background"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 font-label text-xs font-medium text-outline hover:text-on-surface">
        <span className="text-secondary shrink-0">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono normal-case tracking-normal text-on-surface-variant">
          {inputPreview(block.input)}
        </span>
        <span className={`shrink-0 ${done ? "text-outline" : "text-tertiary"}`}>
          {done ? "done" : "no result"}
        </span>
      </summary>
      <div className="space-y-2 border-t border-border px-2 py-2">
        <div className="font-label text-[10px] font-medium text-outline">input</div>
        <pre className="max-h-72 overflow-auto rounded-lg bg-background p-2 font-mono text-xs text-on-surface-variant whitespace-pre-wrap wrap-break-word">
          {prettyInput(block.input)}
        </pre>
        {done && (
          <>
            <div className="font-label text-[10px] font-medium text-outline">result</div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-background p-2 font-mono text-xs text-on-surface-variant whitespace-pre-wrap wrap-break-word">
              {block.result}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

function Block({ block, matched }: { block: TurnBlock; matched: boolean }) {
  if (block.type === "text")
    return (
      <div className="chat-message">
        <AgentMessageText revealContext={matched}>{block.text}</AgentMessageText>
      </div>
    );
  if (block.type === "tool_use") return <ToolBox block={block} open={matched} />;
  const label = block.type === "thinking" ? "thinking" : "result";
  return (
    <details open={matched || undefined}>
      <summary className="cursor-pointer font-label text-xs font-medium text-outline hover:text-on-surface">
        {label}
      </summary>
      {block.type === "thinking" ? (
        <div className="mt-1">
          <Markdown>{block.text}</Markdown>
        </div>
      ) : (
        <pre className="mt-1 max-h-96 overflow-auto rounded-lg bg-background p-2 font-mono text-xs text-on-surface-variant whitespace-pre-wrap wrap-break-word">
          {block.text}
        </pre>
      )}
    </details>
  );
}

/**
 * The read-only view of a discovered session: its transcript, cache usage, lineage,
 * scratchpads and message queue. Resumable providers open in chat instead; this stays
 * the reader for providers whose store chat cannot continue and for reading without
 * importing the conversation.
 */
/** Analytics stay collapsed: the transcript is the page, and the charts are
 *  worth loading only when someone asks for them. */
function SessionAnalyticsDetails({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-testid="session-analytics"
      className="mt-2 rounded-md border border-border"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Analytics</summary>
      {open && (
        <div className="max-h-[60vh] overflow-y-auto border-t border-border p-3">
          <ChatSessionAnalytics sessionId={sessionId} streaming={live} hideOnError />
        </div>
      )}
    </details>
  );
}

export function SessionView({
  sessionId,
  initialQuery = "",
  onClose,
  onResumed,
}: {
  sessionId: string | null;
  initialQuery?: string;
  onClose: () => void;
  onResumed?: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const update = useUpdateLiveSession();
  const sessionQuery = useQuery({
    queryKey: ["sessions", "live-one", sessionId],
    queryFn: () => api.sessions.liveOne(sessionId as string),
    enabled: Boolean(sessionId),
    retry: false,
  });
  const session: LiveSession | undefined = sessionQuery.data;
  const live = session !== undefined && session.status !== "stopped";
  const search = query.trim().length >= 2 ? query.trim() : "";
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useTranscript(
    sessionId,
    search,
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const turnsRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seenTotal = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const scrollToEnd = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
  }, []);
  useSearchHighlight(turnsRef, search, data?.turns);

  const matches = data?.matches ?? [];
  const target = matches[cursor];

  useEffect(() => {
    if (!data) return;
    if (target !== undefined) {
      stick.current = false;
      document.getElementById(`turn-${target}`)?.scrollIntoView({ block: "center" });
      return;
    }
    if (stick.current) scrollToEnd();
  }, [target, data, scrollToEnd]);

  useEffect(() => {
    if (data && atBottom) seenTotal.current = data.total;
  }, [data, atBottom]);

  const go = (step: number) => {
    if (matches.length > 0) setCursor((c) => (c + step + matches.length) % matches.length);
  };
  const continueReason = session ? nativeChatResumeUnavailableReason(session.agent) : null;
  const resumable = session ? Boolean(nativeChatAgent(session.agent)) : false;
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [copied, setCopied] = useState(false);
  const command = session ? (resumeCommand(session) ?? "") : "";
  const chat = useChat();
  const copyCommand = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setResumeError("Clipboard access failed. Allow clipboard access and try again.");
    }
  };
  const resume = async () => {
    if (!session || resuming) return;
    setResuming(true);
    setResumeError("");
    try {
      chat.openThread(await api.chat.resume(session.id));
      // A phone list sits over the conversation; resuming must reveal the chat.
      // Replace the transient viewer entry so Back leaves the chat, not a stale sheet.
      if (onResumed) onResumed();
      else onClose();
    } catch (cause) {
      setResumeError(cause instanceof Error ? cause.message : "The session could not be opened.");
    } finally {
      setResuming(false);
    }
  };

  return (
    <Sheet open={Boolean(sessionId)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        defaultWidth={1100}
        resizeKey="live-session"
        data-testid="session-view"
      >
        <SheetHeader>
          <SheetTitle className="normal-case tracking-normal text-sm pr-8">
            {session?.name ?? "Session"}
          </SheetTitle>
          {/* One stable slot for the session header fields: the cache panel below
              renders before this data arrives, and shifting its position would
              remount it. */}
          <div className="contents">
            {session && (
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-body text-xs text-on-surface tabular-nums">
                <span className="font-medium text-primary">{session.agent}</span>
                <StateBadge state={liveSessionState(session)} />
                <span>
                  <span className="text-on-surface-variant">tokens </span>
                  {formatTokens(session)}
                </span>
                <span>
                  <span className="text-on-surface-variant">started </span>
                  {formatWhen(session.created_at)}
                </span>
                <span>
                  <span className="text-on-surface-variant">active </span>
                  {formatWhen(session.last_activity_at)}
                </span>
                <SessionTaskLink session={session} linkTestId="detail-open-task" />
                <button
                  type="button"
                  data-testid="rename-session"
                  disabled={update.isPending}
                  onClick={() => setRenaming(true)}
                  className={ACTION}
                >
                  <Pencil size={13} aria-hidden />
                  Rename
                </button>
                <button
                  type="button"
                  data-testid={session.hidden ? "unhide-session" : "hide-session"}
                  disabled={update.isPending}
                  title={
                    session.hidden
                      ? "Show this session in the list again"
                      : "Keep this session but leave it out of the list"
                  }
                  onClick={() => update.mutate({ id: session.id, hidden: !session.hidden })}
                  className={ACTION}
                >
                  {session.hidden ? (
                    <Eye size={13} aria-hidden />
                  ) : (
                    <EyeOff size={13} aria-hidden />
                  )}
                  {session.hidden ? "Show in list" : "Hide from list"}
                </button>
                {session.hidden && (
                  <span data-testid="detail-session-hidden" className="text-outline">
                    Hidden from list
                  </span>
                )}
                {resumable && (
                  <button
                    type="button"
                    data-testid="open-chat-resume"
                    disabled={resuming}
                    onClick={() => void resume()}
                    className={ACTION}
                  >
                    {resuming ? "Opening…" : "Continue in chat"}
                  </button>
                )}
                {command && (
                  <button
                    type="button"
                    data-testid="copy-resume"
                    title={command}
                    onClick={() => void copyCommand()}
                    className={ACTION}
                  >
                    {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                    Copy resume command
                  </button>
                )}
                {copied && (
                  <span data-testid="resume-feedback" className="text-secondary">
                    Resume command copied
                  </span>
                )}
                <SessionScratchpads session={session} />
                <span className="truncate max-w-full text-on-surface-variant">{session.cwd}</span>
              </div>
            )}
            {session && !resumable && continueReason && (
              <p data-testid="session-view-read-only" className="mt-2 text-xs text-outline">
                {continueReason}
              </p>
            )}
            {resumeError && (
              <p role="alert" className="mt-2 text-xs text-error">
                {resumeError}
              </p>
            )}
          </div>
          {sessionId && <SessionCacheUsage key={sessionId} sessionId={sessionId} live={live} />}
          {sessionId && (
            <SessionAnalyticsDetails
              key={`analytics-${sessionId}`}
              sessionId={sessionId}
              live={live}
            />
          )}
          {session && <SessionLineage sessionId={session.id} />}
          {session && <SessionMessageInbox key={session.id} session={session} live={live} />}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[150px] flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-outline" />
              <input
                data-testid="transcript-search"
                aria-label="Search this session"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                placeholder="Search this session"
                className="w-full bg-background border border-control-border rounded-lg min-h-11 pl-7 pr-2 py-2 font-body text-xs text-on-surface"
              />
            </div>
            {search && (
              <span
                data-testid="transcript-match-count"
                className="font-label text-xs font-medium text-outline"
              >
                {matches.length === 0 ? "no matches" : `${cursor + 1} / ${matches.length}`}
              </span>
            )}
            <button
              type="button"
              aria-label="Previous match"
              onClick={() => go(-1)}
              className="min-h-11 min-w-11 p-2 text-outline hover:text-on-surface"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next match"
              onClick={() => go(1)}
              className="min-h-11 min-w-11 p-2 text-outline hover:text-on-surface"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid="transcript-refresh"
              onClick={() => {
                stick.current = true;
                refetch();
              }}
              className="min-h-11 px-2 inline-flex items-center gap-1 font-label text-xs font-medium text-primary hover:text-on-surface"
            >
              <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
          {data && (
            <div
              data-testid="transcript-status"
              className="mt-2 font-body text-xs text-on-surface-variant tabular-nums"
            >
              {data.total} turns
              {live ? ` · live, updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ""}
            </div>
          )}
        </SheetHeader>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SheetBody
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
              stick.current = near;
              setAtBottom(near);
            }}
          >
            {sessionQuery.error ? (
              <div
                data-testid="session-view-unavailable"
                className="font-body text-xs text-outline py-12 text-center"
              >
                Could not load this session: {sessionQuery.error.message}
              </div>
            ) : isLoading ? (
              <div className="space-y-4">
                {[...Array(5)].map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                  <Skeleton key={i} className="h-16 w-full bg-surface-highest" />
                ))}
              </div>
            ) : error || !data ? (
              <div
                data-testid="transcript-unavailable"
                className="font-body text-xs text-outline py-12 text-center"
              >
                {error
                  ? `Could not load the conversation: ${error.message}`
                  : "No conversation was recorded for this session."}
                <p className="mt-2">
                  {resumable
                    ? "Open it from the session list to continue it in chat."
                    : "This provider keeps its CLI history separate, so it cannot continue in chat."}
                </p>
                <button
                  type="button"
                  className="mt-3 min-h-11 text-primary hover:underline"
                  onClick={() => refetch()}
                >
                  Retry conversation
                </button>
              </div>
            ) : (
              <div ref={turnsRef} className="space-y-3">
                {data.turns.map((turn) => {
                  const matched = matches.includes(turn.index);
                  const blocks = turn.blocks.map((block, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional
                    <Block key={i} block={block} matched={matched} />
                  ));
                  return (
                    <div
                      key={turn.index}
                      id={`turn-${turn.index}`}
                      data-testid="transcript-turn"
                      data-role={turn.role}
                      style={{
                        contentVisibility: "auto",
                        containIntrinsicSize: "auto 120px",
                      }}
                      className={`border-b px-4 py-3 text-on-surface space-y-2 ${ROLE_STYLE[turn.role]} ${turn.index === target ? "ring-1 ring-primary" : ""}`}
                    >
                      <div className="font-label text-xs font-medium text-outline">
                        {turn.role}
                        {turn.time ? ` · ${formatWhen(turn.time)}` : ""}
                      </div>
                      {turn.role === "system" ? (
                        <details open={matched || undefined}>
                          <summary className="cursor-pointer font-label text-xs font-medium text-outline hover:text-on-surface">
                            injected context
                          </summary>
                          <div className="mt-2 space-y-2">{blocks}</div>
                        </details>
                      ) : (
                        blocks
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </SheetBody>
          {data && !atBottom && (
            <button
              type="button"
              data-testid="jump-to-latest"
              onClick={() => {
                stick.current = true;
                scrollToEnd();
              }}
              className="absolute bottom-4 right-6 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 font-body text-xs text-primary shadow-lg hover:bg-surface-bright"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              Jump to latest
              {data.total > seenTotal.current && ` · ${data.total - seenTotal.current} new`}
            </button>
          )}
        </div>
        {session && (
          <RenameSession session={session} open={renaming} onClose={() => setRenaming(false)} />
        )}
      </SheetContent>
    </Sheet>
  );
}
