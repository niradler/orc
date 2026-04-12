import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useKnowledgeCollections(params?: { project_id?: string }) {
  return useQuery({
    queryKey: ["knowledge-collections", params],
    queryFn: () => api.knowledge.collections(params),
    refetchInterval: 60_000,
    select: (data) => data.collections,
  });
}

export function useKnowledgeSearch(q: string, opts?: { collection?: string; project_id?: string; limit?: number }) {
  return useQuery({
    queryKey: ["knowledge-search", q, opts],
    queryFn: () => api.knowledge.search(q, opts),
    enabled: q.trim().length > 0,
    select: (data) => data.results,
  });
}

export function useKnowledgeDocument(id: string | null) {
  return useQuery({
    queryKey: ["knowledge-document", id],
    queryFn: () => api.knowledge.getDocument(id!),
    enabled: Boolean(id),
  });
}

export function useKnowledgeStatus() {
  return useQuery({
    queryKey: ["knowledge-status"],
    queryFn: () => api.knowledge.status(),
    refetchInterval: 60_000,
  });
}

export function useAddKnowledgeCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; path: string; pattern?: string; project_id?: string }) =>
      api.knowledge.addCollection(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge-collections"] }),
  });
}

export function useRemoveKnowledgeCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.knowledge.removeCollection(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge-collections"] }),
  });
}

export function useReindexKnowledge() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts?: { collections?: string[] }) => api.knowledge.update(opts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge-collections"] });
      qc.invalidateQueries({ queryKey: ["knowledge-status"] });
    },
  });
}
