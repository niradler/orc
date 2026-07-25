import type { FlowCondition, FlowDefinition, NumericComparator, NumericOperand } from "./flow.js";
import type { TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// A deterministic graph interpreter. Everything here is pure: the same state
// plus the same node result always yields the same next state and the same
// actions. Nothing in this file touches the DB, the clock, or an agent — the
// caller supplies `now` and applies the actions. That is what makes loops,
// fan-out, joins and every termination rail testable without spawning an LLM.
// ---------------------------------------------------------------------------

export type ActiveNode = { nodeId: string; attempt: number };

export type FlowRunStatus = "running" | "completed" | "halted";

/**
 * A branch arriving at a join, stamped with the source node's visit count at
 * arrival time. The stamp is what stops a stale arrival from a previous loop
 * iteration satisfying the join in a later one.
 */
export type JoinArrival = { outcome: string; gen: number };

export type FlowState = {
  status: FlowRunStatus;
  active: ActiveNode[];
  visits: Record<string, number>;
  executions: number;
  vars: Record<string, unknown>;
  /** joinNodeId → (sourceNodeId → its arrival) */
  joins: Record<string, Record<string, JoinArrival>>;
  started_at: number;
  halt_reason?: string;
  task_status?: TaskStatus;
};

export type NodeResult = {
  nodeId: string;
  attempt: number;
  outcome?: string | undefined;
  vars?: Record<string, unknown> | undefined;
  error?: string | undefined;
};

export type FlowAction =
  | { kind: "spawn"; nodeId: string; attempt: number; resume: boolean }
  | { kind: "cancel"; nodeId: string; attempt: number; reason: string }
  | { kind: "complete"; nodeId: string; task_status: TaskStatus }
  | { kind: "halt"; reason: string; task_status: TaskStatus };

export type FlowStep = { state: FlowState; actions: FlowAction[] };

export type ConditionContext = {
  outcome: string;
  visits: Record<string, number>;
  executions: number;
  vars: Record<string, unknown>;
  elapsed_secs: number;
  self: string;
};

// A gate chain longer than this is a definition bug (mutually routing gates),
// not a legitimate flow. Bail loudly rather than spin.
const GATE_CHAIN_LIMIT = 64;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/**
 * Resolve a comparator operand. A `{ var }` operand that is missing or not a
 * number resolves to null and the comparison fails — fail closed, so a typo'd
 * budget var can never be what opens an unbounded loop.
 */
function resolveOperand(
  operand: NumericOperand | undefined,
  vars: Record<string, unknown>,
): number | null | undefined {
  if (operand === undefined) return undefined;
  if (typeof operand === "number") return operand;
  const value = vars[operand.var];
  return typeof value === "number" ? value : null;
}

function compareNumber(
  value: number,
  cmp: NumericComparator,
  vars: Record<string, unknown>,
): boolean {
  const eq = resolveOperand(cmp.eq, vars);
  const ne = resolveOperand(cmp.ne, vars);
  const lt = resolveOperand(cmp.lt, vars);
  const lte = resolveOperand(cmp.lte, vars);
  const gt = resolveOperand(cmp.gt, vars);
  const gte = resolveOperand(cmp.gte, vars);

  if (eq === null || ne === null || lt === null || lte === null || gt === null || gte === null) {
    return false;
  }
  if (eq !== undefined && value !== eq) return false;
  if (ne !== undefined && value === ne) return false;
  if (lt !== undefined && !(value < lt)) return false;
  if (lte !== undefined && !(value <= lte)) return false;
  if (gt !== undefined && !(value > gt)) return false;
  if (gte !== undefined && !(value >= gte)) return false;
  return true;
}

export function evaluateCondition(cond: FlowCondition, ctx: ConditionContext): boolean {
  if ("always" in cond) return true;

  if ("outcome" in cond) {
    return Array.isArray(cond.outcome)
      ? cond.outcome.includes(ctx.outcome)
      : cond.outcome === ctx.outcome;
  }

  if ("visits" in cond) {
    const nodeId = cond.visits.node ?? ctx.self;
    return compareNumber(ctx.visits[nodeId] ?? 0, cond.visits, ctx.vars);
  }

  if ("executions" in cond) return compareNumber(ctx.executions, cond.executions, ctx.vars);

  if ("elapsed_secs" in cond) return compareNumber(ctx.elapsed_secs, cond.elapsed_secs, ctx.vars);

  if ("var" in cond) {
    const value = ctx.vars[cond.var];
    if (cond.exists !== undefined) {
      const present = value !== undefined && value !== null;
      if (present !== cond.exists) return false;
    }
    if (cond.eq !== undefined && value !== cond.eq) return false;
    if (cond.ne !== undefined && value === cond.ne) return false;
    if (cond.contains !== undefined) {
      if (typeof value === "string") {
        if (!value.includes(cond.contains)) return false;
      } else if (Array.isArray(value)) {
        if (!value.includes(cond.contains)) return false;
      } else {
        return false;
      }
    }
    const numeric = { lt: cond.lt, lte: cond.lte, gt: cond.gt, gte: cond.gte };
    const hasNumeric = Object.values(numeric).some((v) => v !== undefined);
    if (hasNumeric) {
      if (typeof value !== "number") return false;
      if (!compareNumber(value, numeric, ctx.vars)) return false;
    }
    return true;
  }

  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, ctx));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, ctx));
  if ("not" in cond) return !evaluateCondition(cond.not, ctx);

  return false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Target = { to: string; from: string | null; outcome: string };
