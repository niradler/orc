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
  const server = createMcpServer({ mode: "meta", project: "Alpha" });
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
  test("should discover and combine scoped real tools with structured envelopes without returning intermediate payloads", async () => {
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
        const [list, notes, otherProject, hiddenTool] = await tools.allSettled([
          { name: definitions[0].name },
          { name: definitions[1].name },
          { name: "task_list", args: { project: "Beta" } },
          { name: "preview_browser_act", args: {} },
        ]);
        return {
          discovered: definitions.map(tool => tool.name),
          count: list.ok ? list.data.count : -1,
          firstTitle: list.ok ? list.data.tasks[0]?.title : null,
          alphaText: list.ok ? list.text.includes("Alpha fixture") : false,
          betaText: list.ok ? list.text.includes("Beta fixture") : false,
          notesOk: notes.ok,
          otherCode: otherProject.ok ? null : otherProject.error.code,
          hiddenCode: hiddenTool.ok ? null : hiddenTool.error.code,
        };
      `,
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({
        result: {
          discovered: ["task_list", "memory_list"],
          count: 1,
          firstTitle: "Alpha fixture",
          alphaText: true,
          betaText: false,
          notesOk: true,
          otherCode: "FORBIDDEN",
          hiddenCode: "NOT_FOUND",
        },
        logs: [],
        truncated: false,
      });
      expect(JSON.stringify(result.content)).not.toContain("Beta fixture");
      expect((await client.callTool({ name: "task_list" })).isError).toBeUndefined();
      expect((await client.callTool({ name: "spec_list" })).isError).toBe(true);
    });
  });

  test("should return structured data and errors across a batch of three calls without throwing", async () => {
    await withClient(async (client) => {
      const result = await execute(
        client,
        `
        const [tasks, projects, missing] = await tools.allSettled([
          { name: "task_list", args: {} },
          { name: "project_list", args: {} },
          { name: "does_not_exist", args: {} },
        ]);
        return {
          tasksOk: tasks.ok,
          pickedTasks: tasks.ok ? tools.pick(tasks.data.tasks, ["id", "status"]) : null,
          projectsOk: projects.ok,
          projectNames: projects.ok ? projects.data.projects.map((p) => p.name) : null,
          missingOk: missing.ok,
          missingCode: missing.ok ? null : missing.error.code,
          missingMessage: missing.ok ? null : missing.error.message,
        };
      `,
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent?.result).toMatchObject({
        tasksOk: true,
        pickedTasks: [{ id: "alpha-task", status: "todo" }],
        projectsOk: true,
        projectNames: ["Alpha"],
        missingOk: false,
        missingCode: "NOT_FOUND",
      });
      expect(
        (result.structuredContent?.result as { missingMessage?: string } | undefined)
          ?.missingMessage,
      ).not.toContain("tool_execute");
    });
  });

  test("should validate tool arguments and commit an eligible write in the selected project", async () => {
    await withClient(async (client) => {
      const result = await execute(
        client,
        `
        const invalid = await tools.call("task_create", { title: 7 });
        const task = await tools.describe("task_create");
        const created = await tools.call(task.name, { title: "Created from code mode" });
        const tasks = await tools.call("task_list");
        return {
          invalidOk: invalid.ok,
          invalidCode: invalid.ok ? null : invalid.error.code,
          invalidPrefix: invalid.ok ? false : invalid.error.message.startsWith("Invalid args"),
          createdOk: created.ok,
          observed: tasks.ok && tasks.data.tasks.some((t) => t.title === "Created from code mode"),
        };
      `,
      );
      expect(result.structuredContent?.result).toEqual({
        invalidOk: false,
        invalidCode: "INVALID_ARGS",
        invalidPrefix: true,
        createdOk: true,
        observed: true,
      });
      expect(
        getSqlite()
          .query("SELECT project_id FROM tasks WHERE title=?")
          .get("Created from code mode"),
      ).toEqual({ project_id: "alpha" });
    });
  });

  test("should reject unknown describe names with catalog-only hints", async () => {
    await withClient(async (client) => {
      const result = await execute(
        client,
        `
        const tryDescribe = async (name) => {
          try {
            return { ok: true, value: await tools.describe(name) };
          } catch (error) {
            return { ok: false, message: String(error.message ?? error) };
          }
        };
        const [bogus, unknownTask, nonScriptableDescribe, nonScriptableCall, nearMiss] =
          await Promise.all([
            tryDescribe("tools.orc.tool_execute"),
            tryDescribe("task_delete"),
            tryDescribe("job_run"),
            tools.call("job_run", { name: "x" }),
            tryDescribe("task_foo"),
          ]);
        return { bogus, unknownTask, nonScriptableDescribe, nonScriptableCall, nearMiss };
      `,
      );
      const out = result.structuredContent?.result as {
        bogus: { ok: boolean; message: string };
        unknownTask: { ok: boolean; message: string };
        nonScriptableDescribe: { ok: boolean; message: string };
        nonScriptableCall: { ok: boolean; error?: { code: string; message: string } };
        nearMiss: { ok: boolean; message: string };
      };
      expect(out.bogus.ok).toBe(false);
      expect(out.bogus.message).toContain("Unknown tool: tools.orc.tool_execute");
      expect(out.bogus.message).not.toContain("Close names:");
      expect(out.unknownTask.ok).toBe(false);
      expect(out.unknownTask.message).toContain("Unknown tool:");
      expect(out.nonScriptableDescribe.ok).toBe(false);
      expect(out.nonScriptableDescribe.message).toContain("is not callable from tool_execute");
      expect(out.nonScriptableCall).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(out.nonScriptableCall.error?.message).toContain("is not callable from tool_execute");
      expect(out.nearMiss.ok).toBe(false);
      expect(out.nearMiss.message).toContain("task_list");
      expect(out.nearMiss.message).not.toContain("tool_execute");
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
      const cappedData = capped.structuredContent as {
        result: unknown;
        logs: string[];
        truncated: boolean;
        result_chars: number;
        limit_chars: number;
        preview: string;
        message: string;
      };
      expect(cappedData.result).toBeNull();
      expect(cappedData.logs).toEqual(
        Array(CODE_LIMITS.logLines).fill("x".repeat(CODE_LIMITS.logChars)),
      );
      expect(cappedData.truncated).toBe(true);
      expect(cappedData.result_chars).toBeGreaterThan(CODE_LIMITS.resultChars);
      expect(cappedData.limit_chars).toBe(CODE_LIMITS.resultChars);
      expect(cappedData.preview.length).toBe(CODE_LIMITS.resultPreviewChars);
      expect(cappedData.message).toContain(`${CODE_LIMITS.resultChars}-character`);
      const deep = await execute(
        client,
        "let value = 0; for (let i = 0; i < 75; i++) value = [value]; return value;",
      );
      const deepData = deep.structuredContent as {
        result: unknown;
        logs: string[];
        truncated: boolean;
        preview: string;
        message: string;
      };
      expect(deepData.result).toBeNull();
      expect(deepData.logs).toEqual([]);
      expect(deepData.truncated).toBe(true);
      expect(typeof deepData.preview).toBe("string");
      expect(deepData.message).toContain("shape limit");
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
  expect(outcome.result).toEqual([
    { ok: true, data: "read1", text: "read1" },
    { ok: true, data: "read2", text: "read2" },
    { ok: true, data: "write", text: "write" },
    { ok: true, data: "read3", text: "read3" },
  ]);
  expect(peak).toBe(2);
  expect(writeOverlap).toBe(false);
  expect(events.indexOf("end write")).toBeLessThan(events.indexOf("start read3"));
});

test("should time out a slow per-call tool without discarding fast calls in the same batch", async () => {
  const releaseSlow = Promise.withResolvers<void>();
  try {
    const outcome = await runCodeWorker(
      `return await tools.allSettled([
        { name: "fast1", args: {} },
        { name: "slow", args: {}, timeout_ms: 80 },
        { name: "fast2", args: {} },
      ]);`,
      5000,
      new AbortController().signal,
      (payload) => {
        const parsed = JSON.parse(payload) as { name: string; timeout_ms?: number };
        return {
          serial: false,
          toolName: parsed.name,
          envelope: true,
          ...(parsed.timeout_ms !== undefined ? { timeoutMs: parsed.timeout_ms } : {}),
          async dispatch() {
            if (parsed.name === "slow") {
              await releaseSlow.promise;
              return JSON.stringify({ ok: true, data: "late", text: "late" });
            }
            await Bun.sleep(10);
            return JSON.stringify({ ok: true, data: { name: parsed.name }, text: parsed.name });
          },
        };
      },
    );
    expect(outcome.result).toEqual([
      { ok: true, data: { name: "fast1" }, text: "fast1" },
      {
        ok: false,
        error: { code: "TIMEOUT", message: 'Tool call "slow" timed out after 80ms' },
      },
      { ok: true, data: { name: "fast2" }, text: "fast2" },
    ]);
  } finally {
    releaseSlow.resolve();
  }
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
