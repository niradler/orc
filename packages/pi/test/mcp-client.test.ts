import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  GetTaskResultSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { OrcMcpClient } from "../src/mcp-client.js";

const NOW = "2026-01-01T00:00:00.000Z";
const task = (taskId: string, status: string) => ({
  taskId,
  status,
  ttl: 60_000,
  createdAt: NOW,
  lastUpdatedAt: NOW,
});
const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

type FakeOptions = {
  skills?: boolean;
  tamperSkillBody?: boolean;
  multiPartSkillBody?: boolean;
  taskPollsToComplete?: number;
};

const SKILL_BODY = "# orc-tasks body";
const SKILL_BYTES = Buffer.from(SKILL_BODY, "utf8");
const SKILL_DIGEST = `sha256:${createHash("sha256").update(SKILL_BYTES).digest("hex")}`;
const BIN_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const BIN_BASE64 = BIN_BYTES.toString("base64");
const BIN_DIGEST = `sha256:${createHash("sha256").update(BIN_BYTES).digest("hex")}`;

async function fakeServer(options: FakeOptions = {}) {
  const polls = new Map<string, number>();
  const cancelled: string[] = [];
  const requests: string[] = [];
  const invokedArgs: unknown[] = [];
  const capabilities = {
    tools: {},
    resources: {},
    tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    ...(options.skills ? { extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } } } : {}),
  };
  const server = new Server({ name: "fake-orc", version: "0.0.1" }, { capabilities });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    requests.push(`tools/call:${request.params.name}`);
    if (!request.params.task) {
      const inner = request.params.arguments as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      invokedArgs.push(inner);
      const projectSuffix = inner.arguments?.project ? ` (${String(inner.arguments.project)})` : "";
      const text =
        inner.name === "skill_list"
          ? `- legacy-skill: from tool${projectSuffix}`
          : inner.name === "skill_read"
            ? `# Legacy skill body${projectSuffix}`
            : "sync result";
      return { content: [{ type: "text", text }] };
    }
    return { task: task("task-1", "working") };
  });
  server.setRequestHandler(GetTaskRequestSchema, async (request) => {
    requests.push(`tasks/get:${request.params.taskId}`);
    const count = (polls.get(request.params.taskId) ?? 0) + 1;
    polls.set(request.params.taskId, count);
    if (cancelled.includes(request.params.taskId)) return task(request.params.taskId, "cancelled");
    const done = count >= (options.taskPollsToComplete ?? 2);
    return task(request.params.taskId, done ? "completed" : "working");
  });
  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => ({
    content: [{ type: "text", text: `result of ${request.params.taskId}` }],
  }));
  server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    cancelled.push(request.params.taskId);
    return task(request.params.taskId, "cancelled");
  });
  if (options.skills) {
    const skillEntry = {
      uri: "skill://orc-tasks/SKILL.md",
      frontmatter: { name: "orc-tasks", description: "Durable tasks" },
      resources: [
        {
          uri: "skill://orc-tasks/SKILL.md",
          digest: SKILL_DIGEST,
          size: SKILL_BYTES.length,
        },
        {
          uri: "skill://orc-tasks/assets/icon.png",
          digest: BIN_DIGEST,
          size: BIN_BYTES.length,
        },
      ],
    };
    server.setRequestHandler(
      z.object({
        method: z.literal("skills/list"),
        params: z.object({ cursor: z.string().optional() }).optional(),
      }),
      async () => ({ skills: [skillEntry] }),
    );
    server.setRequestHandler(
      z.object({
        method: z.literal("skills/get"),
        params: z.object({ uri: z.string() }),
      }),
      async () => ({ skill: skillEntry }),
    );
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri.endsWith("icon.png")) {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: "application/octet-stream",
              blob: BIN_BASE64,
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/markdown",
            text: options.tamperSkillBody ? "# tampered body" : SKILL_BODY,
          },
          ...(options.multiPartSkillBody
            ? [{ uri: request.params.uri, mimeType: "text/markdown", text: "# injected" }]
            : []),
        ],
      };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server, requests, cancelled, invokedArgs };
}

function orcClient(client: Client): OrcMcpClient {
  return new OrcMcpClient(
    { apiBase: "http://127.0.0.1:1", transport: "http", command: "orc", timeoutMs: 5000 },
    "session-1",
    process.cwd(),
    undefined,
    { client: async () => client },
  );
}

