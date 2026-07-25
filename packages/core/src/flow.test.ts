import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FLOW_LIMITS,
  declaredOutcomes,
  parseFlowDefinition,
  resolvePlaceholder,
  validateFlowGraph,
} from "./flow.js";
import { BUILTIN_FLOW_SOURCES } from "./flows/builtin.js";

const MINIMAL = {
  name: "minimal",
  entry: "work",
  nodes: {
    work: { kind: "agent", skill: "orc-coder", outcomes: ["ok"] },
    done: { kind: "terminal" },
  },
  edges: [{ from: "work", to: "done", when: { outcome: "ok" } }],
};

function errorsFor(raw: unknown): string[] {
  const parsed = parseFlowDefinition(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe("parseFlowDefinition", () => {
  test("accepts a minimal flow and applies default limits", () => {
    const parsed = parseFlowDefinition(MINIMAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition.limits).toEqual(DEFAULT_FLOW_LIMITS);
    expect(parsed.definition.version).toBe(1);
    expect(parsed.definition.description).toBe("");
  });

  test("rejects names that are not safe directory names", () => {
    expect(errorsFor({ ...MINIMAL, name: "../escape" }).join()).toContain("flow name");
    expect(errorsFor({ ...MINIMAL, name: "Has Spaces" }).join()).toContain("flow name");
  });

  test("rejects an unknown condition shape rather than ignoring it", () => {
    const bad = {
      ...MINIMAL,
      edges: [{ from: "work", to: "done", when: { exec: "rm -rf /" } }],
    };
    expect(errorsFor(bad).length).toBeGreaterThan(0);
  });

  test("rejects a comparator with no operands", () => {
    const bad = {
      ...MINIMAL,
      edges: [{ from: "work", to: "done", when: { visits: { node: "work" } } }],
    };
    expect(errorsFor(bad).length).toBeGreaterThan(0);
  });
});

describe("validateFlowGraph", () => {
  function issues(raw: unknown): string[] {
    const parsed = parseFlowDefinition(raw);
    // Shape must be valid for graph checks to be the thing under test.
    if (!parsed.ok) return parsed.errors;
    return validateFlowGraph(parsed.definition).map((i) => `${i.path}: ${i.message}`);
  }

  test("catches an entry node that does not exist", () => {
    expect(issues({ ...MINIMAL, entry: "nope" }).join()).toContain(
      'entry node "nope" is not defined',
    );
  });

  test("catches an edge pointing at an undefined node", () => {
    const bad = { ...MINIMAL, edges: [{ from: "work", to: "typo", when: { outcome: "ok" } }] };
    expect(issues(bad).join()).toContain('unknown node "typo"');
  });

  test("catches a terminal with outgoing edges", () => {
    const bad = {
      ...MINIMAL,
      edges: [
        { from: "work", to: "done", when: { outcome: "ok" } },
        { from: "done", to: "work", when: { always: true } },
      ],
    };
    expect(issues(bad).join()).toContain("terminal nodes cannot have outgoing edges");
  });

  test("catches a non-terminal with nowhere to go", () => {
    const bad = {
      name: "stuck",
      entry: "work",
      nodes: { work: { kind: "agent", skill: "s" }, done: { kind: "terminal" } },
      edges: [],
    };
    expect(issues(bad).join()).toContain("no outgoing edges");
  });

  test("catches an unreachable node and a flow that can never finish", () => {
    const orphan = {
      ...MINIMAL,
      nodes: { ...MINIMAL.nodes, stray: { kind: "agent", skill: "s" } },
      edges: [
        { from: "work", to: "done", when: { outcome: "ok" } },
        { from: "stray", to: "done", when: { always: true } },
      ],
    };
    expect(issues(orphan).join()).toContain("unreachable from entry");

    const endless = {
      name: "endless",
      entry: "work",
      nodes: { work: { kind: "agent", skill: "s" }, done: { kind: "terminal" } },
      edges: [{ from: "work", to: "work", when: { always: true } }],
    };
    expect(issues(endless).join()).toContain("no terminal node is reachable");
  });

  test("catches an unconditional edge that shadows later ones", () => {
    const shadowed = {
      ...MINIMAL,
      nodes: { ...MINIMAL.nodes, other: { kind: "terminal", task_status: "paused" } },
      edges: [
        { from: "work", to: "done", when: { always: true } },
        { from: "work", to: "other", when: { outcome: "ok" } },
      ],
    };
    expect(issues(shadowed).join()).toContain("shadows 1 later edge");
  });

  test("allows multiple unconditional edges when the node fans out", () => {
    const fanOut = {
      name: "fanout",
      entry: "split",
      nodes: {
        split: { kind: "gate", routing: "all" },
        a: { kind: "agent", skill: "s" },
        b: { kind: "agent", skill: "s" },
        join: { kind: "gate", join: { mode: "all", from: ["a", "b"] } },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "split", to: "a" },
        { from: "split", to: "b" },
        { from: "a", to: "join", when: { always: true } },
        { from: "b", to: "join", when: { always: true } },
        { from: "join", to: "done", when: { always: true } },
      ],
    };
    expect(issues(fanOut)).toEqual([]);
  });

  test("catches a join whose source cannot actually reach it", () => {
    const bad = {
      name: "badjoin",
      entry: "a",
      nodes: {
        a: { kind: "agent", skill: "s" },
        b: { kind: "agent", skill: "s" },
        join: { kind: "gate", join: { mode: "all", from: ["a", "b"] } },
        done: { kind: "terminal" },
      },
      edges: [
        { from: "a", to: "join", when: { always: true } },
        { from: "a", to: "b", when: { outcome: "never" } },
        { from: "b", to: "done", when: { always: true } },
        { from: "join", to: "done", when: { always: true } },
      ],
    };
    expect(issues(bad).join()).toContain('has no edge into "join"');
  });

  test("catches a declared outcome nothing routes on", () => {
    const bad = {
      ...MINIMAL,
      nodes: { ...MINIMAL.nodes, work: { kind: "agent", skill: "s", outcomes: ["ok", "ghost"] } },
    };
    expect(issues(bad).join()).toContain('outcome "ghost" is declared');
  });

  test("rejects agent-only fields on other node kinds", () => {
    const bad = {
      ...MINIMAL,
      nodes: { ...MINIMAL.nodes, done: { kind: "terminal", skill: "orc-coder" } },
    };
    expect(issues(bad).join()).toContain("only apply to agent nodes");
  });

  test("rejects an agent node with nothing to do", () => {
    const bad = { ...MINIMAL, nodes: { ...MINIMAL.nodes, work: { kind: "agent" } } };
    expect(issues(bad).join()).toContain("needs a skill or a prompt");
  });
});

describe("declaredOutcomes", () => {
  test("derives outcomes from the edges leaving a node", () => {
    const parsed = parseFlowDefinition(BUILTIN_FLOW_SOURCES["orc-default"]);
    if (!parsed.ok) throw new Error("orc-default should be valid");
    expect(declaredOutcomes(parsed.definition, "build").sort()).toEqual(["blocked", "submitted"]);
    expect(declaredOutcomes(parsed.definition, "review").sort()).toEqual([
      "approved",
      "changes_requested",
    ]);
  });

  test("returns nothing for a terminal", () => {
    const parsed = parseFlowDefinition(MINIMAL);
    if (!parsed.ok) throw new Error("fixture should be valid");
    expect(declaredOutcomes(parsed.definition, "done")).toEqual([]);
  });
});

describe("resolvePlaceholder", () => {
  const task = { skill_name: "orc-coder", agent_backend: null, agent_model: undefined };

  test("substitutes task fields and passes other values through", () => {
    expect(resolvePlaceholder("$task.skill_name", task)).toBe("orc-coder");
    expect(resolvePlaceholder("$task.agent_backend", task)).toBeUndefined();
    expect(resolvePlaceholder("$task.agent_model", task)).toBeUndefined();
    expect(resolvePlaceholder("orc-reviewer", task)).toBe("orc-reviewer");
    expect(resolvePlaceholder(undefined, task)).toBeUndefined();
  });
});
