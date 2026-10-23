import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useWorktrees(cwd: string, host?: string | null) {
  return useQuery({
    queryKey: ["worktrees", cwd, host],
    queryFn: () => api.git.worktrees(cwd, host),
    enabled: cwd.trim() !== "",
    retry: false,
    staleTime: 5_000,
  });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { cwd: string; path: string; force?: boolean; host?: string | null }) =>
      api.git.removeWorktree(data),
    onSettled: () => qc.invalidateQueries({ queryKey: ["worktrees"] }),
  });
}
