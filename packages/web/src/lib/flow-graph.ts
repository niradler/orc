// Flow graph reading and layout.
//
// The API hands us a flow definition as opaque JSON (`Record<string, unknown>`):
// it is the *frozen* snapshot a run started with, already validated by
// `@orc/core/flow` server-side. The web bundle cannot import that Zod schema
// (@orc/core is a Node package: config, fs, sqlite), so this module narrows the
// shape defensively instead - anything missing or of the wrong type is dropped
// rather than trusted, because a definition frozen by an older orc may not have
// every field this UI knows about.
//
// Layout is hand-rolled rather than pulled from a graph library. Flows are tiny
// (128 nodes max, the shipped ones are 4-8), the shapes that matter are exactly
// the ones a generic force/DAG layout hides - a guarded loopback has to *look*
// like an edge going backwards - and a deterministic pure function is testable
// without a browser. A layout dependency would be more code shipped and less
// control over the one thing the picture has to communicate.

import type { FlowNodeRun, FlowRun } from "@/api/client";

export type FlowNodeKind = "agent" | "gate" | "human" | "terminal";

const NODE_KINDS: FlowNodeKind[] = ["agent", "gate", "human", "terminal"];

export type FlowJoin = { mode: "all" | "any"; from: string[]; cancel_siblings?: boolean };

export type FlowGraphNode = {
  id: string;
  kind: FlowNodeKind;
  description?: string;
  skill?: string;
  prompt?: string;
  backend?: string;
  model?: string;
  role?: string;
  outcomes?: string[];
  routing?: "first" | "all";
  on_error?: string;
  join?: FlowJoin;
  max_visits?: number;
  timeout_secs?: number;
  reset_on_revisit?: boolean;
  task_status?: string;
  vars?: Record<string, unknown>;
};

export type FlowGraphEdge = {
  from: string;
  to: string;
  label?: string;
  when?: Record<string, unknown>;
};

export type FlowLimits = {
  max_node_executions?: number;
  execution_timeout_secs?: number;
  max_parallel?: number;
  reset_on_revisit?: boolean;
  halt_task_status?: string;
};

