import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FlowSource, type ResumeFlowInput } from "@/api/client";

export function useFlows(params?: { q?: string; source?: FlowSource }) {
  return useQuery({
    queryKey: ["flows", params],
    queryFn: () => api.flows.list(params),
    refetchInterval: 60_000,
  });
}

export function useFlow(name: string | null) {
  return useQuery({
    queryKey: ["flow", name],
    queryFn: () => api.flows.get(name as string),
    enabled: Boolean(name),
  });
}

export function useTaskFlow(taskId: string | null) {
  return useQuery({
    queryKey: ["task-flow", taskId],
    queryFn: () => api.tasks.flow(taskId as string),
    enabled: Boolean(taskId),
    // A live run changes underneath us; a finished one does not.
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5_000 : 30_000),
  });
}

/** Invalidate everything a flow transition can change: the run, the task, its comments. */
function useFlowMutation<TVars extends { taskId: string }, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["task-flow", vars.taskId] });
      qc.invalidateQueries({ queryKey: ["task", vars.taskId] });
      qc.invalidateQueries({ queryKey: ["task-comments", vars.taskId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useResumeFlow() {
  return useFlowMutation(({ taskId, ...input }: { taskId: string } & ResumeFlowInput) =>
    api.tasks.resumeFlow(taskId, input),
  );
}

export function useHaltFlow() {
  return useFlowMutation(({ taskId, reason }: { taskId: string; reason?: string }) =>
    api.tasks.haltFlow(taskId, reason),
  );
}