describe("OrcMcpClient tasks", () => {
  test("callTask returns a handle and waitForTask polls tasks/get then tasks/result", async () => {
    const fake = await fakeServer({ taskPollsToComplete: 3 });
    const orc = orcClient(fake.client);
    const handle = await orc.callTask("job_run", { job: "nightly" }, { ttlMs: 60_000 });
    expect(handle.taskId).toBe("task-1");
    expect(handle.status).toBe("working");

    const result = await orc.waitForTask("task-1", { pollMs: 1, timeoutMs: 5000 });
    expect(result.text).toBe("result of task-1");
    expect(result.isError).toBe(false);
    expect(fake.requests.filter((item) => item.startsWith("tasks/get:"))).toHaveLength(3);
    await fake.client.close();
    await fake.server.close();
  });

  test("cancelTask sends tasks/cancel", async () => {
    const fake = await fakeServer();
    const orc = orcClient(fake.client);
    await orc.cancelTask("task-9");
    expect(fake.cancelled).toEqual(["task-9"]);
    await fake.client.close();
    await fake.server.close();
  });

  test("callAndWait runs the full lifecycle", async () => {
    const fake = await fakeServer({ taskPollsToComplete: 1 });
    const orc = orcClient(fake.client);
    const result = await orc.callAndWait("session_wait", {}, { pollMs: 1 });
    expect(result.text).toBe("result of task-1");
    await fake.client.close();
    await fake.server.close();
  });

  test("callTask forwards tool_execute directly and waitForTask aborts promptly on signal", async () => {
    const fake = await fakeServer({ taskPollsToComplete: 50 });
    const orc = orcClient(fake.client);
    await orc.callTask("tool_execute", { code: "return 1" });
    expect(fake.requests).toContain("tools/call:tool_execute");

    const controller = new AbortController();
    const started = Date.now();
    const waiting = orc.waitForTask("task-1", { pollMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(waiting).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(400);
    await fake.client.close();
    await fake.server.close();
  });
});

describe("OrcMcpClient skills", () => {
  test("uses skills/list and resources/read when the extension is advertised", async () => {
    const fake = await fakeServer({ skills: true });
    const orc = orcClient(fake.client);
    expect(await orc.hasSkillsExtension()).toBe(true);

    const list = await orc.listSkills({ limit: 10 });
    expect(list.text).toBe("- orc-tasks: Durable tasks");

    const read = await orc.readSkill("orc-tasks");
    expect(read.text).toBe("# orc-tasks body");
    const bin = await orc.readSkill("orc-tasks", { ref: "assets/icon.png" });
    expect(bin.text).toContain("binary resource");
    expect(bin.text).toContain("4 bytes");
    expect(fake.requests).not.toContain("tools/call:tool_invoke");

    const projectList = await orc.listSkills({ project: "alpha" });
    expect(projectList.text).toContain("(alpha)");
    const projectRead = await orc.readSkill("proj-skill", { project: "alpha" });
    expect(projectRead.text).toContain("(alpha)");
    expect(fake.invokedArgs).toContainEqual({
      name: "skill_list",
      arguments: { project: "alpha", limit: 20 },
    });
    expect(fake.invokedArgs).toContainEqual({
      name: "skill_read",
      arguments: { project: "alpha", name: "proj-skill" },
    });
    await fake.client.close();
    await fake.server.close();
  });

  test("readSkill fails closed when served bytes do not match manifest digest", async () => {
    const fake = await fakeServer({ skills: true, tamperSkillBody: true });
    const orc = orcClient(fake.client);
    await expect(orc.readSkill("orc-tasks")).rejects.toThrow("integrity check");
    await fake.client.close();
    await fake.server.close();
  });

  test("readSkill fails closed when resources/read returns multiple content parts", async () => {
    const fake = await fakeServer({ skills: true, multiPartSkillBody: true });
    const orc = orcClient(fake.client);
    await expect(orc.readSkill("orc-tasks")).rejects.toThrow("Unexpected skill resource response");
    await fake.client.close();
    await fake.server.close();
  });

  test("falls back to skill_list/skill_read tools without the extension", async () => {
    const fake = await fakeServer();
    const orc = orcClient(fake.client);
    expect(await orc.hasSkillsExtension()).toBe(false);

    const list = await orc.listSkills();
    expect(list.text).toBe("- legacy-skill: from tool");
    const read = await orc.readSkill("legacy-skill");
    expect(read.text).toBe("# Legacy skill body");
    expect(fake.requests).toContain("tools/call:tool_invoke");
    await fake.client.close();
    await fake.server.close();
  });
});

test("CallToolResultSchema stays compatible with task payloads", () => {
  expect(CallToolResultSchema.parse({ content: [{ type: "text", text: "x" }] })).toBeTruthy();
  expect(GetTaskResultSchema.parse(task("t", "working")).status).toBe("working");
});
