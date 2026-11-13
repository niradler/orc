import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TranscriptPage } from "@/api/client";

export function useSessions(params?: { agent?: string; limit?: number }) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => api.sessions.list({ ...params, limit: params?.limit ?? 50 }),
    select: (data) => data.sessions,
  });
}

export function useLoggedSessions(params: {
  project_id?: string;
  limit: number;
  offset: number;
  order?: "asc" | "desc";
}) {
  return useQuery({
    queryKey: ["sessions", "logged", params],
    queryFn: () => api.sessions.list(params),
    placeholderData: keepPreviousData,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.sessions.get(id),
    enabled: Boolean(id),
  });
}

export function useLiveSessions(active: boolean, projectId?: string, includeHidden = false) {
  return useQuery({
    queryKey: ["sessions", "live", active, projectId, includeHidden],
    queryFn: () =>
      api.sessions.live({
        active,
        limit: 5000,
        ...(includeHidden ? { include_hidden: true } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      }),
    select: (data) => data.sessions,
  });
}

export function useSyncSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.sessions.sync(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useLinkSessionTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, taskId }: { id: string; taskId: string | null }) =>
      api.sessions.linkTask(id, taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useUpdateLiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      display_title?: string | null;
      hidden?: boolean;
    }) => api.sessions.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useSessionSearch(
  q: string,
  agent: string,
  projectId?: string,
  includeHidden = false,
) {
  return useQuery({
    queryKey: ["sessions", "search", q, agent, projectId, includeHidden],
    queryFn: () =>
      api.sessions.search({
        q,
        ...(agent ? { agent } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(includeHidden ? { include_hidden: true } : {}),
        limit: 200,
      }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
}

const TRANSCRIPT_PAGE = 500;

export function useTranscript(id: string | null, q: string) {
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
    retry: false,
  });
}

export function useTaskSessions(taskId: string | null) {
  return useQuery({
    queryKey: ["sessions", "live", "task", taskId],
    queryFn: () =>
      api.sessions.live({
        task_id: taskId as string,
        active: false,
        limit: 100,
      }),
    enabled: Boolean(taskId),
    select: (data) => data.sessions,
  });
}

export function useSessionLineage(sessionId: string | null) {
  return useQuery({
    queryKey: ["sessions", "lineage", sessionId],
    queryFn: () => api.sessions.lineage(sessionId as string),
    enabled: Boolean(sessionId),
    retry: false,
  });
}

export function useSessionMessages(sessionId: string | null, live: boolean) {
  return useQuery({
    queryKey: ["sessions", "messages", sessionId],
    queryFn: () => api.sessions.messages(sessionId as string),
    select: (data) => data.messages,
    enabled: Boolean(sessionId),
    staleTime: 0,
    refetchInterval: live ? 10_000 : false,
    retry: false,
  });
}

function useSessionMessageAction(sessionId: string | null) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["sessions", "messages", sessionId] });
}

export function useSendSessionMessage(sessionId: string | null) {
  const refresh = useSessionMessageAction(sessionId);
  return useMutation({
    mutationFn: (body: string) => api.sessions.sendMessage(sessionId as string, body),
    onSuccess: refresh,
  });
}

export function useCancelSessionMessage(sessionId: string | null) {
  const refresh = useSessionMessageAction(sessionId);
  return useMutation({
    mutationFn: (messageId: string) => api.sessions.cancelMessage(messageId),
    onSuccess: refresh,
  });
}

export function useMoveSessionMessage(sessionId: string | null) {
  const refresh = useSessionMessageAction(sessionId);
  return useMutation({
    mutationFn: (input: { messageId: string; direction: "up" | "down" }) =>
      api.sessions.moveMessage(input.messageId, input.direction),
    onSuccess: refresh,
  });
}
