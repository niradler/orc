import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateJobInput, type UpdateJobInput } from "@/api/client";
import { applyBulkAction } from "@/lib/bulk-actions";

export function useJobs(params?: { project_id?: string; enabled?: boolean; limit?: number }) {
  return useQuery({
    queryKey: ["jobs", params],
    queryFn: () => api.jobs.listAll(params),
    select: (data) => data.jobs,
  });
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ["job", id],
    queryFn: () => api.jobs.get(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateJobInput) => api.jobs.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useUpdateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateJobInput) => api.jobs.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job"] });
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useSetJobsEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      ids,
      enabled,
      scope,
    }: {
      ids: string[];
      enabled: boolean;
      scope: string;
    }) => {
      return {
        ...(await applyBulkAction(ids, (id) => api.jobs.update(id, { enabled }))),
        enabled,
        scope,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["job"] });
    },
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useTriggerJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.trigger(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["webhooks"] });
    },
  });
}

export function useJobRuns(jobId: string | null) {
  return useQuery({
    queryKey: ["job-runs", jobId],
    queryFn: () => api.jobs.runs(jobId as string),
    select: (data) => data.runs,
    enabled: Boolean(jobId),
  });
}

export function useJobRunLogs(jobId: string | null, runId: string | null) {
  return useQuery({
    queryKey: ["job-run-logs", jobId, runId],
    queryFn: () => api.jobs.runLogs(jobId as string, runId as string),
    enabled: Boolean(jobId) && Boolean(runId),
    select: (data) => data.logs,
  });
}
