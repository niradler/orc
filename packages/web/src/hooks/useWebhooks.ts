import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateWebhookInput } from "@/api/client";

export function useWebhooks(projectId?: string) {
  return useQuery({
    queryKey: ["webhooks", projectId],
    queryFn: () => api.webhooks.list(projectId),
    select: (data) => data.webhooks,
  });
}
export function useWebhookDeliveries(id: string | null) {
  return useQuery({
    queryKey: ["webhook-deliveries", id],
    queryFn: () => api.webhooks.deliveries(id as string),
    select: (data) => data.deliveries,
    enabled: Boolean(id),
    refetchInterval: 3000,
  });
}
export function useCreateWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWebhookInput) => api.webhooks.create(input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["webhooks"] }),
  });
}
export function useUpdateWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & Partial<CreateWebhookInput>) =>
      api.webhooks.update(id, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["webhooks"] }),
  });
}
export function useDeleteWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.webhooks.delete(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ["webhooks"] }),
  });
}
export function useRotateWebhook() {
  return useMutation({ mutationFn: (id: string) => api.webhooks.rotate(id) });
}
