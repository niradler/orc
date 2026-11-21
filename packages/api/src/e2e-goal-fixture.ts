import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentSession,
  registerBackend,
  type SessionOpts,
} from "@orc/agent-runtime";

/**
 * Deterministic goal worker for the browser e2e loop test, loaded only when
 * ORC_E2E_GOAL_FIXTURE=1 (set by run-e2e.ts). The first turn works without
 * producing the artifact; the second turn writes `goal-marker` into the session
 * cwd, so a check for that file passes on iteration two — the loop, the resume
 * and the check history are all exercised without a paid agent.
 */
const turns = new Map<string, number>();

function workerSession(options: SessionOpts): AgentSession {
  const cwd = options.cwd ?? process.cwd();
  const turn = (turns.get(cwd) ?? 0) + 1;
  turns.set(cwd, turn);
  if (turn >= 2) writeFileSync(join(cwd, "goal-marker"), "done");
  return {
    id: `e2e-goal-session-${turn}`,
    send: async () => {},
    alive: () => true,
    respondPermission: () => {},
    close: async () => {},
    events: async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: "result",
        data: {
          runtimeSessionId: `e2e-goal-native-${turn}`,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
    },
  };
}

registerBackend("goal-fixture", () => ({
  name: "goal-fixture",
  profileCapabilities: { model: true, toolAllowlist: true },
  preflight: async () => ({ ok: true }),
  stop: async () => {},
  resumeSession: async (_id, options) => workerSession(options),
  startSession: async (options) => workerSession(options),
}));
