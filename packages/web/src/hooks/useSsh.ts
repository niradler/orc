import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useSsh() {
  return useQuery({
    queryKey: ["ssh"],
    queryFn: () => api.ssh.get(),
  });
}

export function useSelectSshHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ host, remotePort }: { host: string | null; remotePort?: number | null }) =>
      api.ssh.select(host, remotePort),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useTestSshHost() {
  return useMutation({ mutationFn: (host?: string) => api.ssh.test(host) });
}
