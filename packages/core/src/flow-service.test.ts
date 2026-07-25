import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFlow,
  flowExists,
  getProjectFlowsDir,
  getUserFlowsDir,
  listBrokenFlows,
  listFlows,
  readFlow,
  reloadFlows,
  resolveFlowForTask,
} from "./flow-service.js";
import { BUILTIN_FLOW_NAMES } from "./flows/builtin.js";

// User-dir tests use a distinctive name and clean up after themselves, the same
// way the skill-service tests do. Shadowing a *builtin* name is exercised
// through a throwaway project dir instead: a crashed run must never be able to
// leave a bogus `orc-default` behind in a developer's real ~/.orc, where the
// daemon would pick it up and run it.
const TEST_FLOW = "zz-test-flow-service";

function writeUserFlow(name: string, definition: unknown): void {
  const dir = join(getUserFlowsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow.json"), JSON.stringify(definition, null, 2), "utf-8");
  reloadFlows();
}

function removeUserFlow(name: string): void {
  rmSync(join(getUserFlowsDir(), name), { recursive: true, force: true });
  reloadFlows();
}

const VALID_FLOW = {
  name: TEST_FLOW,
  description: "A flow used by the flow-service tests",
  entry: "work",
  nodes: {
    work: { kind: "agent", skill: "orc-coder", outcomes: ["ok"] },
    done: { kind: "terminal" },
  },
  edges: [{ from: "work", to: "done", when: { outcome: "ok" } }],
};

afterEach(() => {
  removeUserFlow(TEST_FLOW);
});

/** Run `fn` with cwd inside a throwaway dir holding ./.orc/flows/<name>/flow.json. */
function withProjectFlow(name: string, definition: unknown, fn: () => void): void {
  const cwd = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), "orc-flow-project-"));
  try {
    process.chdir(temp);
    mkdirSync(join(getProjectFlowsDir(), name), { recursive: true });
    writeFileSync(
      join(getProjectFlowsDir(), name, "flow.json"),
      JSON.stringify(definition, null, 2),
      "utf-8",
    );
    reloadFlows();
    fn();
  } finally {
    process.chdir(cwd);
    rmSync(temp, { recursive: true, force: true });
    reloadFlows();
  }
}

describe("listFlows", () => {
  test("returns every builtin flow, and no builtin is broken", () => {
    const flows = listFlows();
    for (const name of BUILTIN_FLOW_NAMES) {
      expect(
        flows.some((f) => f.name === name && f.source === "builtin"),
        `${name} should be listed`,
      ).toBe(true);
    }
    // Scoped to builtins: a developer's own ~/.orc/flows may legitimately
    // contain a work-in-progress flow, and that is not this suite's business.
    expect(listBrokenFlows().filter((b) => b.path === "(builtin)")).toEqual([]);
  });

  test("filters by source and by keyword", () => {
    writeUserFlow(TEST_FLOW, VALID_FLOW);
    expect(listFlows({ source: "user" }).map((f) => f.name)).toContain(TEST_FLOW);
    expect(listFlows({ source: "builtin" }).some((f) => f.name === TEST_FLOW)).toBe(false);
    expect(listFlows({ q: "flow-service tests" }).map((f) => f.name)).toEqual([TEST_FLOW]);
  });

  test("reports counts a caller can show without loading the definition", () => {
    const flow = listFlows().find((f) => f.name === "orc-parallel-review");
    expect(flow?.node_count).toBe(9);
    expect(flow?.edge_count).toBe(11);
    expect(flow?.entry).toBe("build");
  });
});

describe("readFlow", () => {
  test("returns the parsed definition with defaults applied", () => {
    const flow = readFlow("orc-default");
    expect(flow?.source).toBe("builtin");
    expect(flow?.path).toBeNull();
    expect(flow?.definition.entry).toBe("build");
    expect(flow?.definition.limits.halt_task_status).toBe("paused");
  });

  test("returns null for an unknown flow", () => {
    expect(readFlow("no-such-flow")).toBeNull();
    expect(flowExists("no-such-flow")).toBe(false);
  });
});

