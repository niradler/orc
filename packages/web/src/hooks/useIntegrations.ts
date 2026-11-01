import type { IntegrationConnectionSource } from "@orc/sdk/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

const connectionsKey = ["integrations", "connections"] as const;

export function useConnections(enabled: boolean) {
  return useQuery({
    queryKey: connectionsKey,
    queryFn: () => api.integrations.connections(),
    select: (result) => result.connections,
    enabled,
  });
}

export function useConnection(name: string | null) {
  return useQuery({
    queryKey: [...connectionsKey, name],
    queryFn: () => api.integrations.connection(name ?? ""),
    enabled: name !== null,
  });
}

export function useConnectionTools(name: string | null) {
  return useQuery({
    queryKey: [...connectionsKey, name, "tools"],
    queryFn: () => api.integrations.tools(name ?? ""),
    select: (result) => result.tools,
    enabled: name !== null,
  });
}

export function useConnectionTool(name: string, tool: string | null) {
  return useQuery({
    queryKey: [...connectionsKey, name, "tools", tool],
    queryFn: () => api.integrations.tool(name, tool ?? ""),
    enabled: tool !== null,
  });
}

/** Every change goes through spec-cli, so the whole connections tree is refetched afterwards. */
function useConnectionMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionsKey }),
  });
}

export function useSaveConnection() {
  return useConnectionMutation(
    ({
      name,
      source,
      create,
    }: {
      name: string;
      source: IntegrationConnectionSource;
      create: boolean;
    }) => (create ? api.integrations.create(name, source) : api.integrations.update(name, source)),
  );
}

/** Checks an unsaved draft; nothing is stored, so no query is invalidated. */
export function useTestConnection() {
  return useMutation({
    mutationFn: ({ name, source }: { name: string; source: IntegrationConnectionSource }) =>
      api.integrations.test(name, source),
  });
}

export function useSetConnectionEnabled() {
  return useConnectionMutation(({ name, enabled }: { name: string; enabled: boolean }) =>
    api.integrations.setEnabled(name, enabled),
  );
}

export function useRemoveConnection() {
  return useConnectionMutation((name: string) => api.integrations.remove(name));
}

export function useRefreshConnection() {
  return useConnectionMutation((name: string) => api.integrations.refresh(name));
}

export function useSetToolEnabled() {
  return useConnectionMutation(
    ({ name, tool, enabled }: { name: string; tool: string; enabled: boolean }) =>
      api.integrations.setToolEnabled(name, tool, enabled),
  );
}

export function useInvokeTool() {
  return useMutation({
    mutationFn: ({
      name,
      tool,
      args,
    }: {
      name: string;
      tool: string;
      args: Record<string, unknown>;
    }) => api.integrations.invoke(name, tool, args),
  });
}

export function useConnectionResources(name: string, enabled: boolean) {
  return useQuery({
    queryKey: [...connectionsKey, name, "resources"],
    queryFn: () => api.integrations.resources(name),
    enabled,
  });
}

export function useConnectionPrompts(name: string, enabled: boolean) {
  return useQuery({
    queryKey: [...connectionsKey, name, "prompts"],
    queryFn: () => api.integrations.prompts(name),
    enabled,
  });
}

export function useReadResource() {
  return useMutation({
    mutationFn: ({
      name,
      uri,
      vars,
    }: {
      name: string;
      uri: string;
      vars: Record<string, string>;
    }) => api.integrations.readResource(name, uri, vars),
  });
}

export function useGetPrompt() {
  return useMutation({
    mutationFn: ({
      name,
      prompt,
      args,
    }: {
      name: string;
      prompt: string;
      args: Record<string, string>;
    }) => api.integrations.getPrompt(name, prompt, args),
  });
}
