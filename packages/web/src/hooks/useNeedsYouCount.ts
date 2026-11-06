import { useEffect } from "react";
import { useAttentionChatWaits } from "@/hooks/useAttentionChatWaits";
import { useAttentionSessions } from "@/hooks/useAttentionSessions";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { titleWithNeedsYou } from "@/lib/agent-state";

export function useNeedsYouCount(): number {
  const { data: humanRequests } = useHumanRequests();
  const observedSessions = useAttentionSessions();
  const chatWaits = useAttentionChatWaits();
  const requests =
    humanRequests?.filter(
      (request) => request.status === "pending" || request.status === "unavailable",
    ).length ?? 0;
  return requests + observedSessions.data.length + chatWaits.data.length;
}

const baseTitle = typeof document === "undefined" ? "ORC" : document.title;

export function useNeedsYouTitle(count: number): void {
  useEffect(() => {
    document.title = titleWithNeedsYou(baseTitle, count);
  }, [count]);
}
