import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.jobs.list(),
    refetchInterval: 15_000,
    select: (data) => data.jobs,
  });
}

export function useTriggerJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.jobs.trigger(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useJobRuns(jobId: string) {
  return useQuery({
    queryKey: ["job-runs", jobId],
    queryFn: () => api.jobs.runs(jobId),
    refetchInterval: 5_000,
    select: (data) => data.runs,
    enabled: Boolean(jobId),
  });
}
