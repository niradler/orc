// ---------------------------------------------------------------------------
// Built-in flows.
//
// These are compiled in rather than read from `flows/*.json` on disk on
// purpose: the published `orc-ai` package ships only `dist/index.js`, so a
// filesystem-only default flow would leave every task in an npm install with
// nothing to run. User flows in ~/.orc/flows (or ./.orc/flows) shadow these by
// name, which is how you customise `orc-default` without patching orc.
//
// Run vars available to every flow, injected by the runner at start:
//   task_id, task_title, project, skill_name,
//   required_review (bool), max_review_rounds (number)
// ---------------------------------------------------------------------------

/** Raw, unparsed definitions — validated through parseFlowDefinition on load. */
export const BUILTIN_FLOW_SOURCES: Record<string, unknown> = {
  "orc-default": {
    name: "orc-default",
    description:
      "Build then review, looping back to build while the task's max_review_rounds budget allows. The default flow — reproduces orc's original worker/reviewer pipeline.",
    entry: "build",
    limits: { max_node_executions: 16, execution_timeout_secs: 14_400 },
    nodes: {
      build: {
        kind: "agent",
        description: "Do the work using the task's assigned skill",
        skill: "$task.skill_name",
        backend: "$task.agent_backend",
        model: "$task.agent_model",
        role: "worker",
        task_status: "doing",
        // Resume the worker's own session on a rework round, so it gets just the
        // reviewer's feedback instead of the whole task again. This is what the
        // pre-flow loop did, and it is why orc-default is behaviour-preserving.
        reset_on_revisit: false,
        outcomes: ["submitted", "blocked"],
        on_error: "blocked",
        prompt:
          "Complete the task. When the work is done and ready for review, report the outcome `submitted`. " +
          "If you cannot proceed without a human decision, report `blocked` and say precisely what you need.",
      },
      review_gate: {
        kind: "gate",
        description: "Skip review entirely when the task opted out of it",
      },
      review: {
        kind: "agent",
        description: "Independent review of the submitted work",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        task_status: "review",
        outcomes: ["approved", "changes_requested"],
        on_error: "review_failed",
      },
      done: { kind: "terminal", task_status: "done" },
      blocked_out: { kind: "terminal", task_status: "blocked" },
      escalated: {
        kind: "terminal",
        description: "Out of review rounds — hand back to a human",
        task_status: "paused",
      },
    },
    edges: [
      { from: "build", to: "review_gate", when: { outcome: "submitted" }, label: "submitted" },
      { from: "build", to: "blocked_out", when: { outcome: "blocked" }, label: "blocked" },
      {
        from: "review_gate",
        to: "review",
        when: { var: "required_review", eq: true },
        label: "review required",
      },
      { from: "review_gate", to: "done", when: { always: true }, label: "review not required" },
      { from: "review", to: "done", when: { outcome: "approved" }, label: "approved" },
      {
        from: "review",
        to: "build",
        when: {
          all: [
            { outcome: "changes_requested" },
            { visits: { node: "build", lt: { var: "max_review_rounds" } } },
          ],
        },
        label: "changes requested, budget left",
      },
      { from: "review", to: "escalated", when: { always: true }, label: "out of rounds / error" },
    ],
  },

  "orc-review-only": {
    name: "orc-review-only",
    description:
      "Review an already-submitted task and nothing else. Used when a human moves a task straight to review.",
    entry: "review",
    limits: { max_node_executions: 4, execution_timeout_secs: 3_600 },
    nodes: {
      review: {
        kind: "agent",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        task_status: "review",
        outcomes: ["approved", "changes_requested"],
        on_error: "review_failed",
      },
      done: { kind: "terminal", task_status: "done" },
      rejected: {
        kind: "terminal",
        description: "Back to the queue — the next flow run picks the work up again",
        task_status: "changes_requested",
      },
      escalated: { kind: "terminal", task_status: "paused" },
    },
    edges: [
      { from: "review", to: "done", when: { outcome: "approved" }, label: "approved" },
      {
        from: "review",
        to: "rejected",
        when: { outcome: "changes_requested" },
        label: "changes requested",
      },
      { from: "review", to: "escalated", when: { always: true }, label: "review error" },
    ],
  },

  "orc-plan-build-verify": {
    name: "orc-plan-build-verify",
    description:
      "Plan, implement, then verify against acceptance criteria, looping build↔verify until it passes. Spec-driven: the planner writes the criteria the verifier judges against.",
    entry: "plan",
    limits: { max_node_executions: 20, execution_timeout_secs: 21_600 },
    nodes: {
      plan: {
        kind: "agent",
        description: "Turn the task into acceptance criteria and an implementation plan",
        skill: "orc-planner",
        backend: "$task.agent_backend",
        role: "worker",
        task_status: "doing",
        outcomes: ["ready"],
        on_error: "plan_failed",
        max_visits: 2,
        prompt:
          "Do not implement anything. Produce a plan with explicit, checkable acceptance criteria, " +
          "post it as a task comment, then report the outcome `ready`.",
      },
      build: {
        kind: "agent",
        description: "Implement against the plan",
        skill: "orc-coder",
        backend: "$task.agent_backend",
        model: "$task.agent_model",
        role: "worker",
        task_status: "doing",
        outcomes: ["submitted", "blocked"],
        on_error: "blocked",
        prompt:
          "Implement the plan from the task comments. Address any verifier feedback in the ledger first. " +
          "Report `submitted` when done, or `blocked` if you need a human decision.",
      },
      verify: {
        kind: "agent",
        description: "Judge the implementation against the acceptance criteria only",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        task_status: "review",
        outcomes: ["pass", "fail"],
        on_error: "verify_failed",
        prompt:
          "Judge the implementation strictly against the acceptance criteria in the plan. Do not fix anything yourself. " +
          "Report `pass` or `fail`; on `fail`, list each unmet criterion concretely.",
      },
      done: { kind: "terminal", task_status: "done" },
      blocked_out: { kind: "terminal", task_status: "blocked" },
      escalated: { kind: "terminal", task_status: "paused" },
    },
    edges: [
      { from: "plan", to: "build", when: { outcome: "ready" }, label: "plan ready" },
      { from: "plan", to: "escalated", when: { always: true }, label: "planning failed" },
      { from: "build", to: "verify", when: { outcome: "submitted" }, label: "submitted" },
      { from: "build", to: "blocked_out", when: { outcome: "blocked" }, label: "blocked" },
      { from: "verify", to: "done", when: { outcome: "pass" }, label: "pass" },
      {
        from: "verify",
        to: "build",
        when: { all: [{ outcome: "fail" }, { visits: { node: "build", lt: 4 } }] },
        label: "fail, retry",
      },
      { from: "verify", to: "escalated", when: { always: true }, label: "out of attempts" },
    ],
  },

  "orc-fix-verify": {
    name: "orc-fix-verify",
    description:
      "Bug-fix loop: fix, then independently confirm the fix and that a regression test covers it.",
    entry: "fix",
    limits: { max_node_executions: 12, execution_timeout_secs: 10_800 },
    nodes: {
      fix: {
        kind: "agent",
        skill: "orc-bugfix",
        backend: "$task.agent_backend",
        model: "$task.agent_model",
        role: "worker",
        task_status: "doing",
        outcomes: ["submitted", "blocked"],
        on_error: "blocked",
        prompt:
          "Reproduce the bug first, then fix it, then add a regression test that fails without your fix. " +
          "Report `submitted` when all three are done, or `blocked` if you cannot reproduce it.",
      },
      verify: {
        kind: "agent",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        task_status: "review",
        outcomes: ["pass", "fail"],
        on_error: "verify_failed",
        prompt:
          "Confirm the bug is actually fixed and that a regression test would catch it if it came back. " +
          "Run the test suite. Report `pass` or `fail` with specifics.",
      },
      done: { kind: "terminal", task_status: "done" },
      blocked_out: { kind: "terminal", task_status: "blocked" },
      escalated: { kind: "terminal", task_status: "paused" },
    },
    edges: [
      { from: "fix", to: "verify", when: { outcome: "submitted" }, label: "submitted" },
      { from: "fix", to: "blocked_out", when: { outcome: "blocked" }, label: "cannot reproduce" },
      { from: "verify", to: "done", when: { outcome: "pass" }, label: "fixed" },
      {
        from: "verify",
        to: "fix",
        when: { all: [{ outcome: "fail" }, { visits: { node: "fix", lt: 3 } }] },
        label: "not fixed, retry",
      },
      { from: "verify", to: "escalated", when: { always: true }, label: "out of attempts" },
    ],
  },

  "orc-supervisor": {
    name: "orc-supervisor",
    description:
      "Long-horizon executor plus an independent supervisor that re-verifies from clean context each round and steers with a directive. For multi-milestone work where 'done' must mean verified.",
    entry: "execute",
    limits: { max_node_executions: 24, execution_timeout_secs: 43_200 },
    nodes: {
      execute: {
        kind: "agent",
        description: "Executor — keeps its own context and ledger across rounds",
        skill: "orc-coder",
        backend: "$task.agent_backend",
        model: "$task.agent_model",
        role: "worker",
        task_status: "doing",
        // The executor is the one node that keeps its session: its accumulated
        // context of the work in progress is the point of the pattern.
        reset_on_revisit: false,
        outcomes: ["milestone", "complete", "blocked"],
        on_error: "blocked",
        prompt:
          "Work the next milestone only. Keep the task comments updated as your ledger: what is done, what is verified, what is next. " +
          "If a supervisor directive is in the flow vars, treat it as the highest priority. " +
          "Report `milestone` when a milestone is genuinely finished and verified, `complete` when the whole task is, or `blocked` if you need a human.",
      },
      supervise: {
        kind: "agent",
        description: "Supervisor — clean context every round, re-verifies independently",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        task_status: "review",
        // Always a fresh session: a supervisor that inherited the executor's
        // context would inherit its blind spots too.
        reset_on_revisit: true,
        outcomes: ["verified", "continue", "reject"],
        on_error: "supervise_failed",
        prompt:
          "You are auditing from outside the executor's context. Read the ledger and verify the claims yourself — do not take 'done' on trust. " +
          "Report `verified` if the whole task is genuinely complete, `continue` if the milestone holds but work remains, " +
          "or `reject` if a claim does not hold. With `continue` or `reject`, set a `directive` var telling the executor exactly what to do next.",
      },
      done: { kind: "terminal", task_status: "done" },
      blocked_out: { kind: "terminal", task_status: "blocked" },
      escalated: {
        kind: "terminal",
        description: "Supervision budget spent without convergence",
        task_status: "paused",
      },
    },
    edges: [
      {
        from: "execute",
        to: "supervise",
        when: { any: [{ outcome: "milestone" }, { outcome: "complete" }] },
        label: "checkpoint",
      },
      { from: "execute", to: "blocked_out", when: { outcome: "blocked" }, label: "blocked" },
      { from: "supervise", to: "done", when: { outcome: "verified" }, label: "verified" },
      {
        from: "supervise",
        to: "execute",
        when: {
          all: [
            { any: [{ outcome: "continue" }, { outcome: "reject" }] },
            { visits: { node: "execute", lt: 8 } },
          ],
        },
        label: "keep going",
      },
      { from: "supervise", to: "escalated", when: { always: true }, label: "no convergence" },
    ],
  },

  "orc-parallel-review": {
    name: "orc-parallel-review",
    description:
      "Build once, then review three ways concurrently (correctness, security, tests) and join on all three before deciding. Fan-out costs tokens; use it where a single reviewer demonstrably misses things.",
    entry: "build",
    limits: { max_node_executions: 24, execution_timeout_secs: 21_600, max_parallel: 3 },
    nodes: {
      build: {
        kind: "agent",
        skill: "$task.skill_name",
        backend: "$task.agent_backend",
        model: "$task.agent_model",
        role: "worker",
        task_status: "doing",
        outcomes: ["submitted", "blocked"],
        on_error: "blocked",
        // Clear last round's verdicts so a loopback cannot pass on stale ones.
        vars: { correctness_ok: null, security_ok: null, tests_ok: null },
        prompt:
          "Complete the task, addressing every reviewer finding already in the ledger. " +
          "Report `submitted` when ready for review, or `blocked` if you need a human decision.",
      },
      fan_out: {
        kind: "gate",
        description: "Activate every review branch at once",
        routing: "all",
      },
      review_correctness: {
        kind: "agent",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        outcomes: ["reviewed"],
        on_error: "reviewed",
        prompt:
          "Review for correctness only: logic errors, edge cases, error handling, contract violations. " +
          "Ignore security and test coverage — other reviewers own those. " +
          "Report `reviewed` and set the var `correctness_ok` to true if you found nothing blocking, false otherwise.",
      },
      review_security: {
        kind: "agent",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        outcomes: ["reviewed"],
        on_error: "reviewed",
        prompt:
          "Review for security only: injection, authz gaps, secret handling, unsafe deserialisation, path traversal. " +
          "Report `reviewed` and set the var `security_ok` to true if you found nothing blocking, false otherwise.",
      },
      review_tests: {
        kind: "agent",
        skill: "orc-reviewer",
        backend: "$task.agent_backend",
        role: "reviewer",
        outcomes: ["reviewed"],
        on_error: "reviewed",
        prompt:
          "Review test coverage only: does a test actually fail without this change, are the edge cases covered, does the suite pass? " +
          "Report `reviewed` and set the var `tests_ok` to true if coverage is adequate, false otherwise.",
      },
      verdict: {
        kind: "gate",
        description: "Waits for all three reviews, then decides from their vars",
        join: { mode: "all", from: ["review_correctness", "review_security", "review_tests"] },
      },
      done: { kind: "terminal", task_status: "done" },
      blocked_out: { kind: "terminal", task_status: "blocked" },
      escalated: { kind: "terminal", task_status: "paused" },
    },
    edges: [
      { from: "build", to: "fan_out", when: { outcome: "submitted" }, label: "submitted" },
      { from: "build", to: "blocked_out", when: { outcome: "blocked" }, label: "blocked" },
      { from: "fan_out", to: "review_correctness" },
      { from: "fan_out", to: "review_security" },
      { from: "fan_out", to: "review_tests" },
      { from: "review_correctness", to: "verdict", when: { always: true } },
      { from: "review_security", to: "verdict", when: { always: true } },
      { from: "review_tests", to: "verdict", when: { always: true } },
      {
        from: "verdict",
        to: "done",
        when: {
          all: [
            { var: "correctness_ok", eq: true },
            { var: "security_ok", eq: true },
            { var: "tests_ok", eq: true },
          ],
        },
        label: "all clear",
      },
      {
        from: "verdict",
        to: "build",
        when: { visits: { node: "build", lt: { var: "max_review_rounds" } } },
        label: "findings, rework",
      },
      { from: "verdict", to: "escalated", when: { always: true }, label: "out of rounds" },
    ],
  },
};

export const BUILTIN_FLOW_NAMES = Object.keys(BUILTIN_FLOW_SOURCES);

export const DEFAULT_FLOW_NAME = "orc-default";
export const REVIEW_ONLY_FLOW_NAME = "orc-review-only";
