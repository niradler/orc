// Unit tests for the pure half of the flow UI: reading a definition, deriving
// routable outcomes, and laying the graph out. No browser needed.
//
// `@orc/core` is a dev-only dependency of @orc/web, imported here so these tests
// run against the *real* shipped flow definitions - a builtin that starts using
// a field the reader drops should fail here rather than render a wrong picture.
// It must never be imported from `src/`: it is a Node package (fs, sqlite) and
// the browser bundle cannot take it.
import { describe, expect, test } from "bun:test";
import { BUILTIN_FLOW_SOURCES } from "@orc/core/flows/builtin";
import {
  awaitingHumanRun,
  describeCondition,
  type FlowGraphDefinition,
  layoutFlowGraph,
  nodeLedgerStates,
  routableOutcomes,
  toFlowDefinition,
} from "../../src/lib/flow-graph";

function def(raw: unknown): FlowGraphDefinition {
  const parsed = toFlowDefinition(raw);
  if (!parsed) throw new Error("definition did not parse");
  return parsed;
}

const LOOP_FLOW = {
  name: "loop",
  entry: "build",
  nodes: {
    build: { kind: "agent", skill: "s", outcomes: ["submitted"] },
    review: { kind: "agent", skill: "r", max_visits: 3 },
    done: { kind: "terminal", task_status: "done" },
    escalated: { kind: "terminal", task_status: "paused" },
  },
  edges: [
    { from: "build", to: "review", when: { outcome: "submitted" } },
    { from: "review", to: "done", when: { outcome: "approved" } },
    {
      from: "review",
      to: "build",
      when: { all: [{ outcome: "changes_requested" }, { visits: { node: "build", lt: 3 } }] },
      label: "rework",
    },
    { from: "review", to: "escalated", when: { always: true } },
  ],
};

describe("toFlowDefinition", () => {
  test("reads a definition and keeps node and edge order", () => {
    const parsed = def(LOOP_FLOW);
    expect(parsed.nodes.map((n) => n.id)).toEqual(["build", "review", "done", "escalated"]);
    expect(parsed.edges).toHaveLength(4);
    expect(parsed.nodeById.review?.max_visits).toBe(3);
  });

  test("rejects things that are not flows", () => {
    expect(toFlowDefinition(null)).toBeNull();
    expect(toFlowDefinition({ name: "x" })).toBeNull();
    expect(toFlowDefinition({ name: "x", entry: "a", nodes: {} })).toBeNull();
  });

  test("drops fields and edges it cannot trust rather than rendering nonsense", () => {
    const parsed = def({
      name: "sloppy",
      entry: "a",
      nodes: {
        a: { kind: "agent", skill: "s", max_visits: "three", routing: "sideways" },
        b: { kind: "terminal" },
        c: { kind: "not-a-kind" },
      },
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "nowhere" },
        { from: "a", to: "c" },
      ],
    });
    expect(parsed.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(parsed.nodeById.a?.max_visits).toBeUndefined();
    expect(parsed.nodeById.a?.routing).toBeUndefined();
    // Edges into unreadable or unknown nodes would draw into empty space.
    expect(parsed.edges).toEqual([{ from: "a", to: "b" }]);
  });

  test("every built-in flow is readable", () => {
    for (const raw of Object.values(BUILTIN_FLOW_SOURCES)) {
      const parsed = toFlowDefinition(raw);
      expect(parsed).not.toBeNull();
      const nodeCount = Object.keys((raw as { nodes: object }).nodes).length;
      expect(parsed?.nodes.length).toBe(nodeCount);
      expect(parsed?.edges.length).toBe((raw as { edges: unknown[] }).edges.length);
    }
  });
});

