import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useAttentionChatWaits } from "@/hooks/useAttentionChatWaits";
import { useHumanRequests } from "@/hooks/useHumanRequests";

export function useAttentionSessions() {
  const requests = useHumanRequests();
  const chatWaits = useAttentionChatWaits();
  const sessions = useQuery({
    queryKey: ["sessions", "live", true],
    queryFn: () => api.sessions.live({ active: true, limit: 5000 }),
    refetchInterval: 15000,
    select: (data) => data.sessions,
  });
  const represented = new Set(
    (requests.data ?? [])
      .filter((request) => request.status === "pending" || request.status === "answered")
      .flatMap((request) => [
        request.input.origin.native_session_id,
        request.input.origin.session_id,
      ])
      .filter((id): id is string => !!id),
  );
  for (const wait of chatWaits.all)
    if (wait.native_session_id) represented.add(wait.native_session_id);
  return {
    ...sessions,
    data: (sessions.data ?? []).filter(
      (session) =>
        session.waiting_for_human && (!session.session_id || !represented.has(session.session_id)),
    ),
  };
}
