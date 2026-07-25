import { describe, expect, test } from "bun:test";
import { type FlowDefinition, parseFlowDefinition } from "./flow.js";
import {
  advanceFlow,
  checkFlowTimeout,
  evaluateCondition,
  type FlowAction,
  type FlowState,
  startFlow,
} from "./flow-engine.js";
import { BUILTIN_FLOW_SOURCES } from "./flows/builtin.js";

const NOW = 1_700_000_000;

function def(raw: unknown): FlowDefinition {
  const parsed = parseFlowDefinition(raw);
  if (!parsed.ok) throw new Error(`fixture is not a valid flow: ${parsed.errors.join("; ")}`);
  return parsed.definition;
}

function builtin(name: string): FlowDefinition {
  return def(BUILTIN_FLOW_SOURCES[name]);
}

function spawned(actions: FlowAction[]): string[] {
  return actions.filter((a) => a.kind === "spawn").map((a) => a.nodeId);
}

function cancelled(actions: FlowAction[]): string[] {
  return actions.filter((a) => a.kind === "cancel").map((a) => a.nodeId);
}

/** Resolve whichever node is active, using a scripted outcome per node visit. */
function drive(
  definition: FlowDefinition,
  script: (
    nodeId: string,
    attempt: number,
  ) => { outcome?: string; error?: string; vars?: Record<string, unknown> },
  opts?: { vars?: Record<string, unknown>; maxSteps?: number },
): { state: FlowState; trail: string[] } {
  const startOpts = opts?.vars ? { now: NOW, vars: opts.vars } : { now: NOW };
  let step = startFlow(definition, startOpts);
  const trail = spawned(step.actions);
  let guard = 0;

  while (step.state.status === "running" && step.state.active.length > 0) {
    if (++guard > (opts?.maxSteps ?? 100)) throw new Error("drive() did not converge");
    const node = step.state.active[0];
    if (!node) break;
    const result = script(node.nodeId, node.attempt);
    step = advanceFlow(definition, step.state, { ...node, ...result }, { now: NOW });
    trail.push(...spawned(step.actions));
  }
  return { state: step.state, trail };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  const ctx = {
    outcome: "fail",
    visits: { build: 2 },
    executions: 5,
    vars: { score: 7, label: "needs work", flag: true, budget: 4 },
    elapsed_secs: 30,
    self: "verify",
  };

  test("always matches", () => {
    expect(evaluateCondition({ always: true }, ctx)).toBe(true);
  });

  test("outcome matches a string or a list", () => {
    expect(evaluateCondition({ outcome: "fail" }, ctx)).toBe(true);
    expect(evaluateCondition({ outcome: "pass" }, ctx)).toBe(false);
    expect(evaluateCondition({ outcome: ["pass", "fail"] }, ctx)).toBe(true);
  });

  test("visits defaults to the node the edge leaves from", () => {
    expect(evaluateCondition({ visits: { lt: 1 } }, ctx)).toBe(true); // verify: 0 visits
    expect(evaluateCondition({ visits: { node: "build", eq: 2 } }, ctx)).toBe(true);
    expect(evaluateCondition({ visits: { node: "build", gte: 3 } }, ctx)).toBe(false);
  });

  test("comparators can reference a run var", () => {
    expect(evaluateCondition({ visits: { node: "build", lt: { var: "budget" } } }, ctx)).toBe(true);
    expect(evaluateCondition({ visits: { node: "build", gte: { var: "budget" } } }, ctx)).toBe(
      false,
    );
  });

  test("a missing or non-numeric var operand fails closed", () => {
    expect(evaluateCondition({ visits: { node: "build", lt: { var: "nope" } } }, ctx)).toBe(false);
    expect(evaluateCondition({ visits: { node: "build", lt: { var: "label" } } }, ctx)).toBe(false);
  });

  test("var comparisons cover equality, numbers, contains and existence", () => {
    expect(evaluateCondition({ var: "flag", eq: true }, ctx)).toBe(true);
    expect(evaluateCondition({ var: "score", gte: 7 }, ctx)).toBe(true);
    expect(evaluateCondition({ var: "score", gt: 7 }, ctx)).toBe(false);
    expect(evaluateCondition({ var: "label", contains: "needs" }, ctx)).toBe(true);
    expect(evaluateCondition({ var: "missing", exists: false }, ctx)).toBe(true);
    expect(evaluateCondition({ var: "score", exists: true }, ctx)).toBe(true);
    // A numeric comparison against a non-number is false, not a throw.
    expect(evaluateCondition({ var: "label", gt: 1 }, ctx)).toBe(false);
  });

  test("elapsed_secs and executions read run counters", () => {
    expect(evaluateCondition({ elapsed_secs: { gt: 10 } }, ctx)).toBe(true);
    expect(evaluateCondition({ executions: { lt: 5 } }, ctx)).toBe(false);
  });

  test("all/any/not compose", () => {
    expect(evaluateCondition({ all: [{ outcome: "fail" }, { var: "flag", eq: true }] }, ctx)).toBe(
      true,
    );
    expect(evaluateCondition({ all: [{ outcome: "fail" }, { var: "flag", eq: false }] }, ctx)).toBe(
      false,
    );
    expect(evaluateCondition({ any: [{ outcome: "pass" }, { outcome: "fail" }] }, ctx)).toBe(true);
    expect(evaluateCondition({ not: { outcome: "pass" } }, ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// orc-default — the flow that replaced the hardcoded worker/reviewer pipeline
// ---------------------------------------------------------------------------

describe("orc-default", () => {
  const flow = builtin("orc-default");
  const vars = { required_review: true, max_review_rounds: 3 };

  test("build then approve completes the task", () => {
    const { state, trail } = drive(
      flow,
      (node) => ({ outcome: node === "build" ? "submitted" : "approved" }),
      { vars },
    );
    expect(trail).toEqual(["build", "review"]);
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("done");
  });

  test("changes_requested loops back to build within the task's budget, then escalates", () => {
    const { state, trail } = drive(
      flow,
      (node) => ({ outcome: node === "build" ? "submitted" : "changes_requested" }),
      { vars },
    );
    // max_review_rounds 3 → build runs 3 times, matching the pre-flow
    // review_rounds behaviour, then hands back to a human. Escalation is a
    // terminal node, so the graph completed — it is the task that is paused.
    expect(trail.filter((n) => n === "build")).toHaveLength(3);
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("paused");
  });

  test("required_review=false skips the review node entirely", () => {
    const { state, trail } = drive(flow, () => ({ outcome: "submitted" }), {
      vars: { required_review: false, max_review_rounds: 3 },
    });
    expect(trail).toEqual(["build"]);
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("done");
  });

  test("a blocked build ends the flow with the task blocked", () => {
    const { state } = drive(flow, () => ({ outcome: "blocked" }), { vars });
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("blocked");
  });

  test("a crashed build routes through on_error instead of halting", () => {
    const { state } = drive(flow, () => ({ error: "agent crashed" }), { vars });
    // build.on_error = blocked → terminal blocked, not an opaque halt.
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("blocked");
  });

  test("a review error falls through to escalation", () => {
    const { state } = drive(
      flow,
      (node) => (node === "build" ? { outcome: "submitted" } : { error: "reviewer died" }),
      { vars },
    );
    expect(state.status).toBe("completed");
    expect(state.task_status).toBe("paused");
  });

  test("a missing max_review_rounds var cannot open an unbounded loop", () => {
    const { state, trail } = drive(
      flow,
      (node) => ({ outcome: node === "build" ? "submitted" : "changes_requested" }),
      { vars: { required_review: true } },
    );
    // The loopback guard cannot resolve its budget, so it never fires: one
    // build, then straight to escalation.
    expect(trail.filter((n) => n === "build")).toHaveLength(1);
    expect(state.task_status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// Termination rails
// ---------------------------------------------------------------------------

describe("termination rails", () => {
  const loopFlow = def({
    name: "loop",
    entry: "work",
    limits: { max_node_executions: 5, execution_timeout_secs: 100 },
    nodes: {
      work: { kind: "agent", skill: "s", max_visits: 3, outcomes: ["again"] },
      done: { kind: "terminal" },
    },
    edges: [
      { from: "work", to: "work", when: { outcome: "again" } },
      { from: "work", to: "done", when: { always: true } },
    ],
  });

  test("max_visits stops a self-loop", () => {
    const { state, trail } = drive(loopFlow, () => ({ outcome: "again" }));
    expect(trail).toHaveLength(3);
    expect(state.status).toBe("halted");
    expect(state.halt_reason).toBe("max_visits:work");
    expect(state.task_status).toBe("paused");
  });

  test("max_node_executions stops a loop with no per-node cap", () => {
    const noCap = def({
      name: "nocap",
      entry: "work",
      limits: { max_node_executions: 4, execution_timeout_secs: 100 },
      nodes: {
        work: { kind: "agent", skill: "s", outcomes: ["again"] },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "work", to: "work", when: { outcome: "again" } },
        { from: "work", to: "done", when: { always: true } },
      ],
    });
    const { state, trail } = drive(noCap, () => ({ outcome: "again" }));
    expect(trail).toHaveLength(4);
    expect(state.halt_reason).toBe("max_node_executions");
  });

  test("the wall clock halts a flow that overran while a node was working", () => {
    const step = startFlow(loopFlow, { now: NOW });
    const node = step.state.active[0];
    if (!node) throw new Error("expected an active node");
    const late = advanceFlow(
      loopFlow,
      step.state,
      { ...node, outcome: "again" },
      { now: NOW + 101 },
    );
    expect(late.state.status).toBe("halted");
    expect(late.state.halt_reason).toBe("execution_timeout");
  });

  test("checkFlowTimeout catches a run whose nodes never report at all", () => {
    const step = startFlow(loopFlow, { now: NOW });
    expect(checkFlowTimeout(loopFlow, step.state, NOW + 50)).toBeNull();
    const timedOut = checkFlowTimeout(loopFlow, step.state, NOW + 101);
    expect(timedOut?.state.status).toBe("halted");
    expect(cancelled(timedOut?.actions ?? [])).toEqual(["work"]);
  });

  test("an unroutable outcome halts instead of hanging", () => {
    const { state } = drive(loopFlow, () => ({ outcome: "unexpected" }), { maxSteps: 5 });
    // The catch-all edge takes it to done; remove that and it must halt.
    expect(state.status).toBe("completed");

    const strict = def({
      name: "strict",
      entry: "work",
      nodes: {
        work: { kind: "agent", skill: "s", outcomes: ["ok"] },
        done: { kind: "terminal" },
      },
      edges: [{ from: "work", to: "done", when: { outcome: "ok" } }],
    });
    const { state: halted } = drive(strict, () => ({ outcome: "surprise" }));
    expect(halted.status).toBe("halted");
    expect(halted.halt_reason).toBe("no_matching_edge:work:surprise");
  });

  test("a node error with no on_error route halts with the error attached", () => {
    const strict = def({
      name: "strict2",
      entry: "work",
      nodes: {
        work: { kind: "agent", skill: "s", outcomes: ["ok"] },
        done: { kind: "terminal" },
      },
      edges: [{ from: "work", to: "done", when: { outcome: "ok" } }],
    });
    const { state } = drive(strict, () => ({ error: "boom" }));
    expect(state.status).toBe("halted");
    expect(state.halt_reason).toBe("node_error:work:boom");
  });

  test("a node that reports nothing at all halts rather than stalling", () => {
    const { state } = drive(loopFlow, () => ({}));
    expect(state.status).toBe("halted");
    expect(state.halt_reason).toBe("no_outcome:work");
  });

  test("mutually routing gates trip the gate chain limit", () => {
    // The exit edge is statically reachable (so the graph validates) but its
    // condition never holds at runtime, leaving the gates routing to each other.
    const gateLoop = def({
      name: "gateloop",
      entry: "a",
      limits: { max_node_executions: 1000 },
      nodes: {
        a: { kind: "gate" },
        b: { kind: "gate" },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "a", to: "done", when: { var: "escape_hatch", eq: true } },
        { from: "a", to: "b", when: { always: true } },
        { from: "b", to: "a", when: { always: true } },
      ],
    });
    const step = startFlow(gateLoop, { now: NOW });
    expect(step.state.status).toBe("halted");
    expect(step.state.halt_reason).toBe("gate_chain_limit");
  });
});

// ---------------------------------------------------------------------------
// Fan-out and joins
// ---------------------------------------------------------------------------

describe("fan-out and joins", () => {
  const flow = builtin("orc-parallel-review");
  const vars = { max_review_rounds: 3 };

  test("one build fans out into three concurrent reviewers", () => {
    const step = startFlow(flow, { now: NOW, vars });
    const build = step.state.active[0];
    if (!build) throw new Error("expected build");
    const next = advanceFlow(flow, step.state, { ...build, outcome: "submitted" }, { now: NOW });
    expect(spawned(next.actions).sort()).toEqual([
      "review_correctness",
      "review_security",
      "review_tests",
    ]);
    expect(next.state.active).toHaveLength(3);
  });

  test("the join waits for every branch before the verdict routes", () => {
    let step = startFlow(flow, { now: NOW, vars });
    const build = step.state.active[0];
    if (!build) throw new Error("expected build");
    step = advanceFlow(flow, step.state, { ...build, outcome: "submitted" }, { now: NOW });

    const branches = [...step.state.active];
    const okVar: Record<string, string> = {
      review_correctness: "correctness_ok",
      review_security: "security_ok",
      review_tests: "tests_ok",
    };

    for (const [i, branch] of branches.entries()) {
      const varName = okVar[branch.nodeId] as string;
      step = advanceFlow(
        flow,
        step.state,
        { ...branch, outcome: "reviewed", vars: { [varName]: true } },
        { now: NOW },
      );
      if (i < branches.length - 1) {
        // Still parked at the join, nothing new spawned, flow still running.
        expect(step.state.status).toBe("running");
        expect(spawned(step.actions)).toEqual([]);
        expect(Object.keys(step.state.joins)).toEqual(["verdict"]);
      }
    }

    expect(step.state.status).toBe("completed");
    expect(step.state.task_status).toBe("done");
  });

  test("a failing branch sends the work back to build with verdict vars cleared", () => {
    let step = startFlow(flow, { now: NOW, vars });
    const build = step.state.active[0];
    if (!build) throw new Error("expected build");
    step = advanceFlow(flow, step.state, { ...build, outcome: "submitted" }, { now: NOW });

    const results: Record<string, boolean> = {
      review_correctness: true,
      review_security: false,
      review_tests: true,
    };
    const okVar: Record<string, string> = {
      review_correctness: "correctness_ok",
      review_security: "security_ok",
      review_tests: "tests_ok",
    };
    for (const branch of [...step.state.active]) {
      const varName = okVar[branch.nodeId] as string;
      step = advanceFlow(
        flow,
        step.state,
        { ...branch, outcome: "reviewed", vars: { [varName]: results[branch.nodeId] } },
        { now: NOW },
      );
    }

    expect(spawned(step.actions)).toEqual(["build"]);
    // Re-entering build resets the verdicts, so last round's passes cannot
    // carry over and wave the next round through.
    expect(step.state.vars.correctness_ok).toBeNull();
    expect(step.state.vars.security_ok).toBeNull();
    expect(step.state.vars.tests_ok).toBeNull();
  });

  test("an any-join takes the first arrival and cancels its siblings", () => {
    const raceFlow = def({
      name: "race",
      entry: "start",
      nodes: {
        start: { kind: "gate", routing: "all" },
        a: { kind: "agent", skill: "s", outcomes: ["ok"] },
        b: { kind: "agent", skill: "s", outcomes: ["ok"] },
        pick: { kind: "gate", join: { mode: "any", from: ["a", "b"] } },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "pick", when: { always: true } },
        { from: "b", to: "pick", when: { always: true } },
        { from: "pick", to: "done", when: { always: true } },
      ],
    });

    const step = startFlow(raceFlow, { now: NOW });
    expect(step.state.active).toHaveLength(2);
    const first = step.state.active[0];
    if (!first) throw new Error("expected a branch");
    const next = advanceFlow(raceFlow, step.state, { ...first, outcome: "ok" }, { now: NOW });
    expect(next.state.status).toBe("completed");
    expect(cancelled(next.actions)).toEqual(["b"]);
    expect(next.state.active).toHaveLength(0);
  });

  test("a terminal reached on one branch cancels the others", () => {
    const bailFlow = def({
      name: "bail",
      entry: "start",
      nodes: {
        start: { kind: "gate", routing: "all" },
        a: { kind: "agent", skill: "s", outcomes: ["abort", "ok"] },
        b: { kind: "agent", skill: "s", outcomes: ["ok"] },
        join: { kind: "gate", join: { mode: "all", from: ["a", "b"] } },
        stopped: { kind: "terminal", task_status: "blocked" },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "stopped", when: { outcome: "abort" } },
        { from: "a", to: "join", when: { always: true } },
        { from: "b", to: "join", when: { always: true } },
        { from: "join", to: "done", when: { always: true } },
      ],
    });

    const step = startFlow(bailFlow, { now: NOW });
    const a = step.state.active.find((n) => n.nodeId === "a");
    if (!a) throw new Error("expected a");
    const next = advanceFlow(bailFlow, step.state, { ...a, outcome: "abort" }, { now: NOW });
    expect(next.state.status).toBe("completed");
    expect(next.state.task_status).toBe("blocked");
    expect(cancelled(next.actions)).toEqual(["b"]);
  });

  test("branches parked at a join that can never complete are a detected deadlock", () => {
    const deadFlow = def({
      name: "dead",
      entry: "start",
      nodes: {
        start: { kind: "gate" },
        a: { kind: "agent", skill: "s", outcomes: ["ok"] },
        ghost: { kind: "agent", skill: "s", outcomes: ["ok"] },
        join: { kind: "gate", join: { mode: "all", from: ["a", "ghost"] } },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "start", to: "ghost", when: { var: "spawn_ghost", eq: true } },
        { from: "start", to: "a", when: { always: true } },
        { from: "a", to: "join", when: { always: true } },
        { from: "ghost", to: "join", when: { always: true } },
        { from: "join", to: "done", when: { always: true } },
      ],
    });
    // `ghost` never actually runs, so the all-join can never be satisfied and
    // the one live branch parks forever.
    const { state } = drive(deadFlow, () => ({ outcome: "ok" }));
    expect(state.status).toBe("halted");
    expect(state.halt_reason).toBe("join_deadlock");
  });
});

// ---------------------------------------------------------------------------
// Session reuse and idempotency
// ---------------------------------------------------------------------------

describe("revisit semantics", () => {
  test("reset_on_revisit=false asks the caller to resume the previous session", () => {
    const flow = builtin("orc-supervisor");
    let step = startFlow(flow, { now: NOW });
    const first = step.state.active[0];
    if (!first) throw new Error("expected execute");
    expect(step.actions[0]).toMatchObject({ kind: "spawn", nodeId: "execute", resume: false });

    step = advanceFlow(flow, step.state, { ...first, outcome: "milestone" }, { now: NOW });
    const supervise = step.state.active[0];
    if (!supervise) throw new Error("expected supervise");
    step = advanceFlow(
      flow,
      step.state,
      { ...supervise, outcome: "continue", vars: { directive: "keep going" } },
      { now: NOW },
    );

    // The executor keeps its context across rounds; the supervisor never does.
    expect(step.actions.find((a) => a.kind === "spawn")).toMatchObject({
      nodeId: "execute",
      attempt: 2,
      resume: true,
    });
    expect(step.state.vars.directive).toBe("keep going");
  });

  test("reset_on_revisit=true (the default) always starts a fresh session", () => {
    const flow = builtin("orc-default");
    const vars = { required_review: true, max_review_rounds: 3 };
    let step = startFlow(flow, { now: NOW, vars });
    const build = step.state.active[0];
    if (!build) throw new Error("expected build");
    step = advanceFlow(flow, step.state, { ...build, outcome: "submitted" }, { now: NOW });
    const review = step.state.active[0];
    if (!review) throw new Error("expected review");
    step = advanceFlow(flow, step.state, { ...review, outcome: "changes_requested" }, { now: NOW });
    expect(step.actions.find((a) => a.kind === "spawn")).toMatchObject({
      nodeId: "build",
      attempt: 2,
      resume: false,
    });
  });
});

describe("idempotency", () => {
  const flow = builtin("orc-default");
  const vars = { required_review: true, max_review_rounds: 3 };

  test("a duplicate report for an already-resolved node is ignored", () => {
    const step = startFlow(flow, { now: NOW, vars });
    const build = step.state.active[0];
    if (!build) throw new Error("expected build");
    const first = advanceFlow(flow, step.state, { ...build, outcome: "submitted" }, { now: NOW });
    const replay = advanceFlow(flow, first.state, { ...build, outcome: "submitted" }, { now: NOW });
    expect(replay.actions).toEqual([]);
    expect(replay.state).toBe(first.state);
  });

  test("a report for a stale attempt number is ignored", () => {
    const step = startFlow(flow, { now: NOW, vars });
    const stale = advanceFlow(
      flow,
      step.state,
      { nodeId: "build", attempt: 99, outcome: "submitted" },
      { now: NOW },
    );
    expect(stale.actions).toEqual([]);
  });

  test("advancing a finished flow is a no-op", () => {
    const { state } = drive(
      flow,
      (node) => ({ outcome: node === "build" ? "submitted" : "approved" }),
      { vars },
    );
    expect(state.status).toBe("completed");
    const after = advanceFlow(
      flow,
      state,
      { nodeId: "review", attempt: 1, outcome: "approved" },
      { now: NOW },
    );
    expect(after.actions).toEqual([]);
  });
});

describe("all builtin flows", () => {
  test("parse, validate, and start without halting", () => {
    for (const [name, raw] of Object.entries(BUILTIN_FLOW_SOURCES)) {
      const parsed = parseFlowDefinition(raw);
      expect(parsed.ok, `${name} should be a valid flow`).toBe(true);
      if (!parsed.ok) continue;
      const step = startFlow(parsed.definition, {
        now: NOW,
        vars: { required_review: true, max_review_rounds: 3 },
      });
      expect(step.state.status, `${name} should start running`).toBe("running");
      expect(step.state.active.length, `${name} should spawn an entry node`).toBeGreaterThan(0);
    }
  });
});
