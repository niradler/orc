import type { ChatActivity, ChatMessage } from "@orc/core/chat";
import { useEffect, useRef, useState } from "react";
import { AGENT_STATES } from "@/lib/agent-state";
import { foldLabel, foldTurn, formatClock } from "@/lib/chat-activity";
import { type ChatTool, toolDetail, toolView } from "@/lib/chat-tools";

const ANNOUNCE_EVERY_MS = 2000;

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
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
  const current = foldTurn(activity).current;
  const detail = current ? toolDetail(toolView(current)) : "";
  return (
    <div
      data-testid="chat-activity-status"
      className="chat-activity-status flex min-w-0 shrink-0 items-center gap-2 px-4 py-2 text-xs text-on-surface-variant sm:px-6"
    >
      <Icon aria-hidden="true" size={14} strokeWidth={2.25} className={`shrink-0 ${tone}`} />
      <span className="shrink-0 text-on-surface">{agent}</span>
      <span className="shrink-0">
        Working for{" "}
        <span role="timer" data-testid="chat-working-timer" className="tabular-nums">
          {formatClock(now - (startedAt ?? mountedAt))}
        </span>
      </span>
      {current && <CurrentTool tool={current} detail={detail} />}
    </div>
  );
}

function CurrentTool({ tool, detail }: { tool: ChatTool; detail: string }) {
  return (
    <span data-testid="chat-current-tool" className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true">·</span>
      <span className="shrink-0 text-on-surface">{tool.name}</span>
      {detail && (
        <span className="min-w-0 truncate font-mono" title={detail}>
          {detail}
        </span>
      )}
    </span>
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
