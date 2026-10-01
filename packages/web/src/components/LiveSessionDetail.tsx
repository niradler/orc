import { ArrowDown, ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LiveSession, TranscriptPage } from "@/api/client";
import { CopyResume } from "@/components/CopyResume";
import { Markdown } from "@/components/Markdown";
import { OpenTerminalResume } from "@/components/OpenTerminalResume";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveSessions, useTranscript } from "@/hooks/useSessions";
import { formatTokens, formatWhen, STATUS } from "@/lib/live-sessions";

type Turn = TranscriptPage["turns"][number];
type TurnBlock = Turn["blocks"][number];

const HIGHLIGHT = "session-search";

const ROLE_STYLE: Record<Turn["role"], string> = {
  user: "border-primary/40 bg-primary/5",
  assistant: "border-surface-highest bg-surface-low",
  tool: "border-surface-highest/60 bg-transparent",
  system: "border-surface-highest/40 bg-transparent opacity-70",
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
    observer.observe(el, { childList: true, subtree: true, characterData: true });
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
      className="rounded-sm border border-surface-highest bg-surface-lowest/60"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 font-label text-[11px] uppercase tracking-widest text-outline hover:text-on-surface">
        <span className="text-secondary shrink-0">{block.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono normal-case tracking-normal text-on-surface-variant">
          {inputPreview(block.input)}
        </span>
        <span className={`shrink-0 ${done ? "text-outline" : "text-tertiary"}`}>
          {done ? "done" : "no result"}
        </span>
      </summary>
      <div className="space-y-2 border-t border-surface-highest px-2 py-2">
        <div className="font-label text-[10px] uppercase tracking-widest text-outline/70">
          input
        </div>
        <pre className="max-h-72 overflow-auto rounded-sm bg-surface-lowest p-2 font-mono text-[11px] text-on-surface-variant whitespace-pre-wrap break-words">
          {prettyInput(block.input)}
        </pre>
        {done && (
          <>
            <div className="font-label text-[10px] uppercase tracking-widest text-outline/70">
              result
            </div>
            <pre className="max-h-96 overflow-auto rounded-sm bg-surface-lowest p-2 font-mono text-[11px] text-on-surface-variant whitespace-pre-wrap break-words">
              {block.result}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

function Block({ block, matched }: { block: TurnBlock; matched: boolean }) {
  if (block.type === "text") return <Markdown>{block.text}</Markdown>;
  if (block.type === "tool_use") return <ToolBox block={block} open={matched} />;
  const label = block.type === "thinking" ? "thinking" : "result";
  return (
    <details open={matched || undefined}>
      <summary className="cursor-pointer font-label text-[11px] uppercase tracking-widest text-outline hover:text-on-surface">
        {label}
      </summary>
      {block.type === "thinking" ? (
        <div className="mt-1 opacity-80">
          <Markdown>{block.text}</Markdown>
        </div>
      ) : (
        <pre className="mt-1 max-h-96 overflow-auto rounded-sm bg-surface-lowest p-2 font-mono text-[11px] text-on-surface-variant whitespace-pre-wrap break-words">
          {block.text}
        </pre>
      )}
    </details>
  );
}

export function LiveSessionDetail({
  sessionId,
  initialQuery,
  onClose,
}: {
  sessionId: string | null;
  initialQuery: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const { data: all } = useLiveSessions(false);
  const session: LiveSession | undefined = all?.find((s) => s.id === sessionId);
  const live = session !== undefined && session.status !== "stopped";
  const search = query.trim().length >= 2 ? query.trim() : "";
  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useTranscript(
    sessionId,
    search,
    live,
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

  return (
    <Sheet open={Boolean(sessionId)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-[1100px] max-w-[95vw]"
        data-testid="live-session-detail"
      >
        <SheetHeader>
          <SheetTitle className="normal-case tracking-normal text-sm pr-8">
            {session?.name ?? "Session"}
          </SheetTitle>
          {session && (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-body text-xs text-on-surface tabular-nums">
              <span className="font-medium text-primary">{session.agent}</span>
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${STATUS[session.status].dot}`} />
                {STATUS[session.status].label}
              </span>
              <span>
                <span className="text-on-surface-variant">tokens </span>
                {formatTokens(session)}
              </span>
              <span>
                <span className="text-on-surface-variant">active </span>
                {formatWhen(session.last_activity_at)}
              </span>
              {session.task && (
                <Link
                  to={`/tasks/${session.task.id}`}
                  data-testid="detail-open-task"
                  className="text-primary hover:text-on-surface"
                >
                  task: {session.task.title}
                </Link>
              )}
              <OpenTerminalResume session={session} />
              <CopyResume session={session} />
              <span className="truncate max-w-full text-on-surface-variant">{session.cwd}</span>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-outline" />
              <input
                data-testid="transcript-search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                placeholder="Search this session"
                className="w-full bg-surface-low border border-surface-highest rounded-sm pl-7 pr-2 py-1 font-body text-xs text-on-surface"
              />
            </div>
            {search && (
              <span
                data-testid="transcript-match-count"
                className="font-label text-[11px] uppercase tracking-widest text-outline"
              >
                {matches.length === 0 ? "no matches" : `${cursor + 1} / ${matches.length}`}
              </span>
            )}
            <button
              type="button"
              aria-label="Previous match"
              onClick={() => go(-1)}
              className="text-outline hover:text-on-surface"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next match"
              onClick={() => go(1)}
              className="text-outline hover:text-on-surface"
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
              className="inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface"
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
            {isLoading ? (
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
                The conversation isn&apos;t available for this session. Cursor IDE chats keep it
                inside Cursor, and some sessions have no transcript file left on disk.
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
                      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}
                      className={`rounded-sm border px-3 py-2 space-y-2 ${ROLE_STYLE[turn.role]} ${turn.index === target ? "ring-1 ring-primary" : ""}`}
                    >
                      <div className="font-label text-[11px] uppercase tracking-widest text-outline">
                        {turn.role}
                        {turn.time ? ` · ${formatWhen(turn.time)}` : ""}
                      </div>
                      {turn.role === "system" ? (
                        <details open={matched || undefined}>
                          <summary className="cursor-pointer font-label text-[11px] uppercase tracking-widest text-outline hover:text-on-surface">
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
              className="absolute bottom-4 right-6 inline-flex items-center gap-1.5 rounded-sm border border-primary/40 bg-surface-high px-3 py-1.5 font-body text-xs text-primary shadow-lg hover:bg-surface-bright"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              Jump to latest
              {data.total > seenTotal.current && ` · ${data.total - seenTotal.current} new`}
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
