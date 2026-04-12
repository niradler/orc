import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list(),
    refetchInterval: 60_000,
    select: (data) => data.projects,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      api.projects.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
