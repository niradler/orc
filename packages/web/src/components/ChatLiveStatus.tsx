import { buildChatItems, type ChatMessage } from "@orc/core/chat";
import { useEffect, useRef, useState } from "react";
import { foldLabel, foldTurn } from "@/lib/chat-activity";

const ANNOUNCE_EVERY_MS = 2000;

/** Announces streamed prose by paragraph and the finished turn, never every token. */
export function ChatLiveAnnouncer({
  streaming,
  refreshing,
  agent,
  text,
  last,
}: {
  streaming: boolean;
  refreshing: boolean;
  agent: string;
  text: string;
  last: ChatMessage | undefined;
}) {
  const [message, setMessage] = useState("");
  const spoken = useRef(0);
  const textRef = useRef(text);
  textRef.current = text;
  const busy = streaming || refreshing;
  const wasBusy = useRef(busy);
  const lastBefore = useRef(last?.id);
  const streamed = useRef(false);

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
    if (busy || !wasBusy.current) {
      if (!wasBusy.current) {
        lastBefore.current = last?.id;
        streamed.current = false;
      }
      if (streaming) streamed.current = true;
      wasBusy.current = busy;
      return;
    }
    wasBusy.current = false;
    if (last?.role !== "assistant" || (!streamed.current && last.id === lastBefore.current)) return;
    const rest = last.content.slice(spoken.current).trim();
    const summary =
      last.activity?.length || last.providerActivity?.length || last.turn?.outcome
        ? foldLabel(
            foldTurn(
              buildChatItems({
                activity: last.activity,
                providerActivity: last.providerActivity,
              }),
              last.turn,
            ),
            false,
            last.turn?.outcome,
          )
        : "";
    setMessage([rest, summary].filter(Boolean).join(". "));
  }, [busy, streaming, last]);

  return (
    <div role="status" aria-live="polite" data-testid="chat-live-announcer" className="sr-only">
      {message}
    </div>
  );
}
