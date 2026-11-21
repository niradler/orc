import { describe, expect, test } from "bun:test";
import { type FlowDefinition, parseFlowDefinition } from "./flow.js";
import { advanceFlow, type FlowAction, type FlowState, startFlow } from "./flow-engine.js";
import { buildGoalFlow, GoalSpecSchema, goalStatusFromRun } from "./goal.js";

const NOW = 1_700_000_000;

function goalDef(overrides?: Partial<ReturnType<typeof GoalSpecSchema.parse>>): FlowDefinition {
  const spec = GoalSpecSchema.parse({
    objective: "make the suite pass",
    check: "bun test",
    agents: ["claude", "codex"],
    ...overrides,
  });
  const parsed = parseFlowDefinition(buildGoalFlow(spec, "goal-test"));
  if (!parsed.ok) throw new Error(`goal flow is not valid: ${parsed.errors.join("; ")}`);
  return parsed.definition;
}

/** Drive the graph with a scripted verdict per node visit, recording spawns. */
function drive(
  definition: FlowDefinition,
  script: (
    nodeId: string,
    attempt: number,
  ) => { outcome?: string; error?: string; vars?: Record<string, unknown> },
  opts?: { vars?: Record<string, unknown>; maxSteps?: number },
): { state: FlowState; trail: string[]; resumes: Record<string, boolean> } {
  let step = startFlow(definition, { now: NOW, ...(opts?.vars ? { vars: opts.vars } : {}) });
  const trail: string[] = [];
  const resumes: Record<string, boolean> = {};
  const record = (actions: FlowAction[]) => {
    for (const action of actions) {
      if (action.kind === "spawn") {
        trail.push(action.nodeId);
        resumes[`${action.nodeId}:${action.attempt}`] = action.resume;
      }
    }
  };
  record(step.actions);
  let guard = 0;
  while (step.state.status === "running" && step.state.active.length > 0) {
    if (++guard > (opts?.maxSteps ?? 100)) throw new Error("drive() did not converge");
    const node = step.state.active[0];
    if (!node) break;
    step = advanceFlow(
      definition,
      step.state,
      { ...node, ...script(node.nodeId, node.attempt) },
      { now: NOW },
    );
    record(step.actions);
  }
  return { state: step.state, trail, resumes };
}

const submitted = () => ({ outcome: "submitted" });
const failed = (vars: Record<string, unknown> = {}) => ({
  outcome: "failed",
  vars: { check_exit: 1, ...vars },
});

describe("buildGoalFlow", () => {
  test("a passing check completes the goal on the first iteration", () => {
    const { state, trail } = drive(goalDef(), (node) =>
      node === "check" ? { outcome: "passed", vars: { check_exit: 0 } } : submitted(),
    );
    expect(trail).toEqual(["work_0", "check"]);
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("done");
    expect(goalStatusFromRun(state).status).toBe("passed");
  });

  test("a failed check loops the same worker, resuming its native session", () => {
    let checks = 0;
    const { state, resumes } = drive(goalDef(), (node) => {
      if (node !== "check") return submitted();
      checks += 1;
      return checks < 2
        ? failed({ check_stall: 0 })
        : { outcome: "passed", vars: { check_exit: 0 } };
    });
    expect(state.visits.check).toBe(2);
    expect(state.visits.work_0).toBe(2);
    expect(state.task_status).toBe("done");
    // reset_on_revisit false: the second worker visit resumes, not restarts.
    expect(resumes["work_0:2"]).toBe(true);
  });

  test("a stalled metric switches to the next agent and clears the stall", () => {
    let checks = 0;
    const { state, trail } = drive(goalDef(), (node) => {
      if (node === "work_0" || node === "work_1") return submitted();
      if (node === "check") {
        checks += 1;
        return checks === 1
          ? failed({ check_stall: 3, check_metric: 80 })
          : { outcome: "passed", vars: { check_exit: 0 } };
      }
      return { outcome: "diagnosed" };
    });
    expect(trail).toContain("work_1");
    expect(state.vars.goal_stage).toBe(1);
    expect(state.vars.check_stall).toBe(0);
    expect(state.task_status).toBe("done");
  });

  test("stalling on the last agent escalates reviewer, then one human, then halts", () => {
    const { state, trail } = drive(goalDef(), (node) => {
      if (node.startsWith("work_")) return submitted();
      if (node === "check") return failed({ check_stall: 3 });
      if (node === "reviewer") return { outcome: "diagnosed" };
      return { outcome: "answered" };
    });
    expect(trail).toEqual(["work_0", "check", "work_1", "check", "reviewer", "human"]);
    expect(state.task_status).toBe("paused");
    expect(goalStatusFromRun(state).status).toBe("halted");
  });

  test("the reviewer stays within the goal's allowed agents", () => {
    const def = buildGoalFlow(
      GoalSpecSchema.parse({
        objective: "x",
        check: "exit 0",
        agents: ["claude", "codex-cli"],
      }),
      "goal-reviewer-backend",
    );
    expect(def.nodes.reviewer?.backend).toBe("codex-cli");
    expect(def.nodes.work_0?.backend).toBe("claude");
    expect(def.nodes.work_1?.backend).toBe("codex-cli");
  });

  test("the iteration budget halts the loop within budget", () => {
    const { state } = drive(goalDef({ budget: { iterations: 2, hours: 6 } }), (node) =>
      node === "check" ? failed({ check_stall: 0 }) : submitted(),
    );
    expect(state.visits.check).toBe(2);
    expect(state.task_status).toBe("paused");
    expect(goalStatusFromRun(state).status).toBe("halted");
  });

  test("the token budget halts the loop once recorded usage crosses it", () => {
    const { state } = drive(
      goalDef({ budget: { iterations: 30, tokens: 100, hours: 6 } }),
      (node) => (node === "check" ? failed({ check_stall: 0, tokens_used: 150 }) : submitted()),
    );
    expect(state.visits.check).toBe(1);
    expect(state.task_status).toBe("paused");
  });
});

describe("goalStatusFromRun", () => {
  test("reads iteration, stage, stall, tokens and the last check from run state", () => {
    const status = goalStatusFromRun({
      status: "running",
      halt_reason: null,
      visits: { check: 4, work_0: 4 },
      vars: {
        goal_stage: 1,
        check_stall: 2,
        tokens_used: 1234,
        check_exit: 1,
        check_metric: 80,
        check_output: "2 failing",
      },
      started_at: 1000,
      ended_at: 1060,
    });
    expect(status).toEqual({
      status: "active",
      iteration: 4,
      stage: 1,
      stall: 2,
      tokens_used: 1234,
      last_check: { exit: 1, metric: 80, output: "2 failing" },
      halt_reason: null,
      started_at: 1000,
      ended_at: 1060,
    });
  });

  test("a cancelled run reads stopped, a fresh run active with no check yet", () => {
    expect(
      goalStatusFromRun({ status: "cancelled", halt_reason: "goal_stop", visits: {}, vars: {} })
        .status,
    ).toBe("stopped");
    const fresh = goalStatusFromRun({ status: "running", halt_reason: null, visits: {}, vars: {} });
    expect(fresh.status).toBe("active");
    expect(fresh.last_check).toBeNull();
  });

  test("an engine halt reads halted, not stopped — a failed goal is not a user stop", () => {
    const status = goalStatusFromRun({
      status: "halted",
      halt_reason: "node_error:work_0:backend auth failed",
      visits: {},
      vars: {},
    });
    expect(status.status).toBe("halted");
    expect(status.halt_reason).toBe("node_error:work_0:backend auth failed");
  });
});
