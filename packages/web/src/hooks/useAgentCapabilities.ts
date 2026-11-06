import type { ChatThread } from "@orc/core/chat";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useAgentCapabilities(agent: string, thread?: ChatThread | null) {
  const query = useQuery({
    queryKey: ["agent-capabilities", agent, thread?.id],
    queryFn: () => api.chat.capabilities(agent, thread?.id),
    staleTime: 30000,
  });
  return thread?.capabilities ?? query.data?.capabilities;
}
