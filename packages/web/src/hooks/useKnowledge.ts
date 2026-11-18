import type { KbCommentStatus, KbDigest, KbSearchRequest } from "@orc/core/kb";
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
export function useKnowledgeBases(projectId: string | undefined, globalOnly = false) {
  return useQuery({
    queryKey: [KB_KEY, "bases", projectId ?? (globalOnly ? "global" : "all")],
    queryFn: () =>
      api.kb.list(
        projectId
          ? { scope: "default", project_id: projectId }
          : { scope: globalOnly ? "global" : "all" },
      ),
    select: (data) => data.knowledge_bases,
  });
}

export function useKbDocuments(kbId: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "documents", kbId],
    queryFn: () => api.kb.documents(kbId as string),
    enabled: Boolean(kbId),
  });
}

export function useKbDocument(id: string | null) {
  return useQuery({
    queryKey: [KB_KEY, "document", id],
    queryFn: () => api.kb.document(id as string),
    enabled: Boolean(id),
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
  });
}

export function useKbSettings() {
  return useQuery({ queryKey: [KB_KEY, "settings"], queryFn: () => api.kb.settings() });
}

export function useKbParsers() {
  return useQuery({
    queryKey: [KB_KEY, "parsers"],
    queryFn: () => api.kb.parsers(),
  });
}

export function useKbComments(
  kbId: string,
  filter: { document_id?: string; status?: KbCommentStatus },
) {
  return useQuery({
    queryKey: [KB_KEY, "comments", kbId, filter],
    queryFn: () => api.kb.comments(kbId, filter),
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

export function useKbDigest(kbId: string) {
  return useQuery({
    queryKey: [KB_DIGEST_KEY, kbId],
    queryFn: () => api.kb.digest(kbId),
    select: (data) => data.digest,
  });
}

/**
 * Runs exist only while the digest does, so they key off its last run instead of refreshing with
 * every digest invalidation; a removed digest unmounts this query rather than asking for its runs.
 */
export function useKbDigestRuns(kbId: string, digest: KbDigest) {
  const last = digest.last_run;
  return useQuery({
    queryKey: ["kb-digest-runs", kbId, digest.job_id, last?.at ?? null, last?.status ?? null],
    queryFn: () => api.kb.digestRuns(kbId, 10),
    placeholderData: (previous) => previous,
    select: (data) => data.runs,
  });
}
