import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useHumanRequests } from "@/hooks/useHumanRequests";

export function useAttentionChatWaits() {
  const requests = useHumanRequests();
  const waits = useQuery({
    queryKey: ["chat-waiting"],
    queryFn: api.chat.waiting,
    refetchInterval: 15000,
  });
  const represented = new Set(
    (requests.data ?? [])
      .filter((request) => request.status === "pending" || request.status === "answered")
      .map(
        (request) =>
          `${request.input.origin.chat_thread_id}:${request.input.origin.native_request_key}`,
      ),
  );
  return {
    ...waits,
    all: waits.data?.waiting ?? [],
    data: (waits.data?.waiting ?? []).filter(
      (wait) => !represented.has(`${wait.thread_id}:${wait.request_key}`),
    ),
  };
}
