import { ChevronRight, CircleDashed, SquareTerminal } from "lucide-react";
import { HelpPopover } from "@/components/HelpPopover";
import { useNow } from "@/hooks/useNow";
import { AGENT_STATES } from "@/lib/agent-state";
import { formatClock } from "@/lib/chat-activity";
import { backgroundSummary, type ChatBackgroundItem } from "@/lib/chat-background";
import { cn } from "@/lib/utils";

const ROW_LIMIT = 6;
const summaryText = "min-w-0 flex-1 truncate";

/** What the row says before the work's name: a child session knows its real state. */
function verb(item: ChatBackgroundItem): string {
  if (item.status === "waiting") return "Needs you";
  if (item.status === "queued") return "Queued";
  return "Running";
}

function labelClass(item: ChatBackgroundItem): string {
  return cn(summaryText, "text-on-surface", item.kind === "command" && "font-mono");
}

function KindIcon({ kind }: { kind: ChatBackgroundItem["kind"] }) {
  return kind === "command" ? (
    <SquareTerminal aria-hidden="true" size={12} className="shrink-0 text-outline" />
  ) : (
    <CircleDashed aria-hidden="true" size={12} className="shrink-0 text-outline" />
  );
}

function Elapsed({ since, now }: { since: number | null; now: number }) {
  if (since === null) return null;
  const elapsed = now - since;
  if (elapsed < 1000) return null;
  return (
    <span role="timer" className="shrink-0 tabular-nums text-on-surface-variant">
      {formatClock(elapsed)}
    </span>
  );
}

function ItemActions({
  sessionId,
  onOpen,
  onStop,
}: {
  sessionId: string;
  onOpen: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const button =
    "min-h-7 shrink-0 rounded-md px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11";
  return (
    <>
      <button
        type="button"
        data-testid="chat-background-open"
        onClick={() => onOpen(sessionId)}
        className={cn(button, "text-primary hover:bg-surface")}
      >
        Open
      </button>
      <button
        type="button"
        data-testid="chat-background-stop"
        onClick={() => onStop(sessionId)}
        className={cn(button, "text-on-surface-variant hover:bg-surface hover:text-error")}
      >
        Stop
      </button>
    </>
  );
}

function ItemRow({
  item,
  now,
  onOpen,
  onStop,
}: {
  item: ChatBackgroundItem;
  now: number;
  onOpen: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  return (
    <li
      data-testid="chat-background-item"
      data-kind={item.kind}
      data-status={item.status}
      className="flex min-w-0 items-center gap-2"
    >
      <KindIcon kind={item.kind} />
      <span className={item.status === "running" ? "shrink-0" : "shrink-0 text-warning"}>
        {verb(item)}
      </span>
      <span aria-hidden="true" className="shrink-0 text-outline">
        ·
      </span>
      <span className={labelClass(item)} title={item.label}>
        {item.label}
      </span>
      <Elapsed since={item.startedAt} now={now} />
      {item.sessionId && <ItemActions sessionId={item.sessionId} onOpen={onOpen} onStop={onStop} />}
    </li>
  );
}

/**
 * Work an agent left running: a detached command, or a session it started. One job reads as
 * a single line beside the composer; several collapse to a quiet summary, so a transcript
 * that has gone quiet never reads as a stuck one.
 */
export function ChatBackgroundWork({
  items,
  error,
  onOpen,
  onStop,
}: {
  items: ChatBackgroundItem[];
  error?: string | null;
  onOpen: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const now = useNow();
  if (!items.length) return null;
  const { Icon, tone } = AGENT_STATES.working;
  const mark = (
    <Icon
      aria-hidden="true"
      size={14}
      strokeWidth={2.25}
      className={cn("shrink-0 motion-safe:animate-spin", tone)}
    />
  );
  const help = (
    <HelpPopover label="Background work" testId="chat-background-help">
      An agent can leave a command or a subagent running after its message ends. These rows keep
      their own clock; open a subagent to watch it, or stop it from here.
    </HelpPopover>
  );
  const only = items.length === 1 ? items[0] : undefined;
  const shown = items.slice(0, ROW_LIMIT);
  const hidden = items.length - shown.length;
  return (
    <div className="chat-activity-status shrink-0 px-4 pt-1 pb-1.5 sm:px-6">
      <section
        data-testid="chat-background-work"
        aria-label="Background work"
        className="mx-auto w-full max-w-3xl min-w-0 rounded-xl border border-outline-variant bg-surface/60 px-3 py-1.5 text-xs text-on-surface-variant"
      >
        {only ? (
          <div className="flex min-w-0 items-center gap-2">
            {mark}
            <span className={cn("shrink-0", only.status !== "running" && "text-warning")}>
              {verb(only)}
            </span>
            <span aria-hidden="true" className="shrink-0 text-outline">
              ·
            </span>
            <span className={labelClass(only)} title={only.label}>
              {only.label}
            </span>
            <Elapsed since={only.startedAt} now={now} />
            {only.sessionId && (
              <ItemActions sessionId={only.sessionId} onOpen={onOpen} onStop={onStop} />
            )}
            {help}
          </div>
        ) : (
          <details className="group/background">
            <summary
              data-testid="chat-background-summary"
              className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11 [&::-webkit-details-marker]:hidden"
            >
              {mark}
              <span data-testid="chat-background-title" className={summaryText}>
                {backgroundSummary(items)}
              </span>
              {help}
              <ChevronRight
                aria-hidden="true"
                size={14}
                className="shrink-0 group-open/background:rotate-90 motion-safe:transition-transform"
              />
            </summary>
            <ul className="mt-1 space-y-0.5 border-l border-outline-variant pl-3">
              {shown.map((item) => (
                <ItemRow key={item.id} item={item} now={now} onOpen={onOpen} onStop={onStop} />
              ))}
            </ul>
            {hidden > 0 && (
              <p data-testid="chat-background-more" className="mt-0.5 pl-3">
                and {hidden} more
              </p>
            )}
          </details>
        )}
        {error && (
          <p role="alert" data-testid="chat-background-error" className="mt-0.5 text-error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