type RouteResult = { ok: true; targets: Target[] } | { ok: false; halt: string };

function cloneState(state: FlowState): FlowState {
  const next: FlowState = {
    status: state.status,
    active: state.active.map((a) => ({ ...a })),
    visits: { ...state.visits },
    executions: state.executions,
    vars: { ...state.vars },
    joins: Object.fromEntries(
      Object.entries(state.joins).map(([k, v]) => [
        k,
        Object.fromEntries(Object.entries(v).map(([from, arrival]) => [from, { ...arrival }])),
      ]),
    ),
    started_at: state.started_at,
  };
  if (state.halt_reason !== undefined) next.halt_reason = state.halt_reason;
  if (state.task_status !== undefined) next.task_status = state.task_status;
  return next;
}

function routeFrom(
  def: FlowDefinition,
  state: FlowState,
  now: number,
  fromNode: string,
  outcome: string,
): RouteResult {
  const node = def.nodes[fromNode];
  if (!node) return { ok: false, halt: `unknown_node:${fromNode}` };

  const ctx: ConditionContext = {
    outcome,
    visits: state.visits,
    executions: state.executions,
    vars: state.vars,
    elapsed_secs: Math.max(0, now - state.started_at),
    self: fromNode,
  };

  const matches = def.edges.filter(
    (e) => e.from === fromNode && (e.when === undefined || evaluateCondition(e.when, ctx)),
  );
  if (matches.length === 0) return { ok: false, halt: `no_matching_edge:${fromNode}:${outcome}` };

  const chosen = node.routing === "all" ? matches : matches.slice(0, 1);
  return { ok: true, targets: chosen.map((e) => ({ to: e.to, from: fromNode, outcome })) };
}

/**
 * Stop the run. Any node that was going to be spawned in this same step has its
 * spawn action dropped rather than being spawned and immediately cancelled;
 * anything already running gets a cancel so the caller can kill the process.
 */
function haltRun(
  def: FlowDefinition,
  state: FlowState,
  actions: FlowAction[],
  reason: string,
): void {
  for (const node of state.active) {
    const spawnIdx = actions.findIndex(
      (a) => a.kind === "spawn" && a.nodeId === node.nodeId && a.attempt === node.attempt,
    );
    if (spawnIdx !== -1) {
      actions.splice(spawnIdx, 1);
      continue;
    }
    actions.push({ kind: "cancel", nodeId: node.nodeId, attempt: node.attempt, reason });
  }
  state.active = [];
  state.status = "halted";
  state.halt_reason = reason;
  state.task_status = def.limits.halt_task_status;
  actions.push({ kind: "halt", reason, task_status: def.limits.halt_task_status });
}

