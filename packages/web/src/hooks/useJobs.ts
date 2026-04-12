import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateJobInput, type UpdateJobInput } from "@/api/client";

export function useJobs(params?: { project_id?: string; enabled?: boolean }) {
  return useQuery({
    queryKey: ["jobs", params],
    queryFn: () => api.jobs.list(params),
    refetchInterval: 15_000,
    select: (data) => data.jobs,
  });
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ["job", id],
    queryFn: () => api.jobs.get(id!),
    enabled: Boolean(id),
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateJobInput) => api.jobs.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useUpdateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateJobInput) =>
      api.jobs.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["job"] });
    },
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useTriggerJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.trigger(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useJobRuns(jobId: string | null) {
  return useQuery({
    queryKey: ["job-runs", jobId],
    queryFn: () => api.jobs.runs(jobId!),
    refetchInterval: 5_000,
    select: (data) => data.runs,
    enabled: Boolean(jobId),
  });
}

export function useJobRunLogs(jobId: string | null, runId: string | null) {
  return useQuery({
    queryKey: ["job-run-logs", jobId, runId],
    queryFn: () => api.jobs.runLogs(jobId!, runId!),
    enabled: Boolean(jobId) && Boolean(runId),
    select: (data) => data.logs,
  });
}