describe("routableOutcomes", () => {
  test("uses the node's declared outcomes when it has them", () => {
    expect(routableOutcomes(def(LOOP_FLOW), "build")).toEqual(["submitted"]);
  });

  test("derives outcomes from the conditions on the outgoing edges", () => {
    expect(routableOutcomes(def(LOOP_FLOW), "review").sort()).toEqual([
      "approved",
      "changes_requested",
    ]);
  });

  test("is empty when only a catch-all leaves the node - any outcome routes", () => {
    const parsed = def({
      name: "catch-all",
      entry: "gate",
      nodes: { gate: { kind: "human" }, done: { kind: "terminal" } },
      edges: [{ from: "gate", to: "done", when: { always: true } }],
    });
    expect(routableOutcomes(parsed, "gate")).toEqual([]);
  });

  test("excludes the on_error outcome, which the node cannot choose", () => {
    const parsed = def({
      name: "on-error",
      entry: "work",
      nodes: {
        work: { kind: "agent", skill: "s", on_error: "broke" },
        done: { kind: "terminal" },
        blocked: { kind: "terminal" },
      },
      edges: [
        { from: "work", to: "done", when: { outcome: "pass" } },
        { from: "work", to: "blocked", when: { outcome: "broke" } },
      ],
    });
    expect(routableOutcomes(parsed, "work")).toEqual(["pass"]);
  });

  test("mirrors what orc-default's own nodes can report", () => {
    const parsed = def(BUILTIN_FLOW_SOURCES["orc-default"]);
    expect(routableOutcomes(parsed, "build")).toEqual(["submitted", "blocked"]);
    expect(routableOutcomes(parsed, "review").sort()).toEqual(["approved", "changes_requested"]);
  });
});

describe("describeCondition", () => {
  test("renders each condition form as prose", () => {
    expect(describeCondition(undefined)).toBe("always");
    expect(describeCondition({ always: true })).toBe("always");
    expect(describeCondition({ outcome: "fail" })).toBe("outcome fail");
    expect(describeCondition({ outcome: ["fail", "error"] })).toBe("outcome fail | error");
    expect(describeCondition({ visits: { node: "build", lt: 4 } })).toBe("build visits < 4");
    expect(describeCondition({ visits: { lt: { var: "max_review_rounds" } } })).toBe(
      "self visits < max_review_rounds",
    );
    expect(describeCondition({ executions: { gte: 10 } })).toBe("executions ≥ 10");
    expect(describeCondition({ elapsed_secs: { gt: 3600 } })).toBe("elapsed secs > 3600");
    expect(describeCondition({ var: "tests_ok", eq: true })).toBe("tests_ok = true");
    expect(describeCondition({ var: "notes", exists: true })).toBe("notes set");
    expect(describeCondition({ not: { outcome: "pass" } })).toBe("not (outcome pass)");
    expect(
      describeCondition({ all: [{ outcome: "fail" }, { visits: { node: "build", lt: 2 } }] }),
    ).toBe("outcome fail and build visits < 2");
    expect(describeCondition({ any: [{ outcome: "a" }, { outcome: "b" }] })).toBe(
      "outcome a or outcome b",
    );
  });
});

