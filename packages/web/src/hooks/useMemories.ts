import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateMemoryInput, type UpdateMemoryInput } from "@/api/client";

export function useMemories(params?: { scope?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["memories", params],
    queryFn: () => api.memories.list({ ...params, limit: 100 }),
    refetchInterval: 60_000,
    select: (data) => data.memories,
  });
}

export function useMemorySearch(q: string, opts?: { scope?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["memories-search", q, opts],
    queryFn: () => api.memories.search(q, opts),
    enabled: q.trim().length > 0,
    select: (data) => data.results,
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMemoryInput) => api.memories.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}

export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateMemoryInput) =>
      api.memories.update(id, data),
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
