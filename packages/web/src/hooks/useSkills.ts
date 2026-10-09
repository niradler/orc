import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateSkillInput } from "@/api/client";

export function useSkills(params?: { q?: string; source?: "builtin" | "user" }) {
  return useQuery({
    queryKey: ["skills", params],
    queryFn: () => api.skills.list(params),
    refetchInterval: 60_000,
  });
}

export function useSkill(name: string | null, ref?: string, projectId?: string) {
  return useQuery({
    queryKey: ["skill", name, ref, projectId],
    queryFn: () => api.skills.get(name as string, ref, projectId),
    enabled: Boolean(name),
  });
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateSkillInput) => api.skills.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}
