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

function native(event: AgentEvent, backend = "codex-cli") {
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
    setPermissionMode: (mode) => {
      received.push({ id: "mode", value: mode });
    },
    async *events() {
      yield event;
      const next = await Promise.race([response.then(() => null), interrupted]);
      if (next) yield next;
      else if (alive) yield { type: "text", data: "continued" };
    },
  };
  return {
    session: withHumanRequests(session, backend, {
      cwd,
      executionHost: null,
      interactive: true,
    }),
    received,
    interrupt,
  };
}

test("automatically exposes a native approval and resolves it from chat", async () => {
  const { session, received } = native(
    {
      type: "permission_request",
      data: { requestId: "automatic-approval", tool: "command", command: "pwd" },
    },
    "claude-cli",
  );
  const events: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const request = await waitForRequest(session.id);
  expect(request.input.origin.backend).toBe("claude-cli");
  expect(events.some((event) => event.type === "permission_request")).toBe(true);
  session.respondPermission("automatic-approval", "session");
  expect(() =>
    new HumanRequestStore(getSqlite()).respond(request.id, 1, {
      kind: "approval",
      approved: false,
    }),
  ).toThrow();
  await finished;
  expect(received).toEqual([{ id: "automatic-approval", value: "session" }]);
  expect(new HumanRequestStore(getSqlite()).get(request.id).status).toBe("delivered");
  expect(events.some((event) => event.type === "request_resolved")).toBe(true);
  await session.close();
});

test("an Attention answer resolves the corresponding native chat prompt", async () => {
  const { session, received } = native(
    {
      type: "permission_request",
      data: { requestId: "automatic-inbox", tool: "command", command: "pwd" },
    },
    "claude-cli",
  );
  const events: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const request = await waitForRequest(session.id);
  new HumanRequestStore(getSqlite()).respond(request.id, 1, { kind: "approval", approved: false });
  expect(() => session.respondPermission("automatic-inbox", "approved")).toThrow();
  await finished;
  expect(received).toEqual([{ id: "automatic-inbox", value: "denied" }]);
  expect(events.some((event) => event.type === "request_resolved")).toBe(true);
  await session.close();
});

test("chat answers all automatic questions and removes their inbox entries", async () => {
  const { session, received } = native(
    {
      type: "question_request",
      data: {
        requestId: "automatic-questions",
        questions: [
          { id: "first", header: "First", question: "First answer?" },
          { id: "second", header: "Second", question: "Second answer?" },
        ],
      },
    },
    "claude-cli",
  );
  const events: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  await waitForRequest(session.id);
  const records = new HumanRequestStore(getSqlite())
    .list()
    .filter((entry) => entry.input.origin.session_id === session.id);
  expect(records).toHaveLength(2);
  await session.respondQuestion?.("automatic-questions", { first: ["one"], second: ["two"] });
  await finished;
  expect(received).toEqual([
    { id: "automatic-questions", value: { first: ["one"], second: ["two"] } },
  ]);
  expect(records.map((record) => new HumanRequestStore(getSqlite()).get(record.id).status)).toEqual(
    ["delivered", "delivered"],
  );
  expect(events.some((event) => event.type === "request_resolved")).toBe(true);
  await session.close();
});

test("secret questions stay in the native channel without being persisted", async () => {
  const { session, received } = native(
    {
      type: "question_request",
      data: {
        requestId: "secret",
        questions: [{ id: "secret", header: "Secret", question: "Secret?", isSecret: true }],
      },
    },
    "claude-cli",
  );
  const finished = (async () => {
    for await (const event of session.events()) {
      if (event.type === "question_request")
        await session.respondQuestion?.("secret", { secret: ["value"] });
    }
  })();
  await finished;
  expect(received).toEqual([{ id: "secret", value: { secret: ["value"] } }]);
  expect(
    new HumanRequestStore(getSqlite())
      .list()
      .some((entry) => entry.input.origin.session_id === session.id),
  ).toBe(false);
  await session.close();
});

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

