import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Task, type TaskPriority, type TaskStatus } from "@/api/client";

export function useTasks(params?: { status?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["tasks", params],
    queryFn: () => api.tasks.list({ ...params, limit: 100 }),
    refetchInterval: 30_000,
    select: (data) => data.tasks,
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      body?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      project_id?: string;
    }) => api.tasks.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Pick<Task, "status" | "priority" | "title" | "body">>) =>
      api.tasks.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}