export type FlowGraphDefinition = {
  name: string;
  description: string;
  version: number;
  entry: string;
  limits: FlowLimits;
  /** Definition order, which is also the order the API/CLI print them in. */
  nodes: FlowGraphNode[];
  nodeById: Record<string, FlowGraphNode>;
  /** Edge order is load-bearing: the first matching edge wins at runtime. */
  edges: FlowGraphEdge[];
  raw: Record<string, unknown>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

function routing(v: unknown): "first" | "all" | undefined {
  return v === "all" ? "all" : v === "first" ? "first" : undefined;
}

function join(v: unknown): FlowJoin | undefined {
  if (!isRecord(v)) return undefined;
  const from = strArray(v.from);
  const mode = v.mode === "any" ? "any" : v.mode === "all" ? "all" : undefined;
  if (!from || !mode) return undefined;
  return {
    mode,
    from,
    ...(typeof v.cancel_siblings === "boolean" ? { cancel_siblings: v.cancel_siblings } : {}),
  };
}

function definedOnly<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function toNode(id: string, raw: unknown): FlowGraphNode | null {
  if (!isRecord(raw)) return null;
  const kind = NODE_KINDS.find((k) => k === raw.kind);
  if (!kind) return null;
  return definedOnly({
    id,
    kind,
    description: str(raw.description),
    skill: str(raw.skill),
    prompt: str(raw.prompt),
    backend: str(raw.backend),
    model: str(raw.model),
    role: str(raw.role),
    outcomes: strArray(raw.outcomes),
    routing: routing(raw.routing),
    on_error: str(raw.on_error),
    join: join(raw.join),
    max_visits: num(raw.max_visits),
    timeout_secs: num(raw.timeout_secs),
    reset_on_revisit: typeof raw.reset_on_revisit === "boolean" ? raw.reset_on_revisit : undefined,
    task_status: str(raw.task_status),
    vars: isRecord(raw.vars) ? raw.vars : undefined,
  });
}

/** Narrow an API-supplied definition. Returns null if it is not a flow at all. */
export function toFlowDefinition(raw: unknown): FlowGraphDefinition | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  const entry = str(raw.entry);
  if (!name || !entry || !isRecord(raw.nodes)) return null;

  const nodes: FlowGraphNode[] = [];
  for (const [id, value] of Object.entries(raw.nodes)) {
    const node = toNode(id, value);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return null;

  const nodeById: Record<string, FlowGraphNode> = {};
  for (const node of nodes) nodeById[node.id] = node;

  const edges: FlowGraphEdge[] = [];
  if (Array.isArray(raw.edges)) {
    for (const value of raw.edges) {
      if (!isRecord(value)) continue;
      const from = str(value.from);
      const to = str(value.to);
      // Edges pointing at nodes we could not read would draw into nowhere.
      if (!from || !to || !nodeById[from] || !nodeById[to]) continue;
      edges.push(
        definedOnly({
          from,
          to,
          label: str(value.label),
          when: isRecord(value.when) ? value.when : undefined,
        }),
      );
    }
  }

  const rawLimits = isRecord(raw.limits) ? raw.limits : {};
  const limits: FlowLimits = definedOnly({
    max_node_executions: num(rawLimits.max_node_executions),
    execution_timeout_secs: num(rawLimits.execution_timeout_secs),
    max_parallel: num(rawLimits.max_parallel),
    reset_on_revisit:
      typeof rawLimits.reset_on_revisit === "boolean" ? rawLimits.reset_on_revisit : undefined,
    halt_task_status: str(rawLimits.halt_task_status),
  });

  return {
    name,
    description: typeof raw.description === "string" ? raw.description : "",
    version: num(raw.version) ?? 1,
    entry,
    limits,
    nodes,
    nodeById,
    edges,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

function collectOutcomes(when: Record<string, unknown>, into: Set<string>): void {
  if ("outcome" in when) {
    const outcome = when.outcome;
    if (Array.isArray(outcome)) {
      for (const o of outcome) if (typeof o === "string") into.add(o);
    } else if (typeof outcome === "string") {
      into.add(outcome);
    }
    return;
  }
  for (const key of ["all", "any"] as const) {
    const branch = when[key];
    if (Array.isArray(branch)) {
      for (const c of branch) if (isRecord(c)) collectOutcomes(c, into);
      return;
    }
  }
  if (isRecord(when.not)) collectOutcomes(when.not, into);
}

/**
 * Outcomes the graph can route from a node - a mirror of `declaredOutcomes()` in
 * @orc/core/flow, which is what the API validates a resume against. Deriving it
 * from the definition rather than hardcoding a list is the point: the offered
 * verdicts are the ones this node's own edges can act on.
 *
 * An empty result is meaningful, not a failure: a node whose only outgoing edge
 * is a catch-all has no derivable list, and the server accepts any outcome for it.
 */
export function routableOutcomes(def: FlowGraphDefinition, nodeId: string): string[] {
  const node = def.nodeById[nodeId];
  if (!node) return [];
  if (node.outcomes && node.outcomes.length > 0) return [...node.outcomes];
  const found = new Set<string>();
  for (const edge of def.edges) {
    if (edge.from !== nodeId || !edge.when) continue;
    collectOutcomes(edge.when, found);
  }
  if (node.on_error) found.delete(node.on_error);
  return [...found];
}

// ---------------------------------------------------------------------------
// Conditions, as prose
// ---------------------------------------------------------------------------

const COMPARATORS: Array<[string, string]> = [
  ["eq", "="],
  ["ne", "≠"],
  ["lt", "<"],
  ["lte", "≤"],
  ["gt", ">"],
  ["gte", "≥"],
];

function operand(v: unknown): string {
  if (isRecord(v) && typeof v.var === "string") return v.var;
  return JSON.stringify(v) ?? String(v);
}

function comparators(when: Record<string, unknown>, subject: string): string {
  const parts: string[] = [];
  for (const [key, symbol] of COMPARATORS) {
    if (when[key] !== undefined) parts.push(`${subject} ${symbol} ${operand(when[key])}`);
  }
  if (when.exists !== undefined) parts.push(when.exists ? `${subject} set` : `${subject} unset`);
  if (typeof when.contains === "string") parts.push(`${subject} contains "${when.contains}"`);
  return parts.length > 0 ? parts.join(" and ") : subject;
}

/** Short human rendering of an edge condition, for labels and the edge list. */
export function describeCondition(when: Record<string, unknown> | undefined): string {
  if (!when) return "always";
  if (when.always === true) return "always";
  if ("outcome" in when) {
    const outcome = when.outcome;
    const list = Array.isArray(outcome) ? outcome.join(" | ") : String(outcome);
    return `outcome ${list}`;
  }
  if (isRecord(when.visits)) {
    const node = typeof when.visits.node === "string" ? when.visits.node : "self";
    return comparators(when.visits, `${node} visits`);
  }
  if (isRecord(when.executions)) return comparators(when.executions, "executions");
  if (isRecord(when.elapsed_secs)) return comparators(when.elapsed_secs, "elapsed secs");
  if (typeof when.var === "string") return comparators(when, when.var);
  if (Array.isArray(when.all)) {
    return when.all
      .map((c) => describeCondition(isRecord(c) ? c : undefined))
      .join(" and ")
      .trim();
  }
  if (Array.isArray(when.any)) {
    return when.any.map((c) => describeCondition(isRecord(c) ? c : undefined)).join(" or ");
  }
  if (isRecord(when.not)) return `not (${describeCondition(when.not)})`;
  return "condition";
}

export function edgeLabel(edge: FlowGraphEdge): string {
  return edge.label ?? describeCondition(edge.when);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const NODE_W = 168;
export const NODE_H = 56;
const H_GAP = 84;
const V_GAP = 26;
const PAD_X = 16;
const PAD_TOP = 16;
/** Room under the graph for loopback edges to travel right-to-left. */
const BACK_LANE = 42;
/** Room above the graph for self-loops. */
const SELF_LANE = 38;

export type LaidOutNode = FlowGraphNode & {
  layer: number;
  row: number;
  x: number;
  y: number;
};

export type LaidOutEdge = FlowGraphEdge & {
  /** `back` is a loopback (it returns to an earlier node); `self` is a retry loop. */
  kind: "forward" | "back" | "self";
  text: string;
  path: string;
  labelX: number;
  labelY: number;
  /** Index in definition order - edges are evaluated in it, so it is worth showing. */
  index: number;
};

export type FlowGraphLayout = {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
};

type Adjacency = Map<string, FlowGraphEdge[]>;

function outgoing(def: FlowGraphDefinition): Adjacency {
  const map: Adjacency = new Map();
  for (const edge of def.edges) {
    const list = map.get(edge.from);
    if (list) list.push(edge);
    else map.set(edge.from, [edge]);
  }
  return map;
}

/**
 * Classify edges by walking the graph depth-first from the entry: an edge into a
 * node still on the stack is a loopback. Removing exactly those leaves a DAG,
 * which is what makes the layering below terminate.
 */
function classifyEdges(
  def: FlowGraphDefinition,
  adjacency: Adjacency,
): { kinds: Map<FlowGraphEdge, "forward" | "back" | "self">; discovery: Map<string, number> } {
  const kinds = new Map<FlowGraphEdge, "forward" | "back" | "self">();
  const discovery = new Map<string, number>();
  const onStack = new Set<string>();
  let counter = 0;

  const roots = [def.entry, ...def.nodes.map((n) => n.id)];
  for (const root of roots) {
    if (!def.nodeById[root] || discovery.has(root)) continue;

    // Explicit stack: a definition may nest 128 deep and recursion here buys nothing.
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    discovery.set(root, counter++);
    onStack.add(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = adjacency.get(frame.id) ?? [];
      if (frame.next >= edges.length) {
        onStack.delete(frame.id);
        stack.pop();
        continue;
      }
      const edge = edges[frame.next++];
      if (edge.to === edge.from) {
        kinds.set(edge, "self");
        continue;
      }
      if (onStack.has(edge.to)) {
        kinds.set(edge, "back");
        continue;
      }
      kinds.set(edge, "forward");
      if (!discovery.has(edge.to)) {
        discovery.set(edge.to, counter++);
        onStack.add(edge.to);
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }

  // Unreachable nodes are rejected by server-side validation, but a frozen
  // definition from an older orc might still contain one: give it an order.
  for (const node of def.nodes) {
    if (!discovery.has(node.id)) discovery.set(node.id, counter++);
  }
  for (const edge of def.edges) {
    if (!kinds.has(edge)) kinds.set(edge, edge.from === edge.to ? "self" : "forward");
  }
  return { kinds, discovery };
}

function assignLayers(
  def: FlowGraphDefinition,
  kinds: Map<FlowGraphEdge, "forward" | "back" | "self">,
): Map<string, number> {
  const forward = def.edges.filter((e) => kinds.get(e) === "forward");
  const indegree = new Map<string, number>();
  for (const node of def.nodes) indegree.set(node.id, 0);
  for (const edge of forward) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const node of def.nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      layer.set(node.id, 0);
      queue.push(node.id);
    }
  }

  const bySource = outgoing({ ...def, edges: forward });
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const edge of bySource.get(id) ?? []) {
      const candidate = (layer.get(id) ?? 0) + 1;
      layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, candidate));
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }

  // Defensive: a node left unlayered would collapse onto layer 0 and overlap.
  let max = 0;
  for (const value of layer.values()) max = Math.max(max, value);
  for (const node of def.nodes) {
    if (!layer.has(node.id)) layer.set(node.id, ++max);
  }
  return layer;
}

function bezier(sx: number, sy: number, tx: number, ty: number): string {
  const dx = Math.max(28, Math.abs(tx - sx) / 2);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
}

/** Deterministic left-to-right layered layout. Loopbacks travel under the graph. */
export function layoutFlowGraph(def: FlowGraphDefinition): FlowGraphLayout {
  const adjacency = outgoing(def);
  const { kinds, discovery } = classifyEdges(def, adjacency);
  const layers = assignLayers(def, kinds);

  const byLayer = new Map<number, string[]>();
  for (const node of [...def.nodes].sort(
    (a, b) => (discovery.get(a.id) ?? 0) - (discovery.get(b.id) ?? 0),
  )) {
    const l = layers.get(node.id) ?? 0;
    const list = byLayer.get(l);
    if (list) list.push(node.id);
    else byLayer.set(l, [node.id]);
  }

  let tallest = 1;
  for (const list of byLayer.values()) tallest = Math.max(tallest, list.length);
  const hasSelfLoop = def.edges.some((e) => kinds.get(e) === "self");
  const hasBackEdge = def.edges.some((e) => kinds.get(e) === "back");
  const topPad = PAD_TOP + (hasSelfLoop ? SELF_LANE : 0);

  const placed = new Map<string, LaidOutNode>();
  const nodes: LaidOutNode[] = [];
  for (const [layer, ids] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    // Centre short layers against the tallest one so edges stay roughly straight.
    const offset = ((tallest - ids.length) * (NODE_H + V_GAP)) / 2;
    ids.forEach((id, row) => {
      const node = def.nodeById[id];
      if (!node) return;
      const laid: LaidOutNode = {
        ...node,
        layer,
        row,
        x: PAD_X + layer * (NODE_W + H_GAP),
        y: topPad + offset + row * (NODE_H + V_GAP),
      };
      placed.set(id, laid);
      nodes.push(laid);
    });
  }

  const layerCount = byLayer.size;
  const width = PAD_X * 2 + layerCount * NODE_W + Math.max(0, layerCount - 1) * H_GAP;
  const bodyHeight = topPad + tallest * NODE_H + Math.max(0, tallest - 1) * V_GAP;
  const height = bodyHeight + (hasBackEdge ? BACK_LANE : 0) + PAD_TOP;
  const backLaneY = bodyHeight + BACK_LANE * 0.6;

  const edges: LaidOutEdge[] = def.edges.map((edge, index) => {
    const kind = kinds.get(edge) ?? "forward";
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    const text = edgeLabel(edge);
    if (!from || !to) {
      return { ...edge, kind, text, index, path: "", labelX: 0, labelY: 0 };
    }

    if (kind === "self") {
      const cx = from.x + NODE_W / 2;
      const path =
        `M ${cx - 26} ${from.y} C ${cx - 30} ${from.y - SELF_LANE}, ` +
        `${cx + 30} ${from.y - SELF_LANE}, ${cx + 26} ${from.y}`;
      return { ...edge, kind, text, index, path, labelX: cx, labelY: from.y - SELF_LANE + 4 };
    }

    if (kind === "back") {
      const sx = from.x + NODE_W / 2;
      const sy = from.y + NODE_H;
      const tx = to.x + NODE_W / 2;
      const ty = to.y + NODE_H;
      const path = `M ${sx} ${sy} C ${sx} ${backLaneY}, ${tx} ${backLaneY}, ${tx} ${ty}`;
      return {
        ...edge,
        kind,
        text,
        index,
        path,
        labelX: (sx + tx) / 2,
        labelY: backLaneY - 4,
      };
    }

    const sx = from.x + NODE_W;
    const sy = from.y + NODE_H / 2;
    const tx = to.x;
    const ty = to.y + NODE_H / 2;
    return {
      ...edge,
      kind,
      text,
      index,
      path: bezier(sx, sy, tx, ty),
      labelX: (sx + tx) / 2,
      labelY: (sy + ty) / 2 - 6,
    };
  });

  return { nodes, edges, width, height };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export type NodeLedgerState = {
  /** Status of the most recent row for this node. */
  status: string;
  outcome: string | null;
  /** Graph visits, from the run's own counter (falls back to distinct attempts). */
  visits: number;
  /** Rows for this node, ledger order. */
  runs: FlowNodeRun[];
  latest: FlowNodeRun;
  active: boolean;
};

const LIVE_STATUSES = ["pending", "running", "awaiting_human"];

export function isLive(status: string): boolean {
  return LIVE_STATUSES.includes(status);
}

/** Per-node view of the ledger: what the graph picture is coloured from. */
export function nodeLedgerStates(run: FlowRun): Record<string, NodeLedgerState> {
  const states: Record<string, NodeLedgerState> = {};
  for (const nodeRun of run.nodes) {
    const existing = states[nodeRun.node_id];
    if (existing) {
      existing.runs.push(nodeRun);
      existing.latest = nodeRun;
      existing.status = nodeRun.status;
      existing.outcome = nodeRun.outcome;
    } else {
      states[nodeRun.node_id] = {
        status: nodeRun.status,
        outcome: nodeRun.outcome,
        visits: 0,
        runs: [nodeRun],
        latest: nodeRun,
        active: false,
      };
    }
  }
  for (const [nodeId, state] of Object.entries(states)) {
    const attempts = new Set(state.runs.map((r) => r.attempt));
    state.visits = run.visits[nodeId] ?? attempts.size;
    state.active =
      run.active.some((a) => a.nodeId === nodeId) || state.runs.some((r) => isLive(r.status));
  }
  return states;
}

/**
 * The node run a resume would answer. The API picks the oldest `awaiting_human`
 * row, and the ledger arrives in creation order, so the first match is that row.
 */
export function awaitingHumanRun(run: FlowRun): FlowNodeRun | null {
  return run.nodes.find((n) => n.status === "awaiting_human") ?? null;
}

export function formatDuration(startedAt: number | null, endedAt: number | null): string {
  if (startedAt === null) return "—";
  const end = endedAt ?? Math.floor(Date.now() / 1000);
  const secs = Math.max(0, end - startedAt);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function formatUnixTime(secs: number | null): string {
  if (secs === null) return "—";
  return new Date(secs * 1000).toLocaleString();
}
