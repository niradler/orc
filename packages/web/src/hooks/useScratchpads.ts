import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type CreateScratchpadInput,
  type ScratchpadListParams,
  type UpdateScratchpadInput,
} from "@/api/client";

// Query roots match the "scratchpads" change resource, so agent edits refresh open views.
const LIST_KEY = "scratchpads";
const DETAIL_KEY = "scratchpad";

export function useScratchpads(params: ScratchpadListParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [LIST_KEY, params],
    queryFn: () => api.scratchpads.list(params),
    enabled: options?.enabled ?? true,
  });
}

export function useScratchpad(id: string | null) {
  return useQuery({
    queryKey: [DETAIL_KEY, id],
    queryFn: () => api.scratchpads.get(id as string),
    enabled: Boolean(id),
  });
}

export function useInvalidateScratchpads() {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [LIST_KEY] }),
      qc.invalidateQueries({ queryKey: [DETAIL_KEY] }),
    ]);
  };
}

export function useCreateScratchpad() {
  const invalidate = useInvalidateScratchpads();
  return useMutation({
    mutationFn: (data: CreateScratchpadInput) => api.scratchpads.create(data),
    onSuccess: invalidate,
  });
}

export function useUpdateScratchpad() {
  const invalidate = useInvalidateScratchpads();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateScratchpadInput) =>
      api.scratchpads.update(id, data),
    // A conflict also refreshes, so the editor can show the other writer's version.
    onSettled: invalidate,
  });
}

export function useDeleteScratchpad() {
  const qc = useQueryClient();
  const invalidate = useInvalidateScratchpads();
  return useMutation({
    mutationFn: (id: string) => api.scratchpads.delete(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: [DETAIL_KEY, id] });
      return invalidate();
    },
  });
}
