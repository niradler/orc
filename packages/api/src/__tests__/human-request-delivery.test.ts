import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { AgentBackend, AgentEvent, SessionOpts } from "@orc/agent-runtime";
import { HumanRequestStore } from "@orc/db/human-requests";
import {
  type DeliveryDeps,
  deliverIdleAnswers,
  deliveryMessage,
  type PushTarget,
  queuedAnswers,
} from "../human-request-delivery.js";
import { activeTurns } from "../sessions/turns.js";

const KEY = "local:codex-cli:native-1";
const target: PushTarget = {
  sourceId: "live-1",
  agent: "codex",
  backend: "codex-cli",
  runtimeId: "native-1",
  host: null,
  cwd: "/work",
  model: null,
  fingerprint: "idle::1",
};

function fixture(options: { idle?: boolean; fail?: boolean; partial?: boolean } = {}) {
  const db = new Database(":memory:");
  let time = 100000;
  const store = new HumanRequestStore(db, () => time);
  const sent: { prompt: string; opts: SessionOpts; states: (string | null)[] }[] = [];
  const backend = {
    name: "fake",
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    startSession: async () => {
      throw new Error("not used");
    },
    resumeSession: async (runtimeSessionId: string, opts: SessionOpts) => ({
      id: runtimeSessionId,
      send: async (prompt: string) => {
        sent.push({ prompt, opts, states: store.list().map((request) => request.push_state) });
      },
      respondPermission: () => {},
      alive: () => true,
      close: async () => {},
      async *events(): AsyncGenerator<AgentEvent> {
        if (options.fail) {
          yield { type: "error", data: "resume refused" };
          return;
        }
        yield { type: "text", data: "Thanks, continuing." };
        if (options.partial) return;
        yield { type: "result", data: { runtimeSessionId } };
      },
    }),
  } satisfies AgentBackend;
  let idleChecks = 0;
  const deps: DeliveryDeps = {
    store,
    target: async (request) => (request.input.origin.session_id === "live-1" ? target : null),
    idle: async () => {
      idleChecks++;
      return options.idle ?? true;
    },
    resumed: async () => {},
    backend: () => backend,
    chatTurn: () => null,
  };
  const answered = (requestId: string, sessionId = "live-1") => {
    const request = store.create({
      origin: { session_id: sessionId, backend: "codex", request_id: requestId },
      kind: "command",
      title: "IBKR check",
      prompt: "Run the positions check",
      command: { script: "python ibkr.py positions", cwd: "/work" },
    });
    const running = store.claimCommand(request.id, request.version);
    return store.completeCommand(request.id, running.version, {
      kind: "command",
      exit_code: 1,
      stdout: "",
      stderr: "token [REDACTED] expired",
      truncated: false,
    });
  };
  return {
    db,
    store,
    deps,
    sent,
    answered,
    idleChecks: () => idleChecks,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("should push an unread answer into its idle session once the grace ends", async () => {
  const { db, store, deps, sent, answered, advance } = fixture();
  try {
    const request = answered("a");
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(0);
    advance(15000);
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.states).toEqual(["pushing"]);
    expect(sent[0]?.opts).toMatchObject({ cwd: "/work", interactive: false, executionHost: null });
    expect(sent[0]?.prompt).toContain("python ibkr.py positions");
    expect(sent[0]?.prompt).toContain("Exit code: 1");
    expect(sent[0]?.prompt).toContain("token [REDACTED] expired");
    expect(store.get(request.id)).toMatchObject({ status: "delivered", push_state: "pushed" });
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
    expect(activeTurns.size).toBe(0);
  } finally {
    db.close();
  }
});

test("should never push answers the agent read, unknown sessions or held turns", async () => {
  const { db, store, deps, sent, answered, advance } = fixture();
  try {
    const read = answered("a");
    const unknown = answered("b", "elsewhere");
    expect(store.seen(read.id)).toBe(true);
    expect(store.seen(read.id)).toBe(false);
    advance(20000);
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(0);
    expect(store.get(read.id)).toMatchObject({ status: "answered", push_state: null });
    expect(store.get(unknown.id)).toMatchObject({ status: "answered", push_state: null });
    const held = answered("c");
    advance(20000);
    activeTurns.add(KEY);
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(0);
    expect(store.get(held.id).push_state).toBeNull();
  } finally {
    activeTurns.clear();
    db.close();
  }
});

test("should recheck a busy session only after its recorded state changes", async () => {
  const busy = fixture({ idle: false });
  try {
    const request = busy.answered("a");
    busy.advance(15000);
    const held = new Map<string, string>();
    await deliverIdleAnswers(busy.deps, held);
    await deliverIdleAnswers(busy.deps, held);
    expect(busy.idleChecks()).toBe(1);
    expect(held.get(KEY)).toBe(target.fingerprint);
    const changed = { ...target, fingerprint: "idle::2" };
    await deliverIdleAnswers({ ...busy.deps, target: async () => changed }, held);
    expect(busy.idleChecks()).toBe(2);
    expect(busy.sent).toHaveLength(0);
    expect(busy.store.get(request.id)).toMatchObject({ status: "answered", push_state: null });
  } finally {
    busy.db.close();
  }
});

test("should combine a session's answers into one turn, oldest first", async () => {
  const { db, deps, sent, answered, advance } = fixture();
  try {
    const first = answered("a");
    advance(1000);
    const second = answered("b");
    advance(15000);
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
    const prompt = sent[0]?.prompt ?? "";
    expect(prompt.match(/### IBKR check/g)).toHaveLength(2);
    expect(prompt.indexOf(first.id)).toBeLessThan(prompt.indexOf(second.id));
  } finally {
    db.close();
  }
});

test("should run the push as a chat turn when a chat shows the session", async () => {
  const { db, store, deps, sent, answered, advance } = fixture();
  try {
    const request = answered("a");
    advance(15000);
    const turns: { session: PushTarget; prompt: string; held: boolean; state: string | null }[] =
      [];
    await deliverIdleAnswers({
      ...deps,
      chatTurn: (session, prompt) => {
        turns.push({
          session,
          prompt,
          held: activeTurns.has(KEY),
          state: store.get(request.id).push_state,
        });
        return Promise.resolve();
      },
    });
    expect(sent).toHaveLength(0);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ held: true, state: "pushing", session: target });
    expect(turns[0]?.prompt).toContain("python ibkr.py positions");
    expect(store.get(request.id)).toMatchObject({ status: "delivered", push_state: "pushed" });
    expect(activeTurns.size).toBe(0);
  } finally {
    db.close();
  }
});

test("should try once and keep a failed push answered so the agent can still read it", async () => {
  const { db, store, deps, sent, answered, advance } = fixture({ fail: true });
  try {
    const request = answered("a");
    advance(15000);
    await deliverIdleAnswers(deps);
    expect(store.get(request.id)).toMatchObject({
      status: "answered",
      push_state: "failed",
      delivered_at: null,
      response: { exit_code: 1 },
    });
    expect(store.get(request.id).push_error).toContain("resume refused");
    const chatFailed = answered("b");
    advance(15000);
    await deliverIdleAnswers({
      ...deps,
      chatTurn: () => Promise.reject(new Error("The response was stopped.")),
    });
    expect(store.get(chatFailed.id)).toMatchObject({
      status: "answered",
      push_state: "failed",
      push_error: "The response was stopped.",
    });
    await deliverIdleAnswers(deps);
    expect(sent).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("should count a push as delivered once the agent responded to it", async () => {
  const { db, store, deps, answered, advance } = fixture({ partial: true });
  try {
    const request = answered("a");
    advance(15000);
    await deliverIdleAnswers(deps);
    expect(store.get(request.id)).toMatchObject({ status: "delivered", push_state: "pushed" });
  } finally {
    db.close();
  }
});

test("should list a session's queued answers oldest first", async () => {
  const { db, store, deps, answered, advance } = fixture();
  try {
    const first = answered("a");
    advance(10);
    const second = answered("b");
    answered("c", "elsewhere");
    expect((await queuedAnswers(KEY, deps)).map((request) => request.id)).toEqual([
      first.id,
      second.id,
    ]);
    store.seen(first.id);
    expect((await queuedAnswers(KEY, deps)).map((request) => request.id)).toEqual([second.id]);
  } finally {
    db.close();
  }
});

test("should describe question and approval answers for the agent", () => {
  const base = {
    id: "r1",
    status: "answered" as const,
    delivery_error: null,
    version: 2,
    created_at: 0,
    expires_at: 1,
    responded_at: 0,
    delivered_at: null,
    seen_at: null,
    push_state: null,
    push_error: null,
  };
  const input = {
    origin: { session_id: "s", backend: "codex", request_id: "q" },
    project_id: null,
    kind: "question" as const,
    prompt: "Which color?",
    choices: [],
    choice_descriptions: {},
    multi_select: false,
    notify: [],
    expires_in_seconds: 60,
  };
  const message = deliveryMessage([
    { ...base, input, response: { kind: "question", answer: "Blue" } },
    {
      ...base,
      id: "r2",
      input: { ...input, kind: "approval" },
      response: { kind: "approval", approved: false },
    },
  ]);
  expect(message).toContain("Answer: Blue");
  expect(message).toContain("Denied. Do not perform the action.");
});
