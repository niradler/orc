import { z } from "zod";
import { TaskStatusSchema } from "./types.js";

// ---------------------------------------------------------------------------
// Conditions
//
// Edge predicates are a declarative tree, never code. A flow definition is
// data loaded from disk (or authored by an agent), so it must not be able to
// execute anything — no eval, no Function, no template engine.
// ---------------------------------------------------------------------------

/**
 * A number, or a reference to a run var holding one. The indirection is what
 * lets a shipped flow express "loop while under the task's own budget"
 * (`lt: { var: "max_review_rounds" }`) instead of baking in a constant.
 */
export const NumericOperandSchema = z.union([
  z.number(),
  z.object({ var: z.string().min(1) }).strict(),
]);
export type NumericOperand = z.infer<typeof NumericOperandSchema>;

const NumericComparatorSchema = z
  .object({
    eq: NumericOperandSchema.optional(),
    ne: NumericOperandSchema.optional(),
    lt: NumericOperandSchema.optional(),
    lte: NumericOperandSchema.optional(),
    gt: NumericOperandSchema.optional(),
    gte: NumericOperandSchema.optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), {
    message: "comparator needs at least one of eq/ne/lt/lte/gt/gte",
  });

export type NumericComparator = z.infer<typeof NumericComparatorSchema>;

export type FlowCondition =
  | { always: true }
  | { outcome: string | string[] }
  | { visits: NumericComparator & { node?: string } }
  | { executions: NumericComparator }
  | { elapsed_secs: NumericComparator }
  | {
      var: string;
      eq?: unknown;
      ne?: unknown;
      lt?: NumericOperand;
      lte?: NumericOperand;
      gt?: NumericOperand;
      gte?: NumericOperand;
      exists?: boolean;
      contains?: string;
    }
  | { all: FlowCondition[] }
  | { any: FlowCondition[] }
  | { not: FlowCondition };

export const FlowConditionSchema: z.ZodType<FlowCondition> = z.lazy(() =>
  z.union([
    z.object({ always: z.literal(true) }),
    z.object({ outcome: z.union([z.string(), z.array(z.string()).min(1)]) }),
    z.object({
      visits: z
        .object({
          node: z.string().optional(),
          eq: NumericOperandSchema.optional(),
          ne: NumericOperandSchema.optional(),
          lt: NumericOperandSchema.optional(),
          lte: NumericOperandSchema.optional(),
          gt: NumericOperandSchema.optional(),
          gte: NumericOperandSchema.optional(),
        })
        .refine(
          (c) =>
            c.eq !== undefined ||
            c.ne !== undefined ||
            c.lt !== undefined ||
            c.lte !== undefined ||
            c.gt !== undefined ||
            c.gte !== undefined,
          { message: "visits needs at least one of eq/ne/lt/lte/gt/gte" },
        ),
    }),
    z.object({ executions: NumericComparatorSchema }),
    z.object({ elapsed_secs: NumericComparatorSchema }),
    z.object({
      var: z.string().min(1),
      eq: z.unknown().optional(),
      ne: z.unknown().optional(),
      lt: NumericOperandSchema.optional(),
      lte: NumericOperandSchema.optional(),
      gt: NumericOperandSchema.optional(),
      gte: NumericOperandSchema.optional(),
      exists: z.boolean().optional(),
      contains: z.string().optional(),
    }),
    z.object({ all: z.array(FlowConditionSchema).min(1) }),
    z.object({ any: z.array(FlowConditionSchema).min(1) }),
    z.object({ not: FlowConditionSchema }),
  ]),
) as z.ZodType<FlowCondition>;

// ---------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------

export const FlowNodeKindSchema = z.enum(["agent", "gate", "human", "terminal"]);
export type FlowNodeKind = z.infer<typeof FlowNodeKindSchema>;

export const FlowJoinSchema = z.object({
  mode: z.enum(["all", "any"]),
  from: z.array(z.string().min(1)).min(1),
  cancel_siblings: z.boolean().optional(),
});
export type FlowJoin = z.infer<typeof FlowJoinSchema>;

export const FlowNodeSchema = z.object({
  kind: FlowNodeKindSchema,
  description: z.string().optional(),

  // agent nodes
  skill: z.string().optional(),
  prompt: z.string().optional(),
  backend: z.string().optional(),
  model: z.string().optional(),
  role: z.enum(["worker", "reviewer"]).optional(),

  // routing
  outcomes: z.array(z.string().min(1)).optional(),
  routing: z.enum(["first", "all"]).optional(),
  on_error: z.string().optional(),
  join: FlowJoinSchema.optional(),

  // limits and side effects
  max_visits: z.number().int().min(1).optional(),
  timeout_secs: z.number().int().min(1).optional(),
  reset_on_revisit: z.boolean().optional(),
  task_status: TaskStatusSchema.optional(),
  vars: z.record(z.string(), z.unknown()).optional(),
});
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const FlowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: FlowConditionSchema.optional(),
  label: z.string().optional(),
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

