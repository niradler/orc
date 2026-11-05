import { enabledAgents } from "@orc/core/coding-agents";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export const WORKSPACE_PREFERENCES_KEY = ["workspace-preferences"] as const;

export function useEnabledAgents(): string[] {
  const { data } = useQuery({ queryKey: WORKSPACE_PREFERENCES_KEY, queryFn: api.settings.get });
  return enabledAgents(data?.agents);
}