function cancelActive(
  state: FlowState,
  actions: FlowAction[],
  predicate: (nodeId: string) => boolean,
  reason: string,
): void {
  const keep: ActiveNode[] = [];
  for (const node of state.active) {
    if (!predicate(node.nodeId)) {
      keep.push(node);
      continue;
    }
    const spawnIdx = actions.findIndex(
      (a) => a.kind === "spawn" && a.nodeId === node.nodeId && a.attempt === node.attempt,
    );
    if (spawnIdx !== -1) {
      actions.splice(spawnIdx, 1);
      continue;
    }
    actions.push({ kind: "cancel", nodeId: node.nodeId, attempt: node.attempt, reason });
  }
  state.active = keep;
}

function activate(
  def: FlowDefinition,
  state: FlowState,
  now: number,
  targets: Target[],
  actions: FlowAction[],
): void {
  const queue: Target[] = [...targets];
  let steps = 0;

  while (queue.length > 0) {
    if (++steps > GATE_CHAIN_LIMIT) {
      haltRun(def, state, actions, "gate_chain_limit");
      return;
    }
    const target = queue.shift() as Target;
    const node = def.nodes[target.to];
    if (!node) {
      haltRun(def, state, actions, `unknown_node:${target.to}`);
      return;
    }

    // Join nodes park each arriving branch until the join is satisfied.
    if (node.join) {
      const arrivals = { ...(state.joins[target.to] ?? {}) };
      if (target.from) {
        arrivals[target.from] = {
          outcome: target.outcome,
          gen: state.visits[target.from] ?? 1,
        };
      }
      // An arrival is only live while its source has not been re-entered since.
      // Without this, a branch that loops back past the join leaves an arrival
      // behind that satisfies the join on the next round, cancelling siblings
      // whose work was never read.
      const isLive = (from: string, arrival: JoinArrival): boolean =>
        arrival.gen === (state.visits[from] ?? arrival.gen);
      for (const [from, arrival] of Object.entries(arrivals)) {
        if (!isLive(from, arrival)) delete arrivals[from];
      }
      const satisfied =
        node.join.mode === "any"
          ? Object.keys(arrivals).length > 0
          : node.join.from.every((f) => f in arrivals);
      if (!satisfied) {
        state.joins[target.to] = arrivals;
        continue;
      }
      // Reset arrivals so the join works again on the next loop iteration.
      delete state.joins[target.to];
      if (node.join.mode === "any" && (node.join.cancel_siblings ?? true)) {
        const siblings = new Set(node.join.from);
        cancelActive(state, actions, (id) => siblings.has(id), `join_won:${target.to}`);
      }
    }

    if (node.kind === "terminal") {
      // A terminal ends the whole graph, including branches still in flight.
      cancelActive(state, actions, () => true, `terminal:${target.to}`);
      const taskStatus = node.task_status ?? "done";
      state.status = "completed";
      state.task_status = taskStatus;
      actions.push({ kind: "complete", nodeId: target.to, task_status: taskStatus });
      return;
    }

    // Converging on a non-join node while it is still running would put two
    // copies of it in `active`, and a reporting agent has no way to say which
    // copy it is. A join is the construct for fan-in; refuse the alternative
    // instead of silently cross-writing the two attempts' rows.
    if (state.active.some((a) => a.nodeId === target.to)) {
      haltRun(def, state, actions, `concurrent_reentry:${target.to}`);
      return;
    }

    // Budget rails apply to every executed node, gates included, so no shape of
    // cycle can run unbounded.
    const visits = (state.visits[target.to] ?? 0) + 1;
    if (node.max_visits !== undefined && visits > node.max_visits) {
      haltRun(def, state, actions, `max_visits:${target.to}`);
      return;
    }
    if (state.executions + 1 > def.limits.max_node_executions) {
      haltRun(def, state, actions, "max_node_executions");
      return;
    }
    state.visits[target.to] = visits;
    state.executions += 1;

    // Entry vars are how a loopback clears stale state: re-entering `build`
    // resets the per-branch verdicts its reviewers set last time around.
    if (node.vars) state.vars = { ...state.vars, ...node.vars };

    if (node.kind === "gate") {
      const routed = routeFrom(def, state, now, target.to, "entered");
      if (!routed.ok) {
        haltRun(def, state, actions, routed.halt);
        return;
      }
      queue.push(...routed.targets);
      continue;
    }

    const resetOnRevisit = node.reset_on_revisit ?? def.limits.reset_on_revisit;
    state.active.push({ nodeId: target.to, attempt: visits });
    actions.push({
      kind: "spawn",
      nodeId: target.to,
      attempt: visits,
      resume: !resetOnRevisit && visits > 1,
    });
  }
}