export const FlowLimitsSchema = z.object({
  max_node_executions: z.number().int().min(1).default(24),
  execution_timeout_secs: z.number().int().min(1).default(14_400),
  max_parallel: z.number().int().min(1).default(4),
  reset_on_revisit: z.boolean().default(true),
  halt_task_status: TaskStatusSchema.default("paused"),
});
export type FlowLimits = z.infer<typeof FlowLimitsSchema>;

export const DEFAULT_FLOW_LIMITS: FlowLimits = {
  max_node_executions: 24,
  execution_timeout_secs: 14_400,
  max_parallel: 4,
  reset_on_revisit: true,
  halt_task_status: "paused",
};

export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const FlowDefinitionSchema = z.object({
  name: z.string().min(1).max(64).regex(FLOW_NAME_RE, {
    message: "flow name must be lowercase alphanumeric with - or _",
  }),
  description: z.string().default(""),
  version: z.number().int().min(1).default(1),
  entry: z.string().min(1),
  limits: FlowLimitsSchema.default(DEFAULT_FLOW_LIMITS),
  nodes: z.record(z.string().min(1), FlowNodeSchema),
  edges: z.array(FlowEdgeSchema).default([]),
});
export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Graph validation
//
// Zod checks field shapes; these checks catch the graph-level mistakes that
// would otherwise only surface mid-run as a halt: a typo'd edge target, a
// terminal that loops, a node nothing can reach, a flow with no way to finish.
// ---------------------------------------------------------------------------

export type FlowValidationIssue = { path: string; message: string };

export function validateFlowGraph(def: FlowDefinition): FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  const nodeIds = Object.keys(def.nodes);

  if (nodeIds.length === 0) {
    issues.push({ path: "nodes", message: "flow has no nodes" });
    return issues;
  }
  if (!def.nodes[def.entry]) {
    issues.push({ path: "entry", message: `entry node "${def.entry}" is not defined` });
  }

  const entryNode = def.nodes[def.entry];
  if (entryNode?.join) {
    issues.push({ path: "entry", message: `entry node "${def.entry}" cannot be a join node` });
  }

  const outgoing = new Map<string, FlowEdge[]>();
  const incoming = new Map<string, FlowEdge[]>();
  for (const [i, edge] of def.edges.entries()) {
    if (!def.nodes[edge.from]) {
      issues.push({ path: `edges[${i}].from`, message: `unknown node "${edge.from}"` });
    }
    if (!def.nodes[edge.to]) {
      issues.push({ path: `edges[${i}].to`, message: `unknown node "${edge.to}"` });
    }
    const outs = outgoing.get(edge.from);
    if (outs) outs.push(edge);
    else outgoing.set(edge.from, [edge]);
    const ins = incoming.get(edge.to);
    if (ins) ins.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  for (const [id, node] of Object.entries(def.nodes)) {
    const outs = outgoing.get(id) ?? [];

    if (node.kind === "terminal") {
      if (outs.length > 0) {
        issues.push({ path: `nodes.${id}`, message: "terminal nodes cannot have outgoing edges" });
      }
    } else if (outs.length === 0) {
      issues.push({
        path: `nodes.${id}`,
        message: `${node.kind} node has no outgoing edges — it can only halt the flow`,
      });
    }

    if (node.kind === "agent" && !node.skill && !node.prompt) {
      issues.push({
        path: `nodes.${id}`,
        message: "agent node needs a skill or a prompt to give the agent something to do",
      });
    }
    if (node.kind !== "agent" && (node.skill || node.backend || node.model)) {
      issues.push({
        path: `nodes.${id}`,
        message: `skill/backend/model only apply to agent nodes, not ${node.kind}`,
      });
    }

    // An unconditional edge shadows everything after it — first match wins, so
    // later edges are dead code the author almost certainly did not intend.
    if (node.routing !== "all") {
      const catchAllIdx = outs.findIndex((e) => e.when === undefined || "always" in e.when);
      if (catchAllIdx !== -1 && catchAllIdx < outs.length - 1) {
        issues.push({
          path: `nodes.${id}`,
          message: `unconditional edge to "${outs[catchAllIdx]?.to}" shadows ${outs.length - catchAllIdx - 1} later edge(s)`,
        });
      }
    }

    if (node.join) {
      for (const [j, from] of node.join.from.entries()) {
        if (!def.nodes[from]) {
          issues.push({ path: `nodes.${id}.join.from[${j}]`, message: `unknown node "${from}"` });
          continue;
        }
        const feeds = (incoming.get(id) ?? []).some((e) => e.from === from);
        if (!feeds) {
          issues.push({
            path: `nodes.${id}.join.from[${j}]`,
            message: `"${from}" has no edge into "${id}", so its arrival can never be recorded`,
          });
        }
      }
    }

    // A declared outcome the graph cannot route is a dead end at runtime —
    // unless the node has a catch-all edge, which routes anything.
    const hasCatchAll = outs.some((e) => e.when === undefined || "always" in e.when);
    if (!hasCatchAll) {
      for (const outcome of node.outcomes ?? []) {
        const referenced = outs.some((e) => e.when && conditionMentionsOutcome(e.when, outcome));
        if (!referenced) {
          issues.push({
            path: `nodes.${id}.outcomes`,
            message: `outcome "${outcome}" is declared but no outgoing edge routes on it`,
          });
        }
      }
    }
  }

  // Reachability from entry, and at least one terminal reachable.
  if (def.nodes[def.entry]) {
    const seen = new Set<string>([def.entry]);
    const queue = [def.entry];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const edge of outgoing.get(id) ?? []) {
        if (!seen.has(edge.to) && def.nodes[edge.to]) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const id of nodeIds) {
      if (!seen.has(id)) {
        issues.push({ path: `nodes.${id}`, message: "node is unreachable from entry" });
      }
    }
    const reachableTerminal = [...seen].some((id) => def.nodes[id]?.kind === "terminal");
    if (!reachableTerminal) {
      issues.push({
        path: "nodes",
        message: "no terminal node is reachable from entry — the flow can never complete",
      });
    }
  }

  return issues;
}

