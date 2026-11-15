import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { api, type TranscriptPage } from "@/api/client";
import { AgentMessageText } from "@/components/AgentMessageText";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatWhen } from "@/lib/live-sessions";

const PAGE_SIZE = 50;

type Turn = TranscriptPage["turns"][number];

/** The archived conversation stays readable after the source computer is offline. */
export function SessionArchiveView({
  session,
  onClose,
}: {
  session: ArchiveSession | null;
  onClose: () => void;
}) {
  const resetKey = `${session?.id ?? ""}:${session?.revision ?? 0}`;
  const [paging, setPaging] = useState({ key: resetKey, offset: 0 });
  const offset = paging.key === resetKey ? paging.offset : 0;
  const setOffset = (next: number) => setPaging({ key: resetKey, offset: next });
  const query = useQuery({
    queryKey: ["sessions", "archive-transcript", session?.id, session?.revision, offset],
    queryFn: () =>
      api.sessions.archiveTranscript(session?.id as string, {
        revision: session?.revision,
        offset,
        limit: PAGE_SIZE,
      }),
    enabled: !!session,
    retry: false,
  });
  const turns: Turn[] = query.data?.turns ?? [];
  const total = query.data?.total ?? 0;

  return (
    <Sheet open={!!session} onOpenChange={(value) => !value && onClose()}>
      <SheetContent
        side="right"
        defaultWidth={1100}
        resizeKey="archive-session"
        data-testid="session-archive-view"
      >
        <SheetHeader>
          <SheetTitle className="normal-case tracking-normal text-sm pr-8">
            {session?.title ?? "Archived session"}
          </SheetTitle>
          {session && (
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-body text-xs text-on-surface tabular-nums">
              <span className="font-medium text-primary">{session.agent}</span>
              <span className="text-on-surface-variant">
                Archived · revision {session.revision}
              </span>
              <span>
                <span className="text-on-surface-variant">ended </span>
                {formatWhen(session.updated_at)}
              </span>
              {session.metadata.cwd && (
                <span className="max-w-full truncate text-on-surface-variant">
                  {session.metadata.cwd}
                </span>
              )}
            </div>
          )}
          {session?.embedding_error && (
            <p role="alert" className="mt-2 text-xs text-error">
              {session.embedding_error}
            </p>
          )}
        </SheetHeader>
        <SheetBody>
          {query.isLoading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={index} className="h-16 w-full bg-surface-highest" />
              ))}
            </div>
          ) : query.error ? (
            <div
              data-testid="archive-transcript-unavailable"
              className="py-12 text-center text-xs text-outline"
            >
              Could not load the archived conversation: {query.error.message}
            </div>
          ) : !turns.length ? (
            <div className="py-12 text-center text-xs text-outline">
              No turns were recorded for this archived session.
            </div>
          ) : (
            <div className="space-y-3">
              {turns.map((turn) => (
                <div
                  key={turn.index}
                  data-testid="archive-turn"
                  data-role={turn.role}
                  className="space-y-2 border-b border-border/65 px-4 py-3 text-on-surface"
                >
                  <div className="font-label text-xs font-medium text-outline">
                    {turn.role}
                    {turn.time ? ` · ${formatWhen(turn.time)}` : ""}
                  </div>
                  <AgentMessageText plain>
                    {turn.blocks
                      .map((block) =>
                        block.type === "tool_use"
                          ? `${block.name}\n${block.input}\n${block.result ?? ""}`
                          : block.text,
                      )
                      .join("\n")}
                  </AgentMessageText>
                </div>
              ))}
            </div>
          )}
        </SheetBody>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-outline tabular-nums">
          <span>
            {total
              ? `Turns ${offset + 1}–${Math.min(offset + turns.length, total)} of ${total}`
              : ""}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous archived turns"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-primary hover:bg-surface disabled:text-outline"
            >
              <ChevronLeft size={14} /> Previous
            </button>
            <button
              type="button"
              aria-label="Next archived turns"
              disabled={offset + turns.length >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-primary hover:bg-surface disabled:text-outline"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
