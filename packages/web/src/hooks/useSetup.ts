import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { PROVIDER_SETTINGS_KEY, WORKSPACE_PREFERENCES_KEY } from "@/hooks/useAgents";

export const SETUP_STATUS_KEY = ["setup-status"] as const;

/**
 * First-run detection: which coding agents the ORC host has and which folders
 * their session history suggests as projects. Detection shells out to
 * `--version` at most, so it is cheap but not free; only the zero-project
 * dashboard enables it.
 */
export function useSetupStatus(enabled = true) {
  return useQuery({
    queryKey: SETUP_STATUS_KEY,
    queryFn: api.setup.status,
    enabled,
    staleTime: 30_000,
  });
}

/** Persisting the dismissal keeps the screen hidden on every device, not just this browser. */
export function useDismissSetup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.settings.save({ setup_dismissed: true }),
    onSuccess: (saved) => client.setQueryData(WORKSPACE_PREFERENCES_KEY, saved),
  });
}

/**
 * Choose the default agent for new sessions through the same provider-settings
 * write Settings → Providers uses, so chat defaults and the providers list stay
 * in sync instead of a second "default" concept.
 */
export function useSetDefaultAgent() {
  const client = useQueryClient();
  const providers = useQuery({
    queryKey: PROVIDER_SETTINGS_KEY,
    queryFn: api.settings.providers.get,
  });
  const save = useMutation({
    mutationFn: async (agent: string) => {
      const current = providers.data;
      if (!current) throw new Error("Provider settings are still loading. Try again.");
      const profile = current.providers.find((item) => item.agent === agent && item.enabled);
      if (!profile) throw new Error("Enable this agent in Settings → Providers first.");
      return api.settings.providers.save({ ...current, default_provider_id: profile.id });
    },
    onSuccess: (saved) => {
      client.setQueryData(PROVIDER_SETTINGS_KEY, saved);
      client.invalidateQueries({ queryKey: SETUP_STATUS_KEY });
    },
  });
  return { providers, save };
}
