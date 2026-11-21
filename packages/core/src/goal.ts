import { z } from "zod";
import type { FlowDefinition, FlowEdge, FlowNode } from "./flow.js";

/**
 * A goal is a durable objective an agent loop works until an external success
 * check passes (#173). ORC drives the loop as a flow — worker, check, guarded
 * loopback, stall ladder — so the budget, the check history and the escalation
 * are visible and enforceable here, not inside one harness's private loop.
 */
export const GoalBudgetSchema = z
  .strictObject({
    iterations: z.number().int().min(1).max(200).default(30),
    tokens: z.number().int().min(1).max(100_000_000).optional(),
    hours: z.number().min(0.1).max(168).default(6),
  })
  .default({ iterations: 30, hours: 6 });

export const GoalSpecSchema = z.strictObject({
  objective: z.string().min(1).max(2000),
  check: z.string().min(1).max(4000),
  metric_pattern: z.string().max(500).optional(),
  agents: z.array(z.string().min(1).max(64)).min(1).max(4).default(["claude"]),
  budget: GoalBudgetSchema,
  stall_limit: z.number().int().min(1).max(20).default(3),
  skill: z.string().max(200).optional(),
  project_id: z.string().optional(),
  task_id: z.string().optional(),
});
export type GoalSpec = z.infer<typeof GoalSpecSchema>;
export type GoalBudget = z.infer<typeof GoalBudgetSchema>;

export const GOAL_CHECK_NODE = "check";
export const GOAL_STAGE_VAR = "goal_stage";
export const GOAL_STALL_VAR = "check_stall";
export const GOAL_TOKENS_VAR = "tokens_used";

/**
 * The goal's flow: one worker stage per allowed agent, a command check after
 * every worker turn, and a loopback while the check fails with budget left.
 * A stalled metric switches to the next agent; after the last agent it asks a
 * reviewer for a diagnosis and then raises one human request and halts.
 * Workers resume their native session across iterations (reset_on_revisit
 * false) so the loop keeps its conversation, not just its ledger.
 */
export function buildGoalFlow(spec: GoalSpec, name: string): FlowDefinition {
  const skill = spec.skill ?? "orc-coder";
  const iterations = spec.budget.iterations;
  const nodes: Record<string, FlowNode> = {};
  const edges: FlowEdge[] = [];

  spec.agents.forEach((backend, stage) => {
    nodes[`work_${stage}`] = {
      kind: "agent",
      backend,
      skill,
      role: "worker",
      prompt:
        `Work toward this goal: ${spec.objective}\n` +
        `The success check is: ${spec.check}\n` +
        `Make real progress each turn; report outcome "submitted" when you believe the check passes or you are blocked.`,
      outcomes: ["submitted"],
      // Only a stage switch clears the stall count; a loopback within the same
      // stage must keep it, or the ladder would never trigger.
      vars:
        stage === 0 ? { [GOAL_STAGE_VAR]: 0 } : { [GOAL_STAGE_VAR]: stage, [GOAL_STALL_VAR]: 0 },
    };
    edges.push({ from: `work_${stage}`, to: GOAL_CHECK_NODE, when: { always: true } });
  });

  nodes[GOAL_CHECK_NODE] = {
    kind: "command",
    command: spec.check,
    ...(spec.metric_pattern ? { metric_pattern: spec.metric_pattern } : {}),
    description: "Goal success check",
  };
  nodes.reviewer = {
    kind: "agent",
    // The ladder's allowed agents bound every agent node: the reviewer must not
    // fall back to the install default, which the goal may not permit.
    backend: spec.agents[spec.agents.length - 1],
    skill,
    role: "reviewer",
    prompt:
      `Diagnose why this goal's check keeps failing: ${spec.objective}\n` +
      `Check: ${spec.check}\n` +
      `Read the latest check output (run var check_output) and the worktree; report outcome "diagnosed" with the root cause and a suggested approach.`,
    outcomes: ["diagnosed"],
  };
  nodes.human = {
    kind: "human",
    description: "Goal stalled across every allowed agent — a human must decide",
    // The task list must show the escalation honestly while the flow waits.
    task_status: "blocked",
  };
  nodes.done = { kind: "terminal", task_status: "done" };
  nodes.halted = { kind: "terminal", task_status: "paused" };

  edges.push({ from: GOAL_CHECK_NODE, to: "done", when: { outcome: "passed" } });
  const budgetLeft = (stage: number) => [
    { outcome: "failed" as const },
    { visits: { node: GOAL_CHECK_NODE, lt: iterations } },
    ...(spec.budget.tokens ? [{ var: GOAL_TOKENS_VAR, lt: spec.budget.tokens }] : []),
    { var: GOAL_STAGE_VAR, eq: stage },
  ];
  spec.agents.forEach((_, stage) => {
    const stalled = { var: GOAL_STALL_VAR, gte: spec.stall_limit };
    const next = stage + 1 < spec.agents.length ? `work_${stage + 1}` : "reviewer";
    edges.push({
      from: GOAL_CHECK_NODE,
      to: next,
      when: { all: [...budgetLeft(stage), stalled] },
    });
    edges.push({
      from: GOAL_CHECK_NODE,
      to: `work_${stage}`,
      when: { all: [...budgetLeft(stage), { var: GOAL_STALL_VAR, lt: spec.stall_limit }] },
    });
  });
  // Budget gone or every stage stalled past the ladder: stop within budget.
  edges.push({ from: GOAL_CHECK_NODE, to: "halted", when: { outcome: "failed" } });
  edges.push({ from: "reviewer", to: "human", when: { always: true } });
  edges.push({ from: "human", to: "halted", when: { always: true } });

  return {
    name,
    description: `Goal: ${spec.objective}`.slice(0, 2000),
    version: 1,
    entry: "work_0",
    isolation: "worktree",
    nodes,
    edges,
    limits: {
      // Each iteration is a worker turn plus a check; leave room for the ladder.
      max_node_executions: Math.min(500, iterations * 2 + spec.agents.length * 2 + 8),
      execution_timeout_secs: Math.min(604_800, Math.max(1, Math.round(spec.budget.hours * 3600))),
      max_parallel: 1,
      reset_on_revisit: false,
      halt_task_status: "paused",
    },
  };
}

