import type { ChatThread } from "@orc/core/chat";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

function useCapabilitiesQuery(agent: string, thread?: ChatThread | null) {
  return useQuery({
    queryKey: ["agent-capabilities", agent, thread?.id],
    queryFn: () => api.chat.capabilities(agent, thread?.id),
    staleTime: 30000,
  });
}

export function useAgentCapabilities(agent: string, thread?: ChatThread | null) {
  const query = useCapabilitiesQuery(agent, thread);
  return thread?.capabilities ?? query.data?.capabilities;
}

/** The adapter ORC will actually use, which can differ from the static table
 *  once agent_loop.acp_commands configures a direct ACP command. */
export function useAgentBackend(agent: string, thread?: ChatThread | null) {
  const query = useCapabilitiesQuery(agent, thread);
  return thread?.backend ?? query.data?.backend;
}
