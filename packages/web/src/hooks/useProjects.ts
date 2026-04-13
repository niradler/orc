import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateProjectInput, type UpdateProjectInput } from "@/api/client";

export function useProjects(params?: { status?: string }) {
  return useQuery({
    queryKey: ["projects", params],
    queryFn: () => api.projects.list(params),
    refetchInterval: 60_000,
    select: (data) => data.projects,
  });
}

export function useProject(id: string | null) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.projects.get(id as string),
    enabled: Boolean(id),
  });
}

export function useProjectSummary(id: string | null) {
  return useQuery({
    queryKey: ["project-summary", id],
    queryFn: () => api.projects.summary(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectInput) => api.projects.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateProjectInput) =>
      api.projects.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project"] });
      qc.invalidateQueries({ queryKey: ["project-summary"] });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.projects.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

export function useProjectComments(id: string | null) {
  return useQuery({
    queryKey: ["project-comments", id],
    queryFn: () => api.projects.listComments(id as string),
    enabled: Boolean(id),
    select: (data) => data.comments,
  });
}

export function useAddProjectComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content, author }: { id: string; content: string; author?: string }) =>
      api.projects.addComment(id, content, author),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: ["project-comments", vars.id] }),
  });
}
