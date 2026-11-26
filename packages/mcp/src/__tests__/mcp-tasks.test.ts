import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolRequest, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { clampTaskTtl, MCP_TASK_MAX_TTL_MS, McpTaskStore } from "@orc/db/mcp-tasks";
import { maybeAugmentCallTool, TASKS_EXTENSION_ID } from "../mcp-tasks.js";
import type { ToolResult } from "../meta-tools.js";
import { createMcpServer } from "../server.js";

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  createTestDb();
  getSqlite().exec("INSERT INTO projects(id,name) VALUES ('alpha','Alpha')");
});

afterAll(() => {
  closeDb();
  resetConfig();
  delete process.env.ORC_DB_PATH;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

async function connectClient(options: Parameters<typeof createMcpServer>[0] = {}) {
  const server = createMcpServer({ mode: "full", ...options });
  const client = new Client({ name: "task-test", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function request(client: Client, method: string, params: Record<string, unknown> = {}) {
  return client.request({ method, params }, ResultSchema);
}

const okResult: ToolResult = { content: [{ type: "text", text: "ok" }] };

function v1Request(name = "project_list"): CallToolRequest {
  return { method: "tools/call", params: { name, arguments: {}, task: {} } };
}

function v2Request(name: string): CallToolRequest {
  return {
    method: "tools/call",
    params: {
      name,
      arguments: {},
      _meta: {
        [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } },
      },
    },
  };
}

describe("MCP Tasks: capability advertisement", () => {
  test("server declares tasks and the tasks extension", async () => {
    const { client, server } = await connectClient();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tasks?.requests?.tools?.call).toBeDefined();
    expect(capabilities?.extensions?.[TASKS_EXTENSION_ID]).toEqual({});
    await client.close();
    await server.close();
  });
});

describe("MCP Tasks: augmentation logic (controllable execution)", () => {
  test("v1 returns a durable handle immediately and stores the result on completion", async () => {
    const store = new McpTaskStore(getSqlite());
    const d = deferred<ToolResult>();
    const handle = maybeAugmentCallTool(v1Request(), () => d.promise, {
      owner: "global",
      eligibleTools: new Set(),
      store,
    });
    expect(handle).not.toBeNull();
    if (!handle || !("task" in handle)) throw new Error("expected v1 handle");
    const taskId = handle.task.taskId;
    expect(handle.task.status).toBe("working");
    expect(store.get(taskId, "global")?.status).toBe("working");
    d.resolve(okResult);
    await waitFor(() => store.get(taskId, "global")?.status === "completed");
    expect(JSON.parse(store.get(taskId, "global")?.result ?? "{}")).toEqual(okResult);
  });

  test("v2 requires opt-in plus an eligible tool; otherwise runs synchronously", () => {
    const store = new McpTaskStore(getSqlite());
    const opts = { owner: "global", eligibleTools: new Set(["session_wait"]), store };
    // Opted in but tool not eligible → null.
    expect(maybeAugmentCallTool(v2Request("project_list"), async () => okResult, opts)).toBeNull();
    // Eligible tool but no opt-in → null.
    expect(
      maybeAugmentCallTool(v1Request("session_wait"), async () => okResult, opts),
    ).not.toBeNull();
    const noOptIn: CallToolRequest = { method: "tools/call", params: { name: "session_wait" } };
    expect(maybeAugmentCallTool(noOptIn, async () => okResult, opts)).toBeNull();
    // Opted in and eligible → v2 handle.
    const handle = maybeAugmentCallTool(v2Request("session_wait"), async () => okResult, opts);
    expect(handle).not.toBeNull();
    if (!handle || !("resultType" in handle)) throw new Error("expected v2 handle");
    expect(handle.resultType).toBe("task");
    expect(handle.status).toBe("working");
  });

  test("a failed execution stores a failed task with the error", async () => {
    const store = new McpTaskStore(getSqlite());
    const handle = maybeAugmentCallTool(
      v1Request(),
      async () => {
        throw new Error("boom");
      },
      { owner: "global", eligibleTools: new Set(), store },
    );
    if (!handle || !("task" in handle)) throw new Error("expected v1 handle");
    const taskId = handle.task.taskId;
    await waitFor(() => store.get(taskId, "global")?.status === "failed");
    const row = store.get(taskId, "global");
    expect(JSON.parse(row?.error ?? "{}").message).toBe("boom");
  });
});

describe("MCP Tasks: protocol (v1, SDK 2025-11-25)", () => {
  test("tools/call with params.task returns a handle; tasks/get and tasks/result deliver the payload", async () => {
    const { client, server } = await connectClient();
    const created = (await request(client, "tools/call", {
      name: "project_list",
      arguments: {},
      task: {},
    })) as { task: { taskId: string; status: string } };
    expect(created.task.taskId).toBeTruthy();
    const taskId = created.task.taskId;
    let status = "";
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const got = (await request(client, "tasks/get", { taskId })) as { status: string };
      status = got.status;
      if (status === "completed") break;
      await Bun.sleep(10);
    }
    expect(status).toBe("completed");
    const payload = (await request(client, "tasks/result", { taskId })) as {
      content: { type: string; text: string }[];
    };
    expect(Array.isArray(payload.content)).toBe(true);
    await client.close();
    await server.close();
  });

  test("tasks/list includes the task; unknown tasks fail with -32602", async () => {
    const { client, server } = await connectClient();
    const created = (await request(client, "tools/call", {
      name: "project_list",
      arguments: {},
      task: {},
    })) as { task: { taskId: string } };
    const listed = (await request(client, "tasks/list")) as { tasks: { taskId: string }[] };
    expect(listed.tasks.some((t) => t.taskId === created.task.taskId)).toBe(true);
    const error = await request(client, "tasks/get", { taskId: "no-such-task" }).catch(
      (e: unknown) => e,
    );
    expect((error as { code?: number }).code).toBe(-32602);
    for (const cursor of ["not-a-number", "5abc", "-1"]) {
      const badCursor = await request(client, "tasks/list", { cursor }).catch((e: unknown) => e);
      expect((badCursor as { code?: number }).code).toBe(-32602);
    }
    await client.close();
    await server.close();
  });

  test("a task survives disconnect and is pollable from a fresh connection", async () => {
    const first = await connectClient();
    const created = (await request(first.client, "tools/call", {
      name: "project_list",
      arguments: {},
      task: {},
    })) as { task: { taskId: string } };
    const taskId = created.task.taskId;
    await first.client.close();
    await first.server.close();

    const second = await connectClient();
    let status = "";
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const got = (await request(second.client, "tasks/get", { taskId })) as { status: string };
      status = got.status;
      if (status === "completed") break;
      await Bun.sleep(10);
    }
    expect(status).toBe("completed");
    await second.client.close();
    await second.server.close();
  });

  test("cancelling a working task aborts it and discards a late result", async () => {
    const store = new McpTaskStore(getSqlite());
    const d = deferred<ToolResult>();
    let aborted = false;
    const handle = maybeAugmentCallTool(
      v1Request(),
      (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return d.promise;
      },
      { owner: "global", eligibleTools: new Set(), store },
    );
    if (!handle || !("task" in handle)) throw new Error("expected v1 handle");
    const taskId = handle.task.taskId;
    const { client, server } = await connectClient();
    const cancelled = (await request(client, "tasks/cancel", { taskId })) as {
      taskId: string;
      status: string;
    };
    expect(aborted).toBe(true);
    expect(cancelled.status).toBe("cancelled");
    d.resolve(okResult);
    await Bun.sleep(30);
    expect(store.get(taskId, "global")?.status).toBe("cancelled");
    // Terminal v1 tasks cannot be cancelled again.
    const error = await request(client, "tasks/cancel", { taskId }).catch((e: unknown) => e);
    expect((error as { code?: number }).code).toBe(-32602);
    const payloadError = await request(client, "tasks/result", { taskId }).catch((e: unknown) => e);
    expect((payloadError as { code?: number }).code).toBe(-32602);
    await client.close();
    await server.close();
  });

  test("TTL clamps unlimited requests and prunes expired terminal tasks; failOrphans marks in-flight tasks failed", async () => {
    expect(clampTaskTtl(null)).toBe(MCP_TASK_MAX_TTL_MS);
    const store = new McpTaskStore(getSqlite());
    const expired = store.create({ flavor: "v1", owner: "global", toolName: "project_list" });
    store.complete(expired.task_id, okResult);
    getSqlite()
      .query("UPDATE mcp_tasks SET terminal_at=? WHERE task_id=?")
      .run(Date.now() - MCP_TASK_MAX_TTL_MS - 10_000, expired.task_id);
    const { client, server } = await connectClient();
    const gone = await request(client, "tasks/get", { taskId: expired.task_id }).catch(
      (e: unknown) => e,
    );
    expect((gone as { code?: number }).code).toBe(-32602);

    const orphan = store.create({ flavor: "v1", owner: "global", toolName: "session_wait" });
    expect(store.failOrphans()).toBeGreaterThanOrEqual(1);
    const failed = (await request(client, "tasks/get", { taskId: orphan.task_id })) as {
      status: string;
      statusMessage?: string;
    };
    expect(failed.status).toBe("failed");
    expect(failed.statusMessage).toContain("restarted");
    await client.close();
    await server.close();
  });
});

describe("MCP Tasks: protocol (v2, io.modelcontextprotocol/tasks)", () => {
  test("opted-in eligible tool returns resultType:task; tasks/get carries the result inline", async () => {
    const { client, server } = await connectClient({ mode: "meta" });
    const created = (await request(client, "tools/call", {
      name: "tool_execute",
      arguments: { code: "return 1" },
      _meta: {
        [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } },
      },
    })) as { resultType: string; taskId: string; status: string };
    expect(created.resultType).toBe("task");
    expect(created.status).toBe("working");
    const taskId = created.taskId;
    let got: { status: string; result?: unknown; resultType?: string } | undefined;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      got = (await request(client, "tasks/get", { taskId })) as typeof got;
      if (got?.status === "completed" || got?.status === "failed") break;
      await Bun.sleep(20);
    }
    expect(got?.status).toBe("completed");
    expect(got?.resultType).toBe("complete");
    expect(got?.result).toBeDefined();
    await client.close();
    await server.close();
  });

  test("tasks/cancel acks with resultType:complete; tasks/update acks", async () => {
    const store = new McpTaskStore(getSqlite());
    const d = deferred<ToolResult>();
    const handle = maybeAugmentCallTool(v2Request("session_wait"), () => d.promise, {
      owner: "global",
      eligibleTools: new Set(["session_wait"]),
      store,
    });
    if (!handle || !("resultType" in handle)) throw new Error("expected v2 handle");
    const taskId = handle.taskId;
    const { client, server } = await connectClient();
    const cancelled = (await request(client, "tasks/cancel", { taskId })) as {
      resultType: string;
    };
    expect(cancelled.resultType).toBe("complete");
    expect(store.get(taskId, "global")?.status).toBe("cancelled");
    const updated = (await request(client, "tasks/update", {
      taskId,
      inputResponses: {},
    })) as { resultType: string };
    expect(updated.resultType).toBe("complete");
    d.resolve(okResult);
    await client.close();
    await server.close();
  });

  test("tasks/update records answers for outstanding input requests", async () => {
    const store = new McpTaskStore(getSqlite());
    const d = deferred<ToolResult>();
    const handle = maybeAugmentCallTool(v2Request("session_wait"), () => d.promise, {
      owner: "global",
      eligibleTools: new Set(["session_wait"]),
      store,
    });
    if (!handle || !("resultType" in handle)) throw new Error("expected v2 handle");
    const taskId = handle.taskId;
    store.setInputRequests(taskId, {
      q1: { method: "elicitation/create", params: { message: "Pick", requestedSchema: {} } },
    });
    const { client, server } = await connectClient();
    const got = (await request(client, "tasks/get", { taskId })) as {
      status: string;
      inputRequests: Record<string, unknown>;
    };
    expect(got.status).toBe("input_required");
    expect(got.inputRequests.q1).toBeDefined();
    await request(client, "tasks/update", {
      taskId,
      inputResponses: { q1: { action: "accept", content: { choice: "a" } }, unknown: {} },
    });
    const row = store.get(taskId, "global");
    const responses = JSON.parse(row?.input_responses ?? "{}");
    expect(responses.q1.action).toBe("accept");
    expect(responses.unknown).toBeUndefined();
    d.resolve(okResult);
    await client.close();
    await server.close();
  });
});

describe("MCP Tasks: owner isolation", () => {
  test("a scoped connection cannot read a global task", async () => {
    const global = await connectClient();
    const created = (await request(global.client, "tools/call", {
      name: "project_list",
      arguments: {},
      task: {},
    })) as { task: { taskId: string } };
    await global.client.close();
    await global.server.close();

    const scoped = await connectClient({ project: "Alpha" });
    const error = await request(scoped.client, "tasks/get", {
      taskId: created.task.taskId,
    }).catch((e: unknown) => e);
    expect((error as { code?: number }).code).toBe(-32602);
    await scoped.client.close();
    await scoped.server.close();
  });
});