function detectStall(def: FlowDefinition, state: FlowState, actions: FlowAction[]): void {
  if (state.status !== "running" || state.active.length > 0) return;
  const parked = Object.keys(state.joins).length > 0;
  haltRun(def, state, actions, parked ? "join_deadlock" : "stalled");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startFlow(
  def: FlowDefinition,
  opts: { now: number; vars?: Record<string, unknown> | undefined },
): FlowStep {
  const state: FlowState = {
    status: "running",
    active: [],
    visits: {},
    executions: 0,
    vars: { ...(opts.vars ?? {}) },
    joins: {},
    started_at: opts.now,
  };
  const actions: FlowAction[] = [];
  activate(def, state, opts.now, [{ to: def.entry, from: null, outcome: "start" }], actions);
  detectStall(def, state, actions);
  return { state, actions };
}

export function advanceFlow(
  def: FlowDefinition,
  current: FlowState,
  result: NodeResult,
  opts: { now: number },
): FlowStep {
  if (current.status !== "running") return { state: current, actions: [] };

  const idx = current.active.findIndex(
    (a) => a.nodeId === result.nodeId && a.attempt === result.attempt,
  );
  // Not active: a duplicate report, or a node that was cancelled out from under
  // the agent. Either way the graph has already moved on.
  if (idx === -1) return { state: current, actions: [] };

  const state = cloneState(current);
  state.active.splice(idx, 1);
  if (result.vars) state.vars = { ...state.vars, ...result.vars };

  const actions: FlowAction[] = [];

  if (opts.now - state.started_at > def.limits.execution_timeout_secs) {
    haltRun(def, state, actions, "execution_timeout");
    return { state, actions };
  }

  const node = def.nodes[result.nodeId];
  let outcome = result.outcome;
  if (result.error) {
    if (!node?.on_error) {
      haltRun(def, state, actions, `node_error:${result.nodeId}:${result.error}`);
      return { state, actions };
    }
    outcome = node.on_error;
  }
  if (!outcome) {
    haltRun(def, state, actions, `no_outcome:${result.nodeId}`);
    return { state, actions };
  }

  const routed = routeFrom(def, state, opts.now, result.nodeId, outcome);
  if (!routed.ok) {
    haltRun(def, state, actions, routed.halt);
    return { state, actions };
  }

  activate(def, state, opts.now, routed.targets, actions);
  detectStall(def, state, actions);
  return { state, actions };
}

/**
 * Wall-clock rail, for the caller's periodic sweep. A flow whose nodes are all
 * hung would never reach advanceFlow, so the timeout has to be checkable from
 * outside the graph too.
 */
export function checkFlowTimeout(
  def: FlowDefinition,
  current: FlowState,
  now: number,
): FlowStep | null {
  if (current.status !== "running") return null;
  if (now - current.started_at <= def.limits.execution_timeout_secs) return null;
  const state = cloneState(current);
  const actions: FlowAction[] = [];
  haltRun(def, state, actions, "execution_timeout");
  return { state, actions };
}

/** Human-readable one-liner for ledger comments and `orc flow status`. */
export function describeHalt(reason: string): string {
  const [kind, ...rest] = reason.split(":");
  const detail = rest.join(":");
  switch (kind) {
    case "max_visits":
      return `node "${detail}" hit its max_visits cap`;
    case "max_node_executions":
      return "flow hit its max_node_executions budget";
    case "execution_timeout":
      return "flow exceeded its execution_timeout_secs";
    case "no_matching_edge":
      return `no edge matched after ${detail} — nothing to route to`;
    case "node_error":
      return `node failed with no on_error route: ${detail}`;
    case "no_outcome":
      return `node "${detail}" ended without reporting an outcome`;
    case "join_deadlock":
      return "every branch is parked at a join that can no longer be satisfied";
    case "stalled":
      return "no active nodes and nowhere left to go";
    case "gate_chain_limit":
      return "gate nodes routed into each other without reaching real work";
    case "concurrent_reentry":
      return `two branches reached "${detail}" at once — fan-in needs a join node`;
    case "unknown_node":
      return `edge pointed at undefined node "${detail}"`;
    default:
      return reason;
  }
}
