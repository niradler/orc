import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { RuleStore } from "@orc/db/rules";
import { withHumanRequests } from "../human-requests.js";
import type { AgentEvent, AgentSession } from "../types.js";

const cwd = mkdtempSync(join(tmpdir(), "orc-native-human-"));
let server: ReturnType<typeof Bun.serve>;
const before = {
  db: process.env.ORC_DB_PATH,
  enabled: process.env.ORC_RULES_ENABLED,
  base: process.env.ORC_API_BASE,
  secret: process.env.ORC_API_SECRET,
};
beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_RULES_ENABLED = "true";
  process.env.ORC_API_SECRET = "";
  resetConfig();
  createTestDb();
  new RuleStore(getSqlite()).activate(
    {
      workspace: cwd,
      project_id: null,
      rules: [
        {
          id: "question",
          kind: "event",
          enabled: true,
          reason: "Answer",
          scope: { agents: ["codex"], events: ["runtime:question_request"] },
          filter: { match: "all", conditions: [] },
          target: { type: "ask_user", kind: "question", prompt: "Question" },
        },
        {
          id: "approval",
          kind: "event",
          enabled: true,
          reason: "Approve",
          scope: { agents: ["codex"], events: ["runtime:permission_request"] },
          filter: { match: "all", conditions: [] },
          target: { type: "ask_user", kind: "approval", prompt: "Review command" },
        },
      ],
    },
    null,
    "Native broker test",
  );
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
      return Response.json(new HumanRequestStore(getSqlite()).get(id));
    },
  });
  process.env.ORC_API_BASE = String(server.url).replace(/\/$/, "");
});
afterAll(() => {
  server.stop(true);
  closeDb();
  for (const [key, value] of [
    ["ORC_DB_PATH", before.db],
    ["ORC_RULES_ENABLED", before.enabled],
    ["ORC_API_BASE", before.base],
    ["ORC_API_SECRET", before.secret],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

function native(event: AgentEvent) {
  let interrupt: (event: AgentEvent) => void = () => {};
  const interrupted = new Promise<AgentEvent>((resolve) => {
    interrupt = resolve;
  });
  let complete: () => void = () => {};
  const response = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let alive = true;
  const received: { id: string; value: unknown }[] = [];
  const session: AgentSession = {
    id: crypto.randomUUID(),
    send: async () => {},
    alive: () => alive,
    close: async () => {
      alive = false;
      complete();
    },
    respondPermission: (id, value) => {
      received.push({ id, value });
      complete();
    },
    respondQuestion: (id, value) => {
      received.push({ id, value });
      complete();
    },
    async *events() {
      yield event;
      const next = await Promise.race([response.then(() => null), interrupted]);
      if (next) yield next;
      else if (alive) yield { type: "text", data: "continued" };
    },
  };
  return {
    session: withHumanRequests(session, "codex-cli", {
      cwd,
      executionHost: null,
      interactive: true,
    }),
    received,
    interrupt,
  };
}

async function waitForRequest(sessionId: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const request = new HumanRequestStore(getSqlite())
      .list()
      .find((entry) => entry.input.origin.session_id === sessionId);
    if (request) return request;
    await Bun.sleep(10);
  }
  throw new Error("No pending human request");
}

test("should deliver a persisted question answer only to its originating native call", async () => {
  const { session, received } = native({
    type: "question_request",
    data: {
      requestId: "native-q",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Choose a color",
          options: [{ label: "Blue", description: "" }],
        },
      ],
    },
  });
  const events: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const request = await waitForRequest(session.id);
  expect(session.waitingForHuman?.()).toBe(true);
  expect(received).toEqual([]);
  new HumanRequestStore(getSqlite()).respond(request.id, 1, {
    kind: "question",
    answer: "Custom blue",
  });
  await finished;
  expect(received).toEqual([{ id: "native-q", value: { color: ["Custom blue"] } }]);
  expect(new HumanRequestStore(getSqlite()).get(request.id).status).toBe("delivered");
  expect(events.some((event) => event.type === "text" && event.data === "continued")).toBe(true);
  expect(session.waitingForHuman?.()).toBe(false);
  await session.close();
});

test("should keep reading native cancellation while a human answer is pending", async () => {
  const { session, received, interrupt } = native({
    type: "permission_request",
    data: { requestId: "native-resolved", tool: "command", command: "pwd" },
  });
  const finished = (async () => {
    for await (const _event of session.events()) {
    }
  })();
  const request = await waitForRequest(session.id);
  interrupt({ type: "request_resolved", data: { requestId: "native-resolved" } });
  await finished;
  const store = new HumanRequestStore(getSqlite());
  expect(store.get(request.id).status).toBe("cancelled");
  expect(() => store.respond(request.id, 1, { kind: "approval", approved: true })).toThrow("stale");
  expect(received).toEqual([]);
  await session.close();
});

test("should reject replies after the native connection ends before answering", async () => {
  const { session, received, interrupt } = native({
    type: "permission_request",
    data: { requestId: "native-ended", tool: "command", command: "pwd" },
  });
  const finished = (async () => {
    for await (const _event of session.events()) {
    }
  })();
  const request = await waitForRequest(session.id);
  interrupt({ type: "error", data: "Native transport disconnected" });
  await finished;
  const store = new HumanRequestStore(getSqlite());
  expect(store.get(request.id).status).toBe("unavailable");
  expect(() => store.respond(request.id, 1, { kind: "approval", approved: true })).toThrow("stale");
  expect(received).toEqual([]);
  await session.close();
});

test("should return denial without executing an approval in ORC", async () => {
  const { session, received } = native({
    type: "permission_request",
    data: { requestId: "native-approval", tool: "command", command: "pwd" },
  });
  const finished = (async () => {
    for await (const _event of session.events()) {
    }
  })();
  const request = await waitForRequest(session.id);
  expect(request.input.action?.host).toBe("local");
  expect(request.input.action?.input).toEqual({ command: "pwd" });
  new HumanRequestStore(getSqlite()).respond(request.id, 1, { kind: "approval", approved: false });
  await finished;
  expect(received).toEqual([{ id: "native-approval", value: "denied" }]);
  await session.close();
});

test("should cancel a pending native request when its runtime closes", async () => {
  const { session, received } = native({
    type: "permission_request",
    data: { requestId: "native-cancel", tool: "command", command: "pwd" },
  });
  const finished = (async () => {
    for await (const _event of session.events()) {
    }
  })();
  const request = await waitForRequest(session.id);
  await session.close();
  await finished;
  expect(new HumanRequestStore(getSqlite()).get(request.id).status).toBe("cancelled");
  expect(received.every((entry) => entry.value === "denied")).toBe(true);
});
