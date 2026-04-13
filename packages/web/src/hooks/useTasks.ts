import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type CreateTaskInput,
  type CreateTaskLinkInput,
  type UpdateTaskInput,
} from "@/api/client";

export function useTasks(params?: { status?: string; project_id?: string }) {
  return useQuery({
    queryKey: ["tasks", params],
    queryFn: () => api.tasks.list({ ...params, limit: 100 }),
    refetchInterval: 30_000,
    select: (data) => data.tasks,
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.tasks.get(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTaskInput) => api.tasks.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateTaskInput) => api.tasks.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["task"] });
    },
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
}

export function useTaskComments(id: string | null) {
  return useQuery({
    queryKey: ["task-comments", id],
    queryFn: () => api.tasks.listComments(id as string),
    enabled: Boolean(id),
    select: (data) => data.comments,
  });
}

export function useAddTaskComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content, author }: { id: string; content: string; author?: string }) =>
      api.tasks.addComment(id, content, author),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["task-comments", vars.id] }),
  });
}

export function useTaskLinks(id: string | null) {
  return useQuery({
    queryKey: ["task-links", id],
    queryFn: () => api.tasks.listLinks(id as string),
    enabled: Boolean(id),
    select: (data) => data.links,
  });
}

export function useCreateTaskLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & CreateTaskLinkInput) =>
      api.tasks.addLink(id, data),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["task-links", vars.id] }),
  });
}

export function useDeleteTaskLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, linkId }: { taskId: string; linkId: string }) =>
      api.tasks.deleteLink(taskId, linkId),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["task-links", vars.taskId] }),
  });
}
