import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { buildGoalFlow, GOAL_CHECK_NODE, type GoalSpec, goalStatusFromRun } from "@orc/core/goal";
import { ulid } from "@orc/core/ids";
import { getDb, getSqlite } from "@orc/db/client";
import { goals, tasks } from "@orc/db/schema";
import { withTaskAudit } from "@orc/db/task-audit";
import { desc, eq } from "drizzle-orm";
import {
  cancelFlowRun,
  drainPendingNodes,
  getActiveFlowRunForTask,
  getFlowRunView,
  startFlowForTask,
} from "./flow-runner.js";

/**
 * Goals (#173) as a service shared by the REST routes and the MCP tools: a goal
 * is a task whose inline flow loops worker and check until the check passes or
 * the budget/stall ladder halts it. Status is derived from the flow run and the
 * task status at read time — never a second synced truth.
 */
export type GoalView = {
  id: string;
  task_id: string;
  flow_run_id: string | null;
  objective: string;
  spec: GoalSpec;
  status: "active" | "stopped";
  run: ReturnType<typeof goalStatusFromRun> | null;
  created_at: number;
  updated_at: number;
};

export type GoalCheckVisit = {
  attempt: number;
  retry: number;
  outcome: string | null;
  summary: string | null;
  started_at: number | null;
  ended_at: number | null;
};

type GoalRow = typeof goals.$inferSelect;

async function goalView(row: GoalRow): Promise<GoalView> {
  const view = row.flow_run_id ? getFlowRunView(row.flow_run_id) : null;
  const task = await getDb().query.tasks.findFirst({ where: eq(tasks.id, row.task_id) });
  const run = view
    ? goalStatusFromRun({
        status: view.status,
        task_status: task?.status ?? null,
        halt_reason: view.halt_reason,
        visits: view.visits,
        vars: view.vars,
        started_at: view.started_at,
        ended_at: view.ended_at,
      })
    : null;
  return {
    id: row.id,
    task_id: row.task_id,
    flow_run_id: row.flow_run_id,
    objective: row.objective,
    spec: row.spec as GoalSpec,
    status: row.status,
    run: row.status === "stopped" && run ? { ...run, status: "stopped" as const } : run,
    created_at: row.created_at.getTime(),
    updated_at: row.updated_at.getTime(),
  };
}

export async function listGoals(): Promise<GoalView[]> {
  const rows = await getDb().query.goals.findMany({
    orderBy: [desc(goals.created_at)],
    limit: 100,
  });
  return Promise.all(rows.map(goalView));
}

export async function getGoal(
  id: string,
): Promise<{ goal: GoalView; history: GoalCheckVisit[] } | null> {
  const row = await getDb().query.goals.findFirst({ where: eq(goals.id, id) });
  if (!row) return null;
  const view = row.flow_run_id ? getFlowRunView(row.flow_run_id) : null;
  const history = (view?.nodes ?? [])
    .filter((node) => node.node_id === GOAL_CHECK_NODE)
    .map((node) => ({
      attempt: node.attempt,
      retry: node.retry,
      outcome: node.outcome,
      summary: node.summary,
      started_at: node.started_at,
      ended_at: node.ended_at,
    }));
  return { goal: await goalView(row), history };
}

export async function getTaskGoal(taskId: string): Promise<GoalView | null> {
  const row = await getDb().query.goals.findFirst({
    where: eq(goals.task_id, taskId),
    orderBy: [desc(goals.created_at)],
  });
  return row ? goalView(row) : null;
}

export async function createGoal(spec: GoalSpec): Promise<GoalView> {
  const db = getDb();
  let taskId = spec.task_id;
  if (taskId) {
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) throw new NotFoundError("Task", taskId);
    if (["done", "cancelled"].includes(task.status)) {
      throw new ValidationError(
        `Task is ${task.status}; move it back to todo before attaching a goal`,
      );
    }
    if (getActiveFlowRunForTask(taskId)) {
      throw new ConflictError("Task already has a running flow; stop it before attaching a goal");
    }
    if (spec.project_id && task.project_id && task.project_id !== spec.project_id) {
      throw new ValidationError("Goal project differs from the task's project");
    }
  } else {
    taskId = ulid();
  }

  const definition = buildGoalFlow(spec, `goal-${ulid().toLowerCase()}`);
  const now = new Date();
  withTaskAudit(getSqlite(), [taskId], () => {
    if (spec.task_id) {
      db.update(tasks)
        .set({ flow_override: definition, updated_at: now })
        .where(eq(tasks.id, taskId))
        .run();
    } else {
      db.insert(tasks)
        .values({
          id: taskId,
          title: spec.objective.slice(0, 500),
          body: `Goal: ${spec.objective}\nSuccess check: ${spec.check}`,
          project_id: spec.project_id,
          status: "todo",
          priority: "normal",
          author: "goal",
          skill_name: spec.skill,
          required_review: false,
          flow_override: definition,
          created_at: now,
          updated_at: now,
        })
        .run();
    }
  });

  const result = await startFlowForTask(taskId, { vars: { tokens_used: 0 } });
  if (!result.ok) throw new ConflictError(result.error);
  const goalId = ulid();
  withTaskAudit(getSqlite(), [taskId], () => {
    db.insert(goals)
      .values({
        id: goalId,
        task_id: taskId,
        flow_run_id: result.flowRunId,
        objective: spec.objective,
        spec,
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .run();
  });
  await drainPendingNodes();
  const row = await db.query.goals.findFirst({ where: eq(goals.id, goalId) });
  if (!row) throw new Error("Expected goal to exist after write");
  return goalView(row);
}

export async function stopGoal(id: string): Promise<GoalView> {
  const db = getDb();
  const row = await db.query.goals.findFirst({ where: eq(goals.id, id) });
  if (!row) throw new NotFoundError("Goal", id);
  if (row.flow_run_id) await cancelFlowRun(row.flow_run_id, "goal_stop");
  db.update(goals).set({ status: "stopped", updated_at: new Date() }).where(eq(goals.id, id)).run();
  const updated = await db.query.goals.findFirst({ where: eq(goals.id, id) });
  if (!updated) throw new Error("Expected goal to exist after write");
  return goalView(updated);
}