test("a rule-triggered approval can also be answered from chat", async () => {
  const { session, received } = native({
    type: "permission_request",
    data: { requestId: "rule-chat", tool: "command", command: "pwd" },
  });
  const events: AgentEvent[] = [];
  const finished = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  const request = await waitForRequest(session.id);
  expect(request.input.rule_bindings?.length).toBe(1);
  expect(events.some((event) => event.type === "permission_request")).toBe(true);
  expect(
    events.some((event) => event.type === "system_status" && event.data.includes("Review command")),
  ).toBe(true);
  session.respondPermission("rule-chat", "denied");
  await finished;
  expect(received).toEqual([{ id: "rule-chat", value: "denied" }]);
  expect(new HumanRequestStore(getSqlite()).get(request.id).status).toBe("delivered");
  await session.close();
});

test("changing permission mode cannot bypass a pending rule approval", async () => {
  const { session, received } = native({
    type: "permission_request",
    data: { requestId: "protected-mode", tool: "command", command: "pwd" },
  });
  const finished = (async () => {
    for await (const _event of session.events()) {
    }
  })();
  const request = await waitForRequest(session.id);
  expect(() => session.setPermissionMode?.("bypassPermissions")).toThrow("rule requires");
  expect(new HumanRequestStore(getSqlite()).get(request.id).status).toBe("pending");
  expect(received).toEqual([]);
  session.respondPermission("protected-mode", "denied");
  await finished;
  expect(received).toEqual([{ id: "protected-mode", value: "denied" }]);
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

test("a failed inbox update cannot loosen the native permission mode", async () => {
  getSqlite().exec(`CREATE TEMP TRIGGER fixture_mode_failure BEFORE UPDATE ON human_requests
    WHEN NEW.status = 'cancelled' AND json_extract(OLD.payload, '$.action.input.command') = 'fixture mode failure'
    BEGIN SELECT RAISE(FAIL, 'fixture mode failure'); END`);
  const { session, received } = native(
    {
      type: "permission_request",
      data: { requestId: "mode-failure", tool: "Bash", command: "fixture mode failure" },
    },
    "claude-cli",
  );
  const finished = (async () => {
    for await (const _event of session.events()) {
    }
  })();
  const request = await waitForRequest(session.id);
  expect(() => session.setPermissionMode?.("bypassPermissions")).toThrow("fixture mode failure");
  expect(received).toEqual([]);
  expect(new HumanRequestStore(getSqlite()).get(request.id).status).toBe("pending");
  session.respondPermission("mode-failure", "denied");
  await finished;
  expect(received).toEqual([{ id: "mode-failure", value: "denied" }]);
  await session.close();
});

test("a failed partial inbox cleanup leaves an unruled question answerable in chat", async () => {
  getSqlite().exec(`CREATE TEMP TRIGGER fixture_cleanup_failure BEFORE UPDATE ON human_requests
    WHEN json_extract(OLD.payload, '$.prompt') = 'Fixture first question'
    BEGIN SELECT RAISE(FAIL, 'fixture cleanup failure'); END`);
  const { session, received } = native(
    {
      type: "question_request",
      data: {
        requestId: "partial-cleanup",
        questions: [
          { id: "first", header: "First", question: "Fixture first question", options: [] },
          {
            id: "second",
            header: "Second",
            question: "Fixture second question",
            options: Array.from({ length: 21 }, (_, i) => ({
              label: `Option ${i}`,
              description: "",
            })),
          },
        ],
      },
    },
    "claude-cli",
  );
  for await (const event of session.events()) {
    if (event.type === "question_request")
      await session.respondQuestion?.("partial-cleanup", { first: ["a"], second: ["b"] });
  }
  expect(received).toEqual([{ id: "partial-cleanup", value: { first: ["a"], second: ["b"] } }]);
  await session.close();
});
