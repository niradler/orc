import { enabledAgents } from "@orc/core/coding-agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { WorkspacePreferences } from "@/lib/api-credentials";

export const WORKSPACE_PREFERENCES_KEY = ["workspace-preferences"] as const;
export const PROVIDER_SETTINGS_KEY = ["provider-settings"] as const;
export function useProviders() {
  return useQuery({ queryKey: PROVIDER_SETTINGS_KEY, queryFn: api.settings.providers.get });
}

export function useEnabledAgents(): string[] {
  const { data } = useQuery({ queryKey: WORKSPACE_PREFERENCES_KEY, queryFn: api.settings.get });
  return enabledAgents(data?.agents);
}

export function useComposerPreferences() {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: WORKSPACE_PREFERENCES_KEY, queryFn: api.settings.get });
  const save = useMutation({
    mutationKey: WORKSPACE_PREFERENCES_KEY,
    mutationFn: (patch: Pick<WorkspacePreferences, "favorite_models" | "composer_profiles">) =>
      api.settings.save(patch),
    onMutate: (patch) =>
      client.setQueryData<WorkspacePreferences>(WORKSPACE_PREFERENCES_KEY, (current) => ({
        ...current,
        ...patch,
      })),
    onSuccess: (saved) => {
      if (client.isMutating({ mutationKey: WORKSPACE_PREFERENCES_KEY }) <= 1)
        client.setQueryData(WORKSPACE_PREFERENCES_KEY, saved);
    },
    onError: () => client.invalidateQueries({ queryKey: WORKSPACE_PREFERENCES_KEY }),
  });
  return {
    favorites: data?.favorite_models ?? [],
    profiles: data?.composer_profiles ?? [],
    save: save.mutate,
    error: save.error,
  };
}
