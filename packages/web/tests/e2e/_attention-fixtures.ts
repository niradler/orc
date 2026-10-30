import { type HumanRequest, HumanRequestSchema } from "@orc/core/human-requests";

export function attentionRequests(): HumanRequest[] {
  const created = Date.parse("2026-10-30T09:00:00Z");
  const make = (id: string, input: unknown, state = {}) =>
    HumanRequestSchema.parse({
      id,
      input,
      status: "pending",
      version: 3,
      response: null,
      created_at: created,
      expires_at: created + 86400000,
      responded_at: null,
      delivered_at: null,
      ...state,
    });
  const origin = {
    backend: "codex",
    session_id: "fixture-session",
    request_id: "fixture-request",
    session_title: "Release workflow review",
    execution_host: "build-host",
  };
  return [
    make("choice", {
      kind: "question",
      origin,
      prompt: "How should the release be validated?",
      choices: ["Run focused checks", "Run the complete suite"],
      choice_descriptions: {
        "Run focused checks":
          "Validate the affected packages and browser workflows before the review.",
        "Run the complete suite": "Include every local package check and integration workflow.",
      },
    }),
    make("free", {
      kind: "question",
      origin: { ...origin, backend: "claude", session_title: "Investigate a deployment issue" },
      prompt: "Which environment and reproduction steps should I use?",
    }),
    make("approval", {
      kind: "approval",
      origin,
      prompt: "Allow the agent to inspect the current working tree?",
      action: {
        tool: "command",
        cwd: "/workspace/orc",
        host: "build-host",
        input: {
          command: "git status --short && git diff --stat",
          threadId: "fixture-thread",
          item: { id: "fixture-item" },
        },
      },
    }),
    make("multi", {
      kind: "question",
      origin: { ...origin, backend: "claude" },
      prompt: "Which checks should be included?",
      choices: ["TypeScript", "Browser workflows", "API contracts"],
      multi_select: true,
    }),
    make(
      "delivery",
      { kind: "question", origin, prompt: "Keep the local changes for review?" },
      {
        status: "answered",
        response: { kind: "question", answer: "Keep the draft and attach the validation results." },
        responded_at: created + 60000,
        delivery_error: "The agent disconnected before the answer was delivered.",
      },
    ),
    make(
      "unavailable",
      { kind: "question", origin, prompt: "Should I retry the disconnected worker?" },
      { status: "unavailable" },
    ),
  ];
}

export const attentionWaiting = [
  {
    thread_id: "70000000-0000-4000-8000-000000000001",
    title: "Review the workspace changes",
    agent: "claude",
    request_key: "chat-pending",
    kind: "question",
    host: null,
    native_session_id: "chat-native",
  },
];
export const attentionLive = [
  {
    id: "observed-session",
    session_id: "observed-native",
    agent: "codex",
    name: "Inspect the failing build",
    status: "running",
    waiting_for_human: true,
    host: "review-host",
    cwd: "/workspace/review",
    project_id: null,
    task: null,
    last_activity_at: "2026-10-30T09:00:00Z",
    created_at: "2026-10-30T08:00:00Z",
  },
];
