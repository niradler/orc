import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type ElicitResult,
  ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { createMcpServer } from "../server.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  closeDb();
  resetConfig();
  delete process.env.ORC_DB_PATH;
});

type ElicitHandler = (params: {
  message: string;
  requestedSchema: unknown;
}) => Promise<ElicitResult> | ElicitResult;

async function connect(options: {
  handler?: ElicitHandler | undefined;
  elicitationCapability?: boolean | undefined;
}) {
  const server = createMcpServer({ mode: "meta" });
  const capabilities = options.elicitationCapability === false ? {} : { elicitation: { form: {} } };
  const client = new Client({ name: "elicit-test", version: "0.0.1" }, { capabilities });
  const handler = options.handler;
  if (handler) {
    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      handler({
        message: request.params.message,
        requestedSchema: (request.params as { requestedSchema?: unknown }).requestedSchema,
      }),
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const SCHEMA = {
  type: "object",
  properties: { color: { type: "string", enum: ["red", "blue"] } },
  required: ["color"],
};

async function runScript(client: Client, code: string) {
  return CallToolResultSchema.parse(
    await client.callTool({ name: "tool_execute", arguments: { code } }),
  );
}

describe("Elicitation inside tool_execute", () => {
  test("tools.elicit asks the client and returns the accepted form content", async () => {
    let seenMessage = "";
    const { client, server } = await connect({
      handler: ({ message }) => {
        seenMessage = message;
        return { action: "accept", content: { color: "red" } };
      },
    });
    const result = await runScript(
      client,
      `const r = await tools.elicit("Pick a color", ${JSON.stringify(SCHEMA)}); return r;`,
    );
    expect(result.isError).toBeFalsy();
    expect(seenMessage).toBe("Pick a color");
    const value = result.structuredContent?.result as {
      action: string;
      content: { color: string };
    };
    expect(value.action).toBe("accept");
    expect(value.content.color).toBe("red");
    await client.close();
    await server.close();
  });

  test("a declined elicitation surfaces action:decline to the script", async () => {
    const { client, server } = await connect({ handler: () => ({ action: "decline" }) });
    const result = await runScript(
      client,
      `const r = await tools.elicit("Continue?", { type: "object", properties: {} });
       return r.action === "decline" ? "stopped" : "went";`,
    );
    expect(result.structuredContent?.result).toBe("stopped");
    await client.close();
    await server.close();
  });

  test("the script can branch on the answer and keep calling tools afterwards", async () => {
    const { client, server } = await connect({
      handler: () => ({ action: "accept", content: { color: "blue" } }),
    });
    const result = await runScript(
      client,
      `const r = await tools.elicit("Pick", ${JSON.stringify(SCHEMA)});
       const projects = await tools.call("project_list", {});
       return { picked: r.content.color, hasProjects: projects.ok === true };`,
    );
    const value = result.structuredContent?.result as { picked: string; hasProjects: boolean };
    expect(value.picked).toBe("blue");
    expect(value.hasProjects).toBe(true);
    await client.close();
    await server.close();
  });

  test("rejects secret fields before sending elicitation to the client", async () => {
    let called = false;
    const { client, server } = await connect({
      handler: () => {
        called = true;
        return { action: "accept", content: {} };
      },
    });
    for (const schema of [
      { type: "object", properties: { api_key: { type: "string" } } },
      { type: "object", properties: { value: { type: "string", format: "password" } } },
      { type: "object", properties: { value: { type: "string", writeOnly: true } } },
    ]) {
      const result = await runScript(
        client,
        `await tools.elicit("Credentials", ${JSON.stringify(schema)}); return 1;`,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text?: string })?.text ?? "").toContain("secrets");
    }
    expect(called).toBe(false);
    await client.close();
    await server.close();
  });

  test("without the client elicitation capability, tools.elicit fails clearly", async () => {
    const { client, server } = await connect({ elicitationCapability: false });
    const result = await runScript(
      client,
      `await tools.elicit("Pick", { type: "object", properties: {} }); return 1;`,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text?: string })?.text ?? "").toContain("elicitation");
    await client.close();
    await server.close();
  });

  test("a background task elicits over the live connection", async () => {
    const { client, server } = await connect({
      handler: () => ({ action: "accept", content: { color: "red" } }),
    });
    const created = (await client.request(
      {
        method: "tools/call",
        params: {
          name: "tool_execute",
          arguments: {
            code: `const r = await tools.elicit("Pick", { type: "object", properties: {} }); return r;`,
          },
          task: {},
        },
      },
      // The task handle is not a CallToolResult; read it loosely.
      ResultSchema,
    )) as { task: { taskId: string } };
    const taskId = created.task.taskId;
    let payload: { content: { text: string }[]; isError?: boolean } | undefined;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const got = (await client.request(
        { method: "tasks/get", params: { taskId } },
        ResultSchema,
      )) as { status: string };
      if (got.status === "completed" || got.status === "failed") {
        payload = (await client.request(
          { method: "tasks/result", params: { taskId } },
          ResultSchema,
        )) as typeof payload;
        break;
      }
      await Bun.sleep(20);
    }
    expect(payload?.isError).toBeFalsy();
    expect(JSON.stringify(payload)).toContain("red");
    await client.close();
    await server.close();
  });
});
