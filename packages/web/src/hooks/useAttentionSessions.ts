import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useAttentionChatWaits } from "@/hooks/useAttentionChatWaits";
import { useHumanRequests } from "@/hooks/useHumanRequests";

const identity = (backend: string, host: string | null, id: string) =>
  JSON.stringify([backend.replace(/-cli$/, ""), host, id]);

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
      .filter(
        (request) =>
          (request.status === "pending" || request.status === "answered") &&
          request.input.origin.execution_host !== undefined,
      )
      .map((request) =>
        identity(
          request.input.origin.backend,
          request.input.origin.execution_host ?? null,
          request.input.origin.native_session_id ?? request.input.origin.session_id,
        ),
      ),
  );
  for (const wait of chatWaits.all)
    if (wait.native_session_id)
      represented.add(identity(wait.agent, wait.host, wait.native_session_id));
  return {
    ...sessions,
    data: (sessions.data ?? []).filter(
      (session) =>
        session.waiting_for_human &&
        (!session.session_id ||
          !represented.has(identity(session.agent, session.host, session.session_id))),
    ),
  };
}
