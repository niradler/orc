import type { FlowCondition, FlowNode } from "../flow.js";

// Compiled into published installs. Overrides retain precedence; active runs
// retain their frozen definition. These templates share one execution contract.
const review: FlowNode = {
  kind: "agent",
  description: "Review the artifact and evidence, then reconcile reusable knowledge",
  skill: "orc-reviewer",
  backend: "$task.agent_backend",
  role: "reviewer",
  task_status: "review",
  outcomes: ["approved", "changes_requested", "insufficient_evidence"],
  on_error: "review_failed",
  prompt:
    "Review the actual artifact against acceptance criteria and trace affected callers. Report approved only with sufficient evidence, changes_requested for concrete defects, or insufficient_evidence when required checks cannot be performed. Complete this work unit's knowledge review before reporting. Do not change task status directly.",
};

const rework: FlowCondition = {
  all: [
    { outcome: "changes_requested" },
    { visits: { node: "build", lt: { var: "max_review_rounds" } } },
  ],
};

const developmentNodes: Record<string, FlowNode> = {
  build: {
    kind: "agent",
    description: "Understand, plan as needed, implement and verify the smallest complete change",
    skill: "$task.skill_name",
    backend: "$task.agent_backend",
    model: "$task.agent_model",
    role: "worker",
    task_status: "doing",
    reset_on_revisit: false,
    outcomes: ["submitted", "blocked"],
    on_error: "blocked",
    prompt:
      "Read the task, relevant knowledge and affected callers. Choose the feature, bugfix or refactor playbook that fits. Verify observable behavior and record evidence, limits and the knowledge review before reporting submitted; report blocked when required input or validation is unavailable.",
  },
  review_gate: { kind: "gate", description: "Apply the task's agent-review preference" },
  review,
  done: { kind: "terminal", task_status: "done" },
  blocked_out: { kind: "terminal", task_status: "blocked" },
  escalated: {
    kind: "terminal",
    description: "Missing evidence, failed review or spent budget: human intervention needed",
    task_status: "paused",
  },
};

const deliveryEdges = [
  { from: "build", to: "review_gate", when: { outcome: "submitted" }, label: "submitted" },
  { from: "build", to: "blocked_out", when: { outcome: "blocked" }, label: "blocked" },
];
const feedbackEdges = [
  { from: "review", to: "build", when: rework, label: "changes requested, budget left" },
  {
    from: "review",
    to: "escalated",
    when: { always: true },
    label: "missing evidence / error / spent budget",
  },
];
const developmentLimits = {
  max_node_executions: 16,
  execution_timeout_secs: 14_400,
  max_parallel: 1,
};

/** Raw definitions are validated through parseFlowDefinition on load. */
export const BUILTIN_FLOW_SOURCES: Record<string, unknown> = {
  "orc-default": {
    name: "orc-default",
    version: 2,
    description:
      "Development: understand, plan as needed, implement and verify, then independent review. Relevant memory and wiki guidance at start, rework and delivery.",
    entry: "build",
    limits: developmentLimits,
    nodes: developmentNodes,
    edges: [
      ...deliveryEdges,
      {
        from: "review_gate",
        to: "review",
        when: { var: "required_review", eq: true },
        label: "agent review required",
      },
      { from: "review_gate", to: "done", when: { always: true }, label: "agent review opted out" },
      { from: "review", to: "done", when: { outcome: "approved" }, label: "approved" },
      ...feedbackEdges,
    ],
  },
  "orc-human-review": {
    name: "orc-human-review",
    version: 2,
    description:
      "Development with human sign-off: implement, verify and independently review, then wait for human approval. Feedback returns to implementation within the review budget.",
    entry: "build",
    limits: developmentLimits,
    nodes: {
      ...developmentNodes,
      review_gate: {
        kind: "gate",
        description: "Always require independent review before human sign-off",
      },
      signoff: {
        kind: "human",
        description: "Human approves delivery or requests changes",
        task_status: "review",
        outcomes: ["approved", "changes_requested"],
        prompt:
          "Review the artifact, verification evidence, risks and knowledge summary. Approve to complete, or request changes with feedback. Approval does not merge or deploy.",
      },
    },
    edges: [
      ...deliveryEdges,
      { from: "review_gate", to: "review", when: { always: true }, label: "independent review" },
      { from: "review", to: "signoff", when: { outcome: "approved" }, label: "ready for human" },
      ...feedbackEdges,
      { from: "signoff", to: "done", when: { outcome: "approved" }, label: "human approved" },
      { from: "signoff", to: "build", when: rework, label: "human feedback, budget left" },
      { from: "signoff", to: "escalated", when: { always: true }, label: "spent budget" },
    ],
  },
  "orc-review-only": {
    name: "orc-review-only",
    version: 2,
    description:
      "Review existing work: inspect the artifact, verify acceptance criteria and reconcile relevant knowledge. Approve, request changes or pause when evidence is missing.",
    entry: "review",
    limits: { max_node_executions: 4, execution_timeout_secs: 3_600, max_parallel: 1 },
    nodes: {
      review,
      done: developmentNodes.done,
      rejected: {
        kind: "terminal",
        description: "Return to implementation in a subsequent development run",
        task_status: "changes_requested",
      },
      escalated: developmentNodes.escalated,
    },
    edges: [
      { from: "review", to: "done", when: { outcome: "approved" }, label: "approved" },
      {
        from: "review",
        to: "rejected",
        when: { outcome: "changes_requested" },
        label: "changes requested",
      },
      {
        from: "review",
        to: "escalated",
        when: { always: true },
        label: "missing evidence / error",
      },
    ],
  },
};

export const BUILTIN_FLOW_NAMES = Object.keys(BUILTIN_FLOW_SOURCES);
export const DEFAULT_FLOW_NAME = "orc-default";
export const REVIEW_ONLY_FLOW_NAME = "orc-review-only";