function conditionMentionsOutcome(cond: FlowCondition, outcome: string): boolean {
  if ("outcome" in cond) {
    return Array.isArray(cond.outcome) ? cond.outcome.includes(outcome) : cond.outcome === outcome;
  }
  if ("all" in cond) return cond.all.some((c) => conditionMentionsOutcome(c, outcome));
  if ("any" in cond) return cond.any.some((c) => conditionMentionsOutcome(c, outcome));
  if ("not" in cond) return conditionMentionsOutcome(cond.not, outcome);
  return false;
}

export type ParsedFlow = { ok: true; definition: FlowDefinition } | { ok: false; errors: string[] };

export function parseFlowDefinition(raw: unknown): ParsedFlow {
  const parsed = FlowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const issues = validateFlowGraph(parsed.data);
  if (issues.length > 0) {
    return { ok: false, errors: issues.map((i) => `${i.path}: ${i.message}`) };
  }
  return { ok: true, definition: parsed.data };
}

/**
 * Outcomes a node may report, derived from the edges that actually leave it.
 * Node prompts list these so an agent is told exactly which verdicts are legal
 * instead of inventing one the graph cannot route.
 */
export function declaredOutcomes(def: FlowDefinition, nodeId: string): string[] {
  const node = def.nodes[nodeId];
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

function collectOutcomes(cond: FlowCondition, into: Set<string>): void {
  if ("outcome" in cond) {
    if (Array.isArray(cond.outcome)) for (const o of cond.outcome) into.add(o);
    else into.add(cond.outcome);
    return;
  }
  if ("all" in cond) for (const c of cond.all) collectOutcomes(c, into);
  else if ("any" in cond) for (const c of cond.any) collectOutcomes(c, into);
  else if ("not" in cond) collectOutcomes(cond.not, into);
}

// ---------------------------------------------------------------------------
// Task placeholders
//
// Built-in flows have to work for any task, so a node can defer to the task's
// own fields: "skill": "$task.skill_name" is how orc-default keeps honouring
// the per-task skill assignment it replaced.
// ---------------------------------------------------------------------------

export type TaskPlaceholders = {
  skill_name?: string | null | undefined;
  agent_backend?: string | null | undefined;
  agent_model?: string | null | undefined;
};

const PLACEHOLDERS = ["$task.skill_name", "$task.agent_backend", "$task.agent_model"] as const;

export function resolvePlaceholder(
  value: string | undefined,
  task: TaskPlaceholders,
): string | undefined {
  if (!value) return undefined;
  switch (value) {
    case "$task.skill_name":
      return task.skill_name ?? undefined;
    case "$task.agent_backend":
      return task.agent_backend ?? undefined;
    case "$task.agent_model":
      return task.agent_model ?? undefined;
    default:
      return value;
  }
}

export function isPlaceholder(value: string | undefined): boolean {
  return value !== undefined && (PLACEHOLDERS as readonly string[]).includes(value);
}
