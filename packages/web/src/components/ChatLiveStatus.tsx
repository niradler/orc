import type { ChatActivity, ChatMessage } from "@orc/core/chat";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { activityIcon } from "@/components/chat-ui/tool-renderers";
import { useNow } from "@/hooks/useNow";
import { AGENT_STATES } from "@/lib/agent-state";
import { foldLabel, foldTurn, formatClock } from "@/lib/chat-activity";
import { toolKey } from "@/lib/chat-tools";
import { cn } from "@/lib/utils";

const ANNOUNCE_EVERY_MS = 2000;
const TRAIL_LIMIT = 4;

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

export function ChatLiveStatus({
  agent,
  startedAt,
  activity,
}: {
  agent: string;
  startedAt: number | undefined;
  activity: ChatActivity[];
}) {
  const [mountedAt] = useState(Date.now);
  const now = useNow();
  const { Icon, tone } = AGENT_STATES.working;
  const trail = activityTrail(activity);
  return (
    <div className="chat-activity-status shrink-0 px-4 pt-1 pb-1.5 sm:px-6">
      <div
        data-testid="chat-activity-status"
        className="mx-auto flex w-full max-w-3xl min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-outline-variant bg-surface/60 px-3 py-1.5 text-xs text-on-surface-variant"
      >
        <Icon
          aria-hidden="true"
          data-testid="chat-working-spinner"
          size={14}
          strokeWidth={2.25}
          className={cn("shrink-0 motion-safe:animate-spin", tone)}
        />
        <AgentIcon agent={agent} size={14} className="shrink-0 text-on-surface-variant" />
        <span className="shrink-0 font-medium text-on-surface">{agentDisplayName(agent)}</span>
        <span className="shrink-0">
          Working for{" "}
          <span role="timer" data-testid="chat-working-timer" className="tabular-nums">
            {formatClock(now - (startedAt ?? mountedAt))}
          </span>
        </span>
        {trail.length > 0 && (
          <span
            data-testid="chat-activity-trail"
            className="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden"
          >
            {trail.map((entry, index) => {
              const current = index === trail.length - 1;
              const EntryIcon = entry.Icon;
              const elapsed = current && entry.startedAt !== undefined ? now - entry.startedAt : 0;
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
    </div>
  );
}

/** Announces streamed prose by paragraph and the finished turn, never every token. */
export function ChatLiveAnnouncer({
  streaming,
  agent,
  text,
  last,
}: {
  streaming: boolean;
  agent: string;
  text: string;
  last: ChatMessage | undefined;
}) {
  const [message, setMessage] = useState("");
  const spoken = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (text.length < spoken.current) spoken.current = 0;
  }, [text]);

  useEffect(() => {
    if (!streaming) return;
    spoken.current = 0;
    setMessage(`${agent} is working`);
    const timer = window.setInterval(() => {
      const current = textRef.current;
      const end = current.lastIndexOf("\n\n");
      if (end <= spoken.current) return;
      const chunk = current.slice(spoken.current, end).trim();
      spoken.current = end;
      if (chunk) setMessage(chunk);
    }, ANNOUNCE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [streaming, agent]);

  useEffect(() => {
    if (streaming || !wasStreaming.current) {
      wasStreaming.current = streaming;
      return;
    }
    wasStreaming.current = false;
    if (last?.role !== "assistant") return;
    const rest = last.content.slice(spoken.current).trim();
    const summary =
      last.activity?.length || last.turn?.outcome
        ? foldLabel(foldTurn(last.activity ?? [], last.turn), false, last.turn?.outcome)
        : "";
    setMessage([rest, summary].filter(Boolean).join(". "));
  }, [streaming, last]);

  return (
    <div role="status" aria-live="polite" data-testid="chat-live-announcer" className="sr-only">
      {message}
    </div>
  );
}
