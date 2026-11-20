import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CreateGoalInput, type Goal } from "@/api/client";
import { useResourceFallback } from "@/hooks/useResourceFallback";

export function useGoals() {
  return useQuery({
    queryKey: ["goals"],
    queryFn: () => api.goals.list(),
    refetchInterval: useResourceFallback(),
  });
}

export function useGoal(id: string | null) {
  return useQuery({
    queryKey: ["goal", id],
    queryFn: () => api.goals.get(id as string),
    enabled: Boolean(id),
    refetchInterval: useResourceFallback(),
  });
}

/** The goal attached to a task, or null. Live via the tasks resource stream. */
export function useTaskGoal(taskId: string | null) {
  return useQuery({
    queryKey: ["task-goal", taskId],
    queryFn: () => api.goals.forTask(taskId as string),
    enabled: Boolean(taskId),
    refetchInterval: useResourceFallback(),
  });
}

/** A goal transition changes the run, the task, its comments and the goal list. */
function useGoalMutation<TVars, TData extends { goal: Goal }>(
  mutationFn: (vars: TVars) => Promise<TData>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      const taskId = data.goal.task_id;
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["goal"] });
      qc.invalidateQueries({ queryKey: ["task-goal", taskId] });
      qc.invalidateQueries({ queryKey: ["task-flow", taskId] });
      qc.invalidateQueries({ queryKey: ["task", taskId] });
      qc.invalidateQueries({ queryKey: ["task-comments", taskId] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useCreateGoal() {
  return useGoalMutation((input: CreateGoalInput) => api.goals.create(input));
}

export function useStopGoal() {
  return useGoalMutation(({ id }: { id: string }) => api.goals.stop(id));
}
