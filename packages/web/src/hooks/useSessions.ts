import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TranscriptPage } from "@/api/client";

export function useSessions(params?: { agent?: string; limit?: number }) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => api.sessions.list({ ...params, limit: params?.limit ?? 50 }),
    refetchInterval: 30_000,
    select: (data) => data.sessions,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.sessions.get(id),
    enabled: Boolean(id),
  });
}

export function useLiveSessions(active: boolean) {
  return useQuery({
    queryKey: ["sessions", "live", active],
    queryFn: () => api.sessions.live({ active, limit: 5000 }),
    refetchInterval: 3_000,
    select: (data) => data.sessions,
  });
}

export function useSyncSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.sessions.sync(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions", "live"] }),
  });
}

export function useLinkSessionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, taskId }: { id: string; taskId: string | null }) =>
      api.sessions.linkTask(id, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions", "live"] }),
  });
}

export function useSessionSearch(q: string, agent: string) {
  return useQuery({
    queryKey: ["sessions", "search", q, agent],
    queryFn: () => api.sessions.search({ q, ...(agent ? { agent } : {}), limit: 200 }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}

const TRANSCRIPT_PAGE = 500;

export function useTranscript(id: string | null, q: string, live: boolean) {
  return useQuery({
    queryKey: ["sessions", "transcript", id, q],
    queryFn: async (): Promise<TranscriptPage> => {
      const first = await api.sessions.transcript(id as string, {
        offset: 0,
        limit: TRANSCRIPT_PAGE,
        ...(q ? { q } : {}),
      });
      const turns = [...first.turns];
      while (turns.length < first.total) {
        const next = await api.sessions.transcript(id as string, {
          offset: turns.length,
          limit: TRANSCRIPT_PAGE,
        });
        if (next.turns.length === 0) break;
        turns.push(...next.turns);
      }
      return { ...first, turns };
    },
    enabled: Boolean(id),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: live ? 5_000 : false,
    retry: false,
  });
}

export function useTaskSessions(taskId: string | null) {
  return useQuery({
    queryKey: ["sessions", "live", "task", taskId],
    queryFn: () => api.sessions.live({ task_id: taskId as string, active: false, limit: 100 }),
    enabled: Boolean(taskId),
    refetchInterval: 10_000,
    select: (data) => data.sessions,
  });
}