describe("layoutFlowGraph", () => {
  test("layers nodes left to right from the entry", () => {
    const layout = layoutFlowGraph(def(LOOP_FLOW));
    const layer = (id: string) => layout.nodes.find((n) => n.id === id)?.layer;
    expect(layer("build")).toBe(0);
    expect(layer("review")).toBe(1);
    expect(layer("done")).toBe(2);
    expect(layer("escalated")).toBe(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  test("classifies the guarded loopback as a back edge", () => {
    const layout = layoutFlowGraph(def(LOOP_FLOW));
    const kinds = layout.edges.map((e) => `${e.from}->${e.to}:${e.kind}`);
    expect(kinds).toContain("review->build:back");
    expect(kinds).toContain("build->review:forward");
    // A loopback must be drawn, and drawn *under* the boxes it returns across.
    const back = layout.edges.find((e) => e.kind === "back");
    expect(back?.path.length).toBeGreaterThan(0);
    expect(back?.labelY).toBeGreaterThan(Math.max(...layout.nodes.map((n) => n.y)));
  });

  test("labels an edge with its own label, falling back to the condition", () => {
    const layout = layoutFlowGraph(def(LOOP_FLOW));
    expect(layout.edges.find((e) => e.to === "build")?.text).toBe("rework");
    expect(layout.edges.find((e) => e.to === "escalated")?.text).toBe("always");
  });

  test("handles a self-loop without collapsing the layout", () => {
    const layout = layoutFlowGraph(
      def({
        name: "retry",
        entry: "work",
        nodes: { work: { kind: "agent", skill: "s" }, done: { kind: "terminal" } },
        edges: [
          { from: "work", to: "work", when: { outcome: "again" } },
          { from: "work", to: "done", when: { always: true } },
        ],
      }),
    );
    expect(layout.edges.find((e) => e.from === "work" && e.to === "work")?.kind).toBe("self");
    expect(layout.nodes.find((n) => n.id === "work")?.layer).toBe(0);
    expect(layout.nodes.find((n) => n.id === "done")?.layer).toBe(1);
  });

  test("puts fan-out branches in one layer and the join after them", () => {
    const layout = layoutFlowGraph(def(BUILTIN_FLOW_SOURCES["orc-parallel-review"]));
    const layer = (id: string) => layout.nodes.find((n) => n.id === id)?.layer;
    const branches = ["review_correctness", "review_security", "review_tests"];
    const layers = branches.map(layer);
    expect(new Set(layers).size).toBe(1);
    for (const l of layers) expect(layer("verdict")).toBeGreaterThan(l as number);
  });

  test("lays out every built-in flow without overlapping two nodes", () => {
    for (const raw of Object.values(BUILTIN_FLOW_SOURCES)) {
      const layout = layoutFlowGraph(def(raw));
      const seen = new Set<string>();
      for (const node of layout.nodes) {
        const cell = `${node.layer}:${node.row}`;
        expect(seen.has(cell)).toBe(false);
        seen.add(cell);
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
      }
      for (const edge of layout.edges) expect(edge.path).not.toBe("");
    }
  });
});

describe("nodeLedgerStates", () => {
  const run = {
    id: "r1",
    task_id: "t1",
    flow_name: "loop",
    flow_source: "builtin",
    status: "running",
    halt_reason: null,
    halt_description: null,
    active: [{ nodeId: "review", attempt: 2 }],
    visits: { build: 2, review: 2 },
    node_executions: 4,
    vars: {},
    started_at: 1000,
    ended_at: null,
    definition: LOOP_FLOW as unknown as Record<string, unknown>,
    nodes: [
      {
        node_id: "build",
        node_kind: "agent",
        attempt: 1,
        retry: 0,
        status: "succeeded",
        outcome: "submitted",
        summary: "first pass",
        error: null,
        gateway_session_id: "s1",
        started_at: 1000,
        ended_at: 1100,
      },
      {
        node_id: "review",
        node_kind: "agent",
        attempt: 1,
        retry: 0,
        status: "succeeded",
        outcome: "changes_requested",
        summary: "missing tests",
        error: null,
        gateway_session_id: "s2",
        started_at: 1100,
        ended_at: 1200,
      },
      {
        node_id: "build",
        node_kind: "agent",
        attempt: 2,
        retry: 0,
        status: "succeeded",
        outcome: "submitted",
        summary: "tests added",
        error: null,
        gateway_session_id: "s3",
        started_at: 1200,
        ended_at: 1300,
      },
      {
        node_id: "review",
        node_kind: "agent",
        attempt: 2,
        retry: 0,
        status: "running",
        outcome: null,
        summary: null,
        error: null,
        gateway_session_id: "s4",
        started_at: 1300,
        ended_at: null,
      },
    ],
  };

  test("collapses the ledger to the latest state per node, keeping every visit", () => {
    const states = nodeLedgerStates(run);
    expect(states.build?.status).toBe("succeeded");
    expect(states.build?.outcome).toBe("submitted");
    expect(states.build?.runs).toHaveLength(2);
    expect(states.build?.visits).toBe(2);
    expect(states.build?.active).toBe(false);

    expect(states.review?.status).toBe("running");
    expect(states.review?.outcome).toBeNull();
    expect(states.review?.active).toBe(true);
    expect(states.done).toBeUndefined();
  });

  test("falls back to counting attempts when the run has no visit counter", () => {
    const states = nodeLedgerStates({ ...run, visits: {} });
    expect(states.build?.visits).toBe(2);
  });

  test("finds the node run a resume would answer", () => {
    expect(awaitingHumanRun(run)).toBeNull();
    const parked = {
      ...run,
      nodes: [
        ...run.nodes,
        { ...run.nodes[0], node_id: "gate_a", status: "awaiting_human", outcome: null },
        { ...run.nodes[0], node_id: "gate_b", status: "awaiting_human", outcome: null },
      ],
    };
    // Ledger order is creation order, and the API answers the oldest parked node.
    expect(awaitingHumanRun(parked)?.node_id).toBe("gate_a");
  });
});
