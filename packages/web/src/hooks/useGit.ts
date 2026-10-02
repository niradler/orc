import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useWorktrees(cwd: string) {
  return useQuery({
    queryKey: ["worktrees", cwd],
    queryFn: () => api.git.worktrees(cwd),
    enabled: cwd.trim() !== "",
    retry: false,
    staleTime: 5_000,
  });
}

export function useRemoveWorktree() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { cwd: string; path: string; force?: boolean }) =>
      api.git.removeWorktree(data),
    onSettled: () => qc.invalidateQueries({ queryKey: ["worktrees"] }),
  });
}
