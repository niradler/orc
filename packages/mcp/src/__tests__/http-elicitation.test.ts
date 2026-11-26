import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { resetConfig } from "@orc/core/config";
import type { HumanRequest } from "@orc/core/human-requests";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { createHumanElicit } from "../elicit.js";
import { createMcpServer } from "../server.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  process.env.ORC_AGENT = "codex";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  closeDb();
  resetConfig();
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_AGENT;
});

const SESSION = "http-elicit-session";

async function connectHttp(sessionId = SESSION) {
  // requestSignal marks the stateless HTTP transport (the route always passes it).
  const server = createMcpServer({
    mode: "meta",
    requestSignal: new AbortController().signal,
    agentSessionId: sessionId,
  });
  const client = new Client({ name: "http-elicit", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function store() {
  return new HumanRequestStore(getSqlite());
}

async function pendingQuestion(marker: string, timeoutMs = 5000): Promise<HumanRequest> {
  const start = Date.now();
  for (;;) {
    const pending = store()
      .list()
      .find(
        (request) =>
          request.status === "pending" &&
          request.input.kind === "question" &&
          request.input.prompt.includes(marker),
      );
    if (pending) return pending;
    if (Date.now() - start > timeoutMs) throw new Error(`no pending question for "${marker}"`);
    await Bun.sleep(20);
  }
}

async function runScript(
  client: Client,
  opts: {
    marker: string;
    code: string;
    answer: string;
    delayMs?: number;
    timeoutMs?: number;
  },
) {
  const call = client.callTool({
    name: "tool_execute",
    arguments: { code: opts.code, timeout_ms: opts.timeoutMs ?? 4000 },
  });
  const request = await pendingQuestion(opts.marker);
  if (opts.delayMs) await Bun.sleep(opts.delayMs);
  store().respond(
    request.id,
    request.version,
    { kind: "question", answer: opts.answer },
    { actor: "test" },
  );
  return CallToolResultSchema.parse(await call);
}

describe("HTTP elicitation via durable human requests", () => {
  test("routes elicitation to a human question with the enum as choices", async () => {
    const { client, server } = await connectHttp();
    const result = await runScript(client, {
      marker: "Pick a color",
      code: `const r = await tools.elicit("Pick a color", {
         type: "object",
         properties: { color: { type: "string", enum: ["red", "blue"] } },
         required: ["color"],
       });
       return r;`,
      answer: "red",
    });
    expect(result.isError).toBeFalsy();
    const value = result.structuredContent?.result as {
      action: string;
      content: { color: string };
    };
    expect(value.action).toBe("accept");
    expect(value.content.color).toBe("red");

    const row = getSqlite()
      .query<{ id: string; status: string; payload: string }, []>(
        "SELECT id,status,payload FROM human_requests WHERE json_extract(payload,'$.prompt') LIKE '%Pick a color%'",
      )
      .get();
    expect(row?.status).toBe("delivered");
    const payload = JSON.parse(row?.payload ?? "{}") as {
      choices: string[];
      origin: { session_id: string; backend: string };
      notify: string[];
      deliver_to_session: boolean;
    };
    expect(payload.choices).toEqual(["red", "blue"]);
    expect(payload.origin.session_id).toBe(SESSION);
    expect(payload.origin.backend).toBe("codex");
    expect(payload.notify).toContain("telegram");
    expect(payload.deliver_to_session).toBe(false);
    expect(
      store()
        .list()
        .some((item) => item.id === row?.id),
    ).toBe(false);
    expect(
      store()
        .pushCandidates(0)
        .some((item) => item.id === row?.id),
    ).toBe(false);
    await client.close();
    await server.close();
  });

  test("pauses the sandbox clock: an answer after the code timeout still resumes", async () => {
    const { client, server } = await connectHttp();
    // timeout_ms is 300ms; the human answers 900ms later. Without the pause this
    // would fail with "Code execution timed out".
    const result = await runScript(client, {
      marker: "Name?",
      code: `const r = await tools.elicit("Name?", { type: "object", properties: { name: { type: "string" } } });
       return r.content.name;`,
      answer: "Ada",
      delayMs: 900,
      timeoutMs: 300,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.result).toBe("Ada");
    await client.close();
    await server.close();
  });

  test("coerces numeric fields to their schema type", async () => {
    const { client, server } = await connectHttp();
    const result = await runScript(client, {
      marker: "Count?",
      code: `const r = await tools.elicit("Count?", { type: "object", properties: { count: { type: "integer" } } });
       return { count: r.content.count, isNumber: typeof r.content.count === "number" };`,
      answer: "42",
    });
    const value = result.structuredContent?.result as { count: number; isNumber: boolean };
    expect(value.count).toBe(42);
    expect(value.isNumber).toBe(true);
    await client.close();
    await server.close();
  });

  test("multi-field answers parse JSON content", async () => {
    const { client, server } = await connectHttp();
    const result = await runScript(client, {
      marker: "Details JSON",
      code: `const r = await tools.elicit("Details JSON", {
         type: "object",
         properties: { name: { type: "string" }, age: { type: "integer" } },
         required: ["name", "age"],
       });
       return r;`,
      answer: '{"name":"Ada","age":36}',
    });
    const value = result.structuredContent?.result as {
      action: string;
      content: { name: string; age: number };
    };
    expect(value.action).toBe("accept");
    expect(value.content).toEqual({ name: "Ada", age: 36 });
    await client.close();
    await server.close();
  });

  test("ambiguous multi-field free text declines instead of guessing", async () => {
    const { client, server } = await connectHttp();
    const result = await runScript(client, {
      marker: "Details free",
      code: `const r = await tools.elicit("Details free", {
         type: "object",
         properties: { name: { type: "string" }, age: { type: "integer" } },
       });
       return r.action;`,
      answer: "just text",
    });
    expect(result.structuredContent?.result).toBe("decline");
    await client.close();
    await server.close();
  });

  test("cancels the request when the wait budget ends unanswered", async () => {
    const elicit = createHumanElicit({ sessionId: SESSION, waitMs: 1 });
    const result = await elicit({
      message: "Nobody answers this",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(result.action).toBe("cancel");
    const row = getSqlite()
      .query<{ status: string }, []>(
        "SELECT status FROM human_requests WHERE json_extract(payload,'$.prompt') LIKE '%Nobody answers this%'",
      )
      .get();
    expect(row?.status).toBe("cancelled");
  });

  test("rejects invalid answers, supports >20 choices without crashing, and aborts promptly", async () => {
    const { client, server } = await connectHttp();
    const badInt = await runScript(client, {
      marker: "Bad count",
      code: `const r = await tools.elicit("Bad count", { type: "object", properties: { count: { type: "integer" } } });
       return r.action;`,
      answer: "not-a-number",
    });
    expect(badInt.structuredContent?.result).toBe("decline");

    const missingRequired = await runScript(client, {
      marker: "Missing field",
      code: `const r = await tools.elicit("Missing field", {
         type: "object",
         properties: { a: { type: "string" }, b: { type: "integer" } },
         required: ["a", "b"],
       });
       return r.action;`,
      answer: '{"a":"only-a"}',
    });
    expect(missingRequired.structuredContent?.result).toBe("decline");

    const manyChoices = Array.from({ length: 25 }, (_, index) => `opt-${index}`);
    const picked = await runScript(client, {
      marker: "Many choices",
      code: `const r = await tools.elicit("Many choices", {
         type: "object",
         properties: { choice: { type: "string", enum: ${JSON.stringify(manyChoices)} } },
       });
       return r;`,
      answer: "opt-22",
    });
    expect(picked.structuredContent?.result).toEqual({
      action: "accept",
      content: { choice: "opt-22" },
    });

    const controller = new AbortController();
    const elicit = createHumanElicit({
      sessionId: SESSION,
      waitMs: 10_000,
      signal: controller.signal,
    });
    const started = Date.now();
    const waiting = elicit({
      message: "Abort me immediately",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    });
    await pendingQuestion("Abort me immediately");
    controller.abort();
    expect(await waiting).toEqual({ action: "cancel" });
    expect(Date.now() - started).toBeLessThan(400);

    await client.close();
    await server.close();
  });
});