export type GoalRunStatus = {
  status: "active" | "passed" | "halted" | "stopped";
  iteration: number;
  stage: number;
  stall: number;
  tokens_used: number;
  last_check: { exit: number | null; metric: number | null; output: string | null } | null;
  halt_reason: string | null;
  /** The flow run's own clock (unix seconds) — the goal record never moves on completion. */
  started_at: number | null;
  ended_at: number | null;
};

/** Goal status is derived from the flow run, never a second synced truth. */
export function goalStatusFromRun(run: {
  status: string;
  task_status?: string | null | undefined;
  halt_reason?: string | null | undefined;
  visits: Record<string, number>;
  vars: Record<string, unknown>;
  started_at?: number | null | undefined;
  ended_at?: number | null | undefined;
}): GoalRunStatus {
  const num = (value: unknown) => (typeof value === "number" ? value : 0);
  const exit = run.vars[`${GOAL_CHECK_NODE}_exit`];
  const metric = run.vars[`${GOAL_CHECK_NODE}_metric`];
  const output = run.vars[`${GOAL_CHECK_NODE}_output`];
  // Both terminals complete the graph; the task status they set is the verdict.
  // An engine halt (node error, spent budget, timeout) is a failed goal, not a
  // user stop; only a cancelled run — goal_stop or a human taking the task —
  // reads as stopped.
  const status =
    run.status === "completed"
      ? run.task_status === "done"
        ? "passed"
        : "halted"
      : run.status === "running"
        ? "active"
        : run.status === "halted"
          ? "halted"
          : "stopped";
  return {
    status,
    iteration: run.visits[GOAL_CHECK_NODE] ?? 0,
    stage: num(run.vars[GOAL_STAGE_VAR]),
    stall: num(run.vars[GOAL_STALL_VAR]),
    tokens_used: num(run.vars[GOAL_TOKENS_VAR]),
    last_check:
      typeof exit === "number"
        ? {
            exit,
            metric: typeof metric === "number" ? metric : null,
            output: typeof output === "string" ? output : null,
          }
        : null,
    halt_reason: run.halt_reason ?? null,
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? null,
  };
}
