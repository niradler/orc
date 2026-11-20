import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { CODE_LIMITS } from "../code-protocol.js";
import { runCodeWorker } from "../code-runner.js";
import { createMcpServer } from "../server.js";

beforeAll(() => {
  createTestDb();
  getSqlite().exec(`
    INSERT INTO projects(id,name) VALUES ('alpha','Alpha'),('beta','Beta');
    INSERT INTO tasks(id,title,project_id,status) VALUES
      ('alpha-task','Alpha fixture','alpha','todo'),('beta-task','Beta fixture','beta','todo');
  `);
});

afterAll(() => closeDb());

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer({ mode: "code", project: "Alpha" });
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.listTools();
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function execute(client: Client, code: string, timeoutMs?: number) {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: "tool_execute",
      arguments: { code, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) },
    }),
  );
}

describe("MCP code mode", () => {
  test("should discover and combine scoped real tools without returning intermediate payloads", async () => {
    await withClient(async (client) => {
      const result = await execute(
        client,
        `
        const [tasks, memories] = await Promise.all([
          tools.search("list active tasks"), tools.search("list memories")
        ]);
        const definitions = await Promise.all([
          tools.describe(tasks.tools[0].name), tools.describe(memories.tools[0].name)
        ]);
        const [list, notes, otherProject, hiddenTool] = await Promise.allSettled([
          tools.call(definitions[0].name), tools.call(definitions[1].name),
          tools.call("task_list", { project: "Beta" }),
          tools.call("preview_browser_act", {})
        ]);
        return {
          discovered: definitions.map(tool => tool.name),
          count: list.value.split("\\n").length,
          alpha: list.value.includes("Alpha fixture"),
          beta: list.value.includes("Beta fixture"),
          notes: notes.status,
          rejected: [otherProject.status, hiddenTool.status],
        };
      `,
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        result: {
          discovered: ["task_list", "memory_list"],
          count: 1,
          alpha: true,
          beta: false,
          notes: "fulfilled",
          rejected: ["rejected", "rejected"],
        },
        logs: [],
        truncated: false,
      });
      expect(JSON.stringify(result.content)).not.toContain("Alpha fixture");
      expect((await client.callTool({ name: "task_list" })).isError).toBe(true);
    });
  });

  test("should validate tool arguments and commit an eligible write in the selected project", async () => {
    await withClient(async (client) => {
      const result = await execute(
        client,
        `
        const invalid = await Promise.allSettled([tools.call("task_create", { title: 7 })]);
        const task = await tools.describe("task_create");
        await tools.call(task.name, { title: "Created from code mode" });
        const tasks = await tools.call("task_list");
        return { invalid: invalid[0].reason.message.startsWith("Invalid args"), observed: tasks.includes("Created from code mode") };
      `,
      );
      expect(result.structuredContent?.result).toEqual({ invalid: true, observed: true });
      expect(
        getSqlite()
          .query("SELECT project_id FROM tasks WHERE title=?")
          .get("Created from code mode"),
      ).toEqual({ project_id: "alpha" });
    });
  });

  test("should isolate fresh guests and enforce result, log and complexity budgets", async () => {
    await withClient(async (client) => {
      const isolation = await execute(
        client,
        `
        globalThis.marker = 42;
        return [typeof process, typeof fetch, typeof require, typeof Bun,
          Object.constructor("return typeof process")()];
      `,
      );
      expect(isolation.structuredContent?.result).toEqual(Array(5).fill("undefined"));
      const next = await execute(client, "return typeof marker;");
      expect(next.structuredContent?.result).toBe("undefined");
      const capped = await execute(
        client,
        `
        for (let i = 0; i < 100; i++) console.log("x".repeat(4000));
        return "y".repeat(16000);
      `,
      );
      expect(capped.structuredContent).toEqual({
        result: null,
        logs: Array(CODE_LIMITS.logLines).fill("x".repeat(CODE_LIMITS.logChars)),
        truncated: true,
      });
      const deep = await execute(
        client,
        "let value = 0; for (let i = 0; i < 75; i++) value = [value]; return value;",
      );
      expect(deep.structuredContent).toEqual({ result: null, logs: [], truncated: true });
    });
  });

  test("should interrupt a tight loop and contain allocation failures while the server stays responsive", async () => {
    await withClient(async (client) => {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 5);
      try {
        const timeout = await execute(client, "while (true) {}", 300);
        expect(timeout.isError).toBe(true);
        expect(JSON.stringify(timeout.content)).toContain("timed out");
        expect(ticks).toBeGreaterThan(5);
        const memory = await execute(client, "return new ArrayBuffer(100 * 1024 * 1024);");
        expect(memory.isError).toBe(true);
        const overflow = await execute(
          client,
          "await Promise.all(Array.from({length: 80}, () => tools.search()));",
        );
        expect(JSON.stringify(overflow.content)).toContain("tool request limit");
        expect((await execute(client, "return 7;")).structuredContent?.result).toBe(7);
      } finally {
        clearInterval(timer);
      }
    });
  });
});

test("should overlap reads and serialize writes in one worker execution", async () => {
  let active = 0;
  let peak = 0;
  let writeOverlap = false;
  const events: string[] = [];
  const outcome = await runCodeWorker(
    `return await Promise.all([
      tools.call("read1"), tools.call("read2"), tools.call("write"), tools.call("read3")
    ]);`,
    5000,
    new AbortController().signal,
    (payload) => {
      const { name } = JSON.parse(payload) as { name: string };
      return {
        serial: name === "write",
        async dispatch() {
          active++;
          peak = Math.max(peak, active);
          events.push(`start ${name}`);
          if (name === "write") writeOverlap = active !== 1;
          await Bun.sleep(15);
          events.push(`end ${name}`);
          active--;
          return JSON.stringify({ value: name });
        },
      };
    },
  );
  expect(outcome.result).toEqual(["read1", "read2", "write", "read3"]);
  expect(peak).toBe(2);
  expect(writeOverlap).toBe(false);
  expect(events.indexOf("end write")).toBeLessThan(events.indexOf("start read3"));
});

test("should cancel queued calls and retain admission until an in-flight call settles", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const dispatched: string[] = [];
  const execution = runCodeWorker(
    'await Promise.all([tools.call("first"), tools.call("second")]);',
    5000,
    controller.signal,
    (payload) => {
      const { name } = JSON.parse(payload) as { name: string };
      return {
        serial: true,
        async dispatch() {
          dispatched.push(name);
          started.resolve();
          await release.promise;
          return '{"value":null}';
        },
      };
    },
  );
  try {
    await started.promise;
    controller.abort();
    await expect(execution).rejects.toThrow("cancelled");
  } finally {
    release.resolve();
  }
  await Bun.sleep(0);
  expect(dispatched).toEqual(["first"]);
});