describe("user flows", () => {
  test("a flow file shadows a builtin of the same name", () => {
    expect(readFlow("orc-default")?.source).toBe("builtin");
    withProjectFlow(
      "orc-default",
      { ...VALID_FLOW, name: "orc-default", description: "mine" },
      () => {
        const shadowed = readFlow("orc-default");
        expect(shadowed?.source).toBe("project");
        expect(shadowed?.description).toBe("mine");
        expect(shadowed?.definition.entry).toBe("work");
      },
    );
    // And the builtin is back once the shadowing file is gone.
    expect(readFlow("orc-default")?.source).toBe("builtin");
  });

  test("a project flow shadows a user flow of the same name", () => {
    writeUserFlow(TEST_FLOW, VALID_FLOW);
    expect(readFlow(TEST_FLOW)?.source).toBe("user");
    withProjectFlow(TEST_FLOW, { ...VALID_FLOW, description: "from the repo" }, () => {
      expect(readFlow(TEST_FLOW)?.source).toBe("project");
      expect(readFlow(TEST_FLOW)?.description).toBe("from the repo");
    });
  });

  test("an invalid user flow is reported, not silently loaded", () => {
    writeUserFlow(TEST_FLOW, { name: TEST_FLOW, entry: "ghost", nodes: {}, edges: [] });
    expect(readFlow(TEST_FLOW)).toBeNull();
    const broken = listBrokenFlows().find((b) => b.name === TEST_FLOW);
    expect(broken).toBeTruthy();
    expect(broken?.errors.length).toBeGreaterThan(0);
  });

  test("a flow whose name does not match its directory is rejected", () => {
    writeUserFlow(TEST_FLOW, { ...VALID_FLOW, name: "something-else" });
    expect(readFlow(TEST_FLOW)).toBeNull();
    expect(
      listBrokenFlows()
        .find((b) => b.name === TEST_FLOW)
        ?.errors.join(),
    ).toContain("but the definition is named");
  });

  test("malformed JSON is reported against the file it came from", () => {
    const dir = join(getUserFlowsDir(), TEST_FLOW);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "flow.json"), "{ not json", "utf-8");
    reloadFlows();
    const broken = listBrokenFlows().find((b) => b.name === TEST_FLOW);
    expect(broken?.path).toContain(TEST_FLOW);
  });
});

describe("createFlow", () => {
  test("writes a validated flow to the user directory", () => {
    const flow = createFlow(VALID_FLOW);
    expect(flow.source).toBe("user");
    expect(flow.path).toContain(TEST_FLOW);
    expect(readFlow(TEST_FLOW)?.definition.entry).toBe("work");
  });

  test("refuses to clobber an existing flow unless told to", () => {
    createFlow(VALID_FLOW);
    expect(() => createFlow(VALID_FLOW)).toThrow(/already exists/);
    const updated = createFlow({ ...VALID_FLOW, description: "v2" }, { overwrite: true });
    expect(updated.description).toBe("v2");
  });

  test("refuses an invalid definition with the reasons", () => {
    expect(() => createFlow({ name: TEST_FLOW, entry: "work", nodes: {}, edges: [] })).toThrow(
      /Invalid flow definition/,
    );
    expect(readFlow(TEST_FLOW)).toBeNull();
  });
});

describe("resolveFlowForTask", () => {
  test("an inline override wins over a named flow", () => {
    const resolved = resolveFlowForTask({
      flowOverride: VALID_FLOW,
      flowName: "orc-default",
      defaultFlowName: "orc-default",
    });
    expect("definition" in resolved && resolved.source).toBe("task");
    expect("definition" in resolved && resolved.definition.entry).toBe("work");
  });

  test("a named flow wins over the default", () => {
    const resolved = resolveFlowForTask({
      flowName: "orc-fix-verify",
      defaultFlowName: "orc-default",
    });
    expect("definition" in resolved && resolved.name).toBe("orc-fix-verify");
  });

  test("falls back to the configured default", () => {
    const resolved = resolveFlowForTask({ defaultFlowName: "orc-default" });
    expect("definition" in resolved && resolved.name).toBe("orc-default");
  });

  test("an unknown name and an invalid inline flow both return an error", () => {
    expect(resolveFlowForTask({ flowName: "ghost", defaultFlowName: "orc-default" })).toEqual({
      error: "Flow not found: ghost",
    });
    const bad = resolveFlowForTask({
      flowOverride: { name: "bad", entry: "x", nodes: {}, edges: [] },
      defaultFlowName: "orc-default",
    });
    expect("error" in bad && bad.error).toContain("Invalid inline flow");
  });

  test("null and undefined overrides are ignored rather than treated as a graph", () => {
    for (const flowOverride of [null, undefined]) {
      const resolved = resolveFlowForTask({ flowOverride, defaultFlowName: "orc-default" });
      expect("definition" in resolved && resolved.name).toBe("orc-default");
    }
  });
});

describe("getUserFlowsDir", () => {
  test("points inside ~/.orc", () => {
    expect(getUserFlowsDir()).toContain(".orc");
    expect(getUserFlowsDir()).toContain("flows");
  });
});
