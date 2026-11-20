import type { ChatActivity } from "@orc/core/chat";
import { ChevronRight, CircleDashed, type LucideIcon, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { activityIcon } from "@/components/chat-ui/tool-renderers";
import { HelpPopover } from "@/components/HelpPopover";
import { useNow } from "@/hooks/useNow";
import { AGENT_STATES } from "@/lib/agent-state";
import { formatClock } from "@/lib/chat-activity";
import { backgroundSummary, type ChatBackgroundItem } from "@/lib/chat-background";
import { toolKey } from "@/lib/chat-tools";
import { cn } from "@/lib/utils";

const TRAIL_LIMIT = 4;
const ROW_LIMIT = 6;
const summaryText = "min-w-0 flex-1 truncate";

type TrailEntry = { id: string; label: string; Icon: LucideIcon; startedAt?: number };

/** A tool name reads better as a short label than as its provider's key. */
function toolLabel(name: string): string {
  const key = toolKey(name) || name.trim();
  if (!key) return "Tool";
  const words = key.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function activityTrail(activity: ChatActivity[]): TrailEntry[] {
  return activity
    .flatMap((item) => {
      if (item.type === "status") return [];
      return [
        {
          id: item.id,
          label:
            item.type === "thinking"
              ? "Thinking"
              : item.type === "plan"
                ? (item.title ?? "Plan")
                : item.type === "subagent"
                  ? (item.title ?? "Subagent")
                  : toolLabel(item.name),
          Icon: activityIcon(item),
          ...(item.type === "tool" && item.startedAt !== undefined
            ? { startedAt: item.startedAt }
            : {}),
        },
      ];
    })
    .slice(-TRAIL_LIMIT);
}

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
  item,
  onOpen,
  onStop,
}: {
  item: ChatBackgroundItem;
  onOpen: (sessionId: string, native?: boolean) => void;
  onStop: (sessionId: string) => void;
}) {
  const button =
    "min-h-7 shrink-0 rounded-md px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11";
  return (
    <>
      <button
        type="button"
        data-testid="chat-background-open"
        onClick={() => item.sessionId && onOpen(item.sessionId, item.native)}
        className={cn(button, "text-primary hover:bg-surface")}
      >
        Open
      </button>
      <button
        type="button"
        data-testid="chat-background-stop"
        onClick={() => item.sessionId && onStop(item.sessionId)}
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
  onOpen: (sessionId: string, native?: boolean) => void;
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
      {item.sessionId && <ItemActions item={item} onOpen={onOpen} onStop={onStop} />}
    </li>
  );
}

/**
 * The header names the parent's state: a running turn, or — once the turn ends — the
 * children still holding work, so a quiet transcript never reads as a stuck one.
 */
function waitingLabel(items: ChatBackgroundItem[]): string {
  const commands = items.filter((item) => item.kind === "command").length;
  const subagents = items.length - commands;
  const part = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (!subagents) return `Running ${part(commands, "command")}`;
  const waiting = `Waiting on ${part(subagents, "subagent")}`;
  return commands ? `${waiting} · ${part(commands, "command")}` : waiting;
}

/**
 * One persistent status strip above the composer. While the parent streams it shows the
 * turn clock and activity trail; when the turn ends but subagents or detached commands
 * still run, it stays up naming that work, with a row per child that opens or stops it.
 */
export function ChatWorkStatus({
  agent,
  streaming,
  startedAt,
  activity,
  items,
  error,
  onOpen,
  onStop,
}: {
  agent: string;
  streaming: boolean;
  startedAt: number | undefined;
  activity: ChatActivity[];
  items: ChatBackgroundItem[];
  error?: string | null;
  onOpen: (sessionId: string, native?: boolean) => void;
  onStop: (sessionId: string) => void;
}) {
  const [mountedAt] = useState(Date.now);
  const now = useNow();
  const { Icon, tone } = AGENT_STATES.working;
  const trail = streaming ? activityTrail(activity) : [];
  const mark = (
    <Icon
      aria-hidden="true"
      data-testid="chat-working-spinner"
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
  const oldest = items.reduce<number | null>(
    (earliest, item) =>
      item.startedAt !== null && (earliest === null || item.startedAt < earliest)
        ? item.startedAt
        : earliest,
    null,
  );
  return (
    <div className="chat-activity-status shrink-0 px-4 pt-1 pb-1.5 sm:px-6">
      <div
        data-testid="chat-activity-status"
        className="mx-auto w-full max-w-(--chat-width) min-w-0 rounded-xl border border-outline-variant bg-surface/60 px-3 py-1.5 text-xs text-on-surface-variant"
      >
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {mark}
          <AgentIcon agent={agent} size={14} className="shrink-0 text-on-surface-variant" />
          <span className="shrink-0 font-medium text-on-surface">{agentDisplayName(agent)}</span>
          {streaming ? (
            <span className="shrink-0">
              Working for{" "}
              <span role="timer" data-testid="chat-working-timer" className="tabular-nums">
                {formatClock(now - (startedAt ?? mountedAt))}
              </span>
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-2">
              <span data-testid="chat-waiting-label">{waitingLabel(items)}</span>
              {oldest !== null && now - oldest >= 1000 && (
                <span
                  role="timer"
                  data-testid="chat-waiting-timer"
                  className="tabular-nums text-on-surface-variant"
                >
                  {formatClock(now - oldest)}
                </span>
              )}
            </span>
          )}
          {trail.length > 0 && (
            <span
              data-testid="chat-activity-trail"
              className="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden"
            >
              {trail.map((entry, index) => {
                const current = index === trail.length - 1;
                const EntryIcon = entry.Icon;
                const elapsed =
                  current && entry.startedAt !== undefined ? now - entry.startedAt : 0;
                return (
                  <span
                    key={entry.id}
                    data-testid={current ? "chat-current-tool" : "chat-activity-trail-item"}
                    className={cn(
                      "flex min-w-0 items-center gap-1",
                      current ? "text-on-surface" : "text-on-surface-variant/60 max-sm:hidden",
                    )}
                  >
                    <EntryIcon aria-hidden="true" size={12} className="shrink-0" />
                    <span className="truncate">{entry.label}</span>
                    {elapsed >= 1000 && (
                      <span
                        data-testid="chat-current-tool-elapsed"
                        className="shrink-0 tabular-nums text-on-surface-variant"
                      >
                        {formatClock(elapsed)}
                      </span>
                    )}
                    {!current && (
                      <span aria-hidden="true" className="shrink-0 text-outline">
                        ·
                      </span>
                    )}
                  </span>
                );
              })}
            </span>
          )}
        </div>
        {items.length > 0 && (
          <section
            data-testid="chat-background-work"
            aria-label="Background work"
            className="mt-1 min-w-0 border-t border-outline-variant/60 pt-1"
          >
            {only ? (
              <div className="flex min-w-0 items-center gap-2">
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
                {only.sessionId && <ItemActions item={only} onOpen={onOpen} onStop={onStop} />}
                {help}
              </div>
            ) : (
              <details className="group/background">
                <summary
                  data-testid="chat-background-summary"
                  className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-md hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11 [&::-webkit-details-marker]:hidden"
                >
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
          </section>
        )}
        {error && (
          <p role="alert" data-testid="chat-background-error" className="mt-0.5 text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
