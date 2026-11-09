import { enabledAgents } from "@orc/core/coding-agents";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export const WORKSPACE_PREFERENCES_KEY = ["workspace-preferences"] as const;
export const PROVIDER_SETTINGS_KEY = ["provider-settings"] as const;
export function useProviders() {
  return useQuery({ queryKey: PROVIDER_SETTINGS_KEY, queryFn: api.settings.providers.get });
}

export function useEnabledAgents(): string[] {
  const { data } = useQuery({ queryKey: WORKSPACE_PREFERENCES_KEY, queryFn: api.settings.get });
  return enabledAgents(data?.agents);
}
