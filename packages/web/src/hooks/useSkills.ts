import type { ScopeQuery, SkillVisibility } from "@orc/sdk/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateSkillInput } from "@/api/client";

export function useSkills(
  params?: { q?: string; source?: "builtin" | "user"; include_hidden?: boolean } & ScopeQuery,
) {
  return useQuery({
    queryKey: ["skills", params],
    queryFn: () => api.skills.list(params),
  });
}

export function useSkillVisibility() {
  return useQuery({ queryKey: ["skill-visibility"], queryFn: () => api.skills.visibility() });
}

export function useSetSkillVisibility() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policy: Partial<SkillVisibility>) => api.skills.setVisibility(policy),
    onSuccess: (policy) => {
      qc.setQueryData(["skill-visibility"], policy);
      qc.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useSkill(name: string | null, ref?: string, scope: ScopeQuery = {}) {
  return useQuery({
    queryKey: ["skill", name, ref, scope],
    queryFn: () => api.skills.get(name as string, ref, scope),
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
