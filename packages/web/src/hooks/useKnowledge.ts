import type { KbCommentStatus, KbSearchRequest } from "@orc/core/kb";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

// Every knowledge query key starts with "kb" so one invalidation refreshes the whole view.
export const KB_KEY = "kb";

// A digest is also a job, so its queries refresh on job changes too (see resource-events).
export const KB_DIGEST_KEY = "kb-digest";

export function useInvalidateKb() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [KB_KEY] }),
      queryClient.invalidateQueries({ queryKey: [KB_DIGEST_KEY] }),
    ]);
}

/** A project shows its own KBs plus global ones; "all projects" is a read-only cross-project view. */
export function useKnowledgeBases(projectId: string | undefined) {
  return useQuery({
    queryKey: [KB_KEY, "bases", projectId ?? "all"],
    queryFn: () =>
      api.kb.list(projectId ? { scope: "default", project_id: projectId } : { scope: "all" }),
    select: (data) => data.knowledge_bases,
  });
}

export function useKbDocuments(kbId: string | null, filter: { folder?: string; label?: string }) {
  return useQuery({
    queryKey: [KB_KEY, "documents", kbId, filter],
    queryFn: () => api.kb.documents(kbId as string, filter),
    enabled: Boolean(kbId),
    // Parsing and embedding run in the background; keep states fresh while anything is pending.
    refetchInterval: (query) =>
      query.state.data?.documents.some(
        (d) =>
          d.parse_state === "pending" ||
          d.index_state === "pending" ||
          d.index_state === "semantic_pending",
      )
        ? 3000
        : false,
  });
}

export function useKbDocument(id: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "document", id],
    queryFn: () => api.kb.document(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.parse_state === "pending" ? 3000 : false),
  });
}

export function useKbSearch(input: KbSearchRequest | null, projectId: string | undefined) {
  return useQuery({
    queryKey: [KB_KEY, "search", input, projectId],
    queryFn: () => api.kb.search(input as KbSearchRequest, projectId),
    enabled: Boolean(input?.query.trim()),
  });
}

export function useKbRevisions(documentId: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "revisions", documentId],
    queryFn: () => api.kb.revisions(documentId as string),
    enabled: Boolean(documentId),
    select: (data) => data.revisions,
  });
}

export function useKbDocumentUsage(documentId: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "document-usage", documentId],
    queryFn: () => api.kb.documentUsage(documentId as string),
    enabled: Boolean(documentId),
  });
}

export function useKbUsage(kbId: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "usage", kbId],
    queryFn: () => api.kb.usage(kbId as string),
    enabled: Boolean(kbId),
  });
}

export function useKbSources(kbId: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "sources", kbId],
    queryFn: () => api.kb.sources(kbId as string),
    enabled: Boolean(kbId),
    select: (data) => data.sources,
  });
}

export function useKbMaintenance(kbId: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "maintenance", kbId],
    queryFn: () => api.kb.maintenance(kbId as string),
    enabled: Boolean(kbId),
  });
}

export function useKbStatus() {
  return useQuery({
    queryKey: [KB_KEY, "status"],
    queryFn: () => api.kb.status(),
    refetchInterval: (query) => {
      const s = query.state.data;
      return s && (s.jobs.queued || s.jobs.running || s.embedding.pending_chunks) ? 5000 : 60_000;
    },
  });
}

export function useKbSettings() {
  return useQuery({ queryKey: [KB_KEY, "settings"], queryFn: () => api.kb.settings() });
}

export function useKbParsers() {
  return useQuery({
    queryKey: [KB_KEY, "parsers"],
    queryFn: () => api.kb.parsers(),
    refetchInterval: (query) => (query.state.data?.docling.state === "installing" ? 2000 : false),
  });
}

export function useKbComments(
  kbId: string,
  filter: { document_id?: string; status?: KbCommentStatus },
) {
  return useQuery({
    queryKey: [KB_KEY, "comments", kbId, filter],
    queryFn: () => api.kb.comments(kbId, filter),
    select: (data) => data.comments,
  });
}

export function useKbDigestTemplate(enabled: boolean) {
  return useQuery({
    queryKey: [KB_DIGEST_KEY, "template"],
    queryFn: () => api.kb.digestTemplate(),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const RUN_ACTIVE = new Set(["pending", "running"]);

export function useKbDigest(kbId: string) {
  return useQuery({
    queryKey: [KB_DIGEST_KEY, kbId],
    queryFn: () => api.kb.digest(kbId),
    select: (data) => data.digest,
    refetchInterval: (query) =>
      query.state.data?.digest?.last_run?.status === "running" ? 3000 : false,
  });
}

export function useKbDigestRuns(kbId: string, enabled: boolean) {
  return useQuery({
    queryKey: [KB_DIGEST_KEY, kbId, "runs"],
    queryFn: () => api.kb.digestRuns(kbId, 10),
    enabled,
    select: (data) => data.runs,
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => RUN_ACTIVE.has(r.status)) ? 3000 : false,
  });
}
