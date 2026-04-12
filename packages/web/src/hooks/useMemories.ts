import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useMemories(params?: { scope?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["memories", params],
    queryFn: () => api.memories.list({ ...params, limit: 100 }),
    refetchInterval: 60_000,
    select: (data) => data.memories,
  });
}

export function useMemorySearch(q: string) {
  return useQuery({
    queryKey: ["memories-search", q],
    queryFn: () => api.memories.search(q),
    enabled: q.trim().length > 0,
    select: (data) => data.results,
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { content: string; scope?: string; tags?: string[]; importance?: string }) =>
      api.memories.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.memories.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}
