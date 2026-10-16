import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type CreateMemoryInput,
  type MemoryListParams,
  type RevertMemoryInput,
  type UpdateMemoryInput,
} from "@/api/client";

// Query roots match the "memories" change resource (and "memory-usage" → ["memories"]),
// so live updates refresh lists without re-reading an open memory on every read event.
const LIST_KEY = "memories";
const DETAIL_KEY = "memory";
const HISTORY_KEY = "memory-history";

export function useMemories(params: MemoryListParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [LIST_KEY, params],
    queryFn: () => api.memories.list(params),
    enabled: options?.enabled ?? true,
  });
}

export function useMemory(projectId: string | null, name: string | null) {
  return useQuery({
    queryKey: [DETAIL_KEY, projectId, name],
    queryFn: () => api.memories.get(projectId as string, name as string),
    enabled: Boolean(projectId && name),
  });
}

export function useMemoryHistory(projectId: string | null, name: string | null) {
  return useQuery({
    queryKey: [HISTORY_KEY, projectId, name],
    queryFn: () => api.memories.history(projectId as string, name as string),
    enabled: Boolean(projectId && name),
  });
}

function useInvalidateMemories() {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [LIST_KEY] }),
      qc.invalidateQueries({ queryKey: [DETAIL_KEY] }),
      qc.invalidateQueries({ queryKey: [HISTORY_KEY] }),
    ]);
  };
}

export function useCreateMemory() {
  const invalidate = useInvalidateMemories();
  return useMutation({
    mutationFn: (data: CreateMemoryInput) => api.memories.create(data),
    onSuccess: invalidate,
  });
}

export function useUpdateMemory() {
  const invalidate = useInvalidateMemories();
  return useMutation({
    mutationFn: ({ name, ...data }: { name: string } & UpdateMemoryInput) =>
      api.memories.update(name, data),
    onSuccess: invalidate,
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  const invalidate = useInvalidateMemories();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      api.memories.delete(projectId, name),
    onSuccess: (_, { projectId, name }) => {
      // Re-fetching the deleted memory would only 404; drop it instead.
      qc.removeQueries({ queryKey: [DETAIL_KEY, projectId, name] });
      return invalidate();
    },
  });
}

export function useRevertMemory() {
  const invalidate = useInvalidateMemories();
  return useMutation({
    mutationFn: ({ name, ...input }: { name: string } & RevertMemoryInput) =>
      api.memories.revert(name, input),
    onSuccess: invalidate,
  });
}
