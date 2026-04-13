import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { SessionEvent } from "@/api/client";
import { DetailField } from "@/components/DetailField";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/hooks/useSessions";

const EVENT_TYPE_COLORS: Record<string, string> = {
  file: "bg-primary/15 text-primary border-primary/30",
  task: "bg-secondary/15 text-secondary border-secondary/30",
  decision: "bg-tertiary/15 text-tertiary border-tertiary/30",
  error: "bg-error/15 text-error border-error/30",
  git: "bg-primary/15 text-primary border-primary/30",
  rule: "bg-secondary/15 text-secondary border-secondary/30",
  plan: "bg-tertiary/15 text-tertiary border-tertiary/30",
};

const DEFAULT_EVENT_COLOR = "bg-surface-highest text-outline border-outline-variant";

function getEventColor(type: string): string {
  return EVENT_TYPE_COLORS[type] ?? DEFAULT_EVENT_COLOR;
}

interface SessionDetailSheetProps {
  sessionId: string | null;
  open: boolean;
  onClose: () => void;
}

export function SessionDetailSheet({ sessionId, open, onClose }: SessionDetailSheetProps) {
  const { data: detail, isLoading } = useSession(sessionId ?? "");

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[540px] max-w-[90vw]">
        <SheetHeader>
          <SheetTitle>
            {isLoading
              ? "Loading..."
              : detail
                ? `${detail.agent ?? "Session"} ${detail.agent_version ? `v${detail.agent_version}` : ""}`
                : "Session Detail"}
          </SheetTitle>
        </SheetHeader>
        <SheetBody>
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(4)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
              ))}
            </div>
          ) : !detail ? (
            <div className="font-body text-xs text-outline py-8 text-center">Session not found</div>
          ) : (
            <div className="space-y-6">
              {detail.summary && (
                <div className="font-body text-xs text-on-surface leading-relaxed">
                  {detail.summary}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <DetailField label="ID">
                  <span className="font-mono text-[10px]">{detail.id}</span>
                </DetailField>
                <DetailField label="Project ID">{detail.project_id ?? "\u2014"}</DetailField>
                <DetailField label="Job Run ID">{detail.job_run_id ?? "\u2014"}</DetailField>
                <DetailField label="Tokens Used">
                  {detail.tokens_used != null ? detail.tokens_used.toLocaleString() : "\u2014"}
                </DetailField>
                <DetailField label="Created">
                  {new Date(detail.created_at).toLocaleString()}
                </DetailField>
                <DetailField label="Updated">
                  {new Date(detail.updated_at).toLocaleString()}
                </DetailField>
              </div>

              {detail.events.length > 0 && (
                <div>
                  <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-3">
                    Events ({detail.events.length})
                  </div>
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-1">
                      {[...detail.events]
                        .sort(
                          (a, b) =>
                            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                        )
                        .map((event) => (
                          <EventRow key={event.id} event={event} />
                        ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {detail.snapshot && (
                <div>
                  <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-3">
                    Snapshot
                  </div>
                  <ScrollArea className="h-[200px]">
                    <pre className="font-mono text-[10px] text-on-surface-variant whitespace-pre-wrap bg-surface-highest/50 border border-surface-highest rounded-sm p-3">
                      {detail.snapshot}
                    </pre>
                  </ScrollArea>
                </div>
              )}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function EventRow({ event }: { event: SessionEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = event.data != null;

  return (
    <div className="border border-surface-highest/50 rounded-sm">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-low transition-colors"
        onClick={() => hasData && setExpanded(!expanded)}
      >
        {hasData ? (
          expanded ? (
            <ChevronDown size={10} className="text-outline flex-shrink-0" />
          ) : (
            <ChevronRight size={10} className="text-outline flex-shrink-0" />
          )
        ) : (
          <span className="w-[10px] flex-shrink-0" />
        )}
        <span
          className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-label font-semibold uppercase tracking-wider border rounded-sm ${getEventColor(event.type)}`}
        >
          {event.type}
        </span>
        <span className="flex-1 font-body text-[10px] text-outline truncate">
          {summarizeEventData(event.data)}
        </span>
        <span className="font-label text-[9px] text-outline flex-shrink-0">
          {new Date(event.created_at).toLocaleTimeString()}
        </span>
      </button>
      {expanded && hasData && (
        <div className="px-3 pb-2">
          <pre className="font-mono text-[10px] text-on-surface-variant whitespace-pre-wrap bg-surface-highest/30 border border-surface-highest/50 rounded-sm p-2 max-h-48 overflow-auto">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function summarizeEventData(data: unknown): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.path === "string") return obj.path;
    if (typeof obj.content === "string")
      return obj.content.length > 80 ? `${obj.content.slice(0, 80)}...` : obj.content;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.summary === "string") return obj.summary;
    const keys = Object.keys(obj);
    if (keys.length <= 3) return keys.join(", ");
    return `${keys.length} fields`;
  }
  return String(data);
}
