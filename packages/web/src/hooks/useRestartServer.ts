import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/api/client";

export function useRestartServer() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const previous = await api.system.restart();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const health = await api.health.check(AbortSignal.timeout(2000));
          if (health.instance_id !== previous.instance_id) return;
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) throw error;
        }
      }
      throw new Error(
        "ORC has not reconnected yet. Check the server and try again when it is online.",
      );
    },
    onSuccess: () => queries.invalidateQueries(),
  });
}
