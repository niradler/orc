import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatThread } from "@orc/core/chat";
import { resetConfig, updateGlobalConfig } from "@orc/core/config";
import type { SessionStatus } from "@orc/core/session-messages";
import { AuditLog } from "@orc/db/audit";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { setSpecHome } from "api-spec-cli";
import { coordinatorSessionId, ensureCoordinatorSession } from "../sessions/coordinator.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

const originalBase = process.env.ORC_API_BASE;
const originalSecret = process.env.ORC_API_SECRET;
const originalMock = process.env.ORC_E2E_CHAT_MOCK;
const specHome = mkdtempSync(join(tmpdir(), "orc-coordinator-spec-"));
const repo = mkdtempSync(join(tmpdir(), "orc-coordinator-repo-"));
const connections: Client[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  setSpecHome(specHome);
  process.env.ORC_E2E_CHAT_MOCK = "1";
  const app = setupTestApp();
  updateGlobalConfig((raw) => {
    raw.preferences = { chat: { agent: "claude", model: "fixture", autoApprove: false } };
  });
  getSqlite()
    .query("INSERT INTO projects (id, name, status, scope) VALUES (?, ?, 'active', ?)")
    .run("proj-coord", "coord-scope", repo);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  process.env.ORC_API_BASE = `http://127.0.0.1:${server.port}`;
  resetConfig();
});

afterAll(async () => {
  for (const connection of connections) await connection.close().catch(() => {});
  await server.stop(true);
  if (originalBase === undefined) delete process.env.ORC_API_BASE;
  else process.env.ORC_API_BASE = originalBase;
  if (originalSecret === undefined) delete process.env.ORC_API_SECRET;
  else process.env.ORC_API_SECRET = originalSecret;
  if (originalMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
  else process.env.ORC_E2E_CHAT_MOCK = originalMock;
  teardownTestApp();
  setSpecHome(undefined);
  rmSync(specHome, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function connect(
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<Client> {
  const client = new Client({ name: "coordinator-demo", version: "1" });
  const url = new URL(`${process.env.ORC_API_BASE}/mcp`);
  url.searchParams.set("mode", "full");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer test-secret", ...headers } },
    }),
  );
  connections.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ data: Record<string, unknown>; isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* Plain-text tool results stay in text. */
  }
  return { data, isError: result.isError === true, text };
}

const thread = (id: string): ChatThread | null => new ChatStore(getSqlite()).get(id);

async function statusUntil(
  client: Client,
  id: string,
  want: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const { data } = await call(client, "session_status", { session_id: id });
    if (data.status === want) return data;
    await Bun.sleep(20);
  }
  throw new Error(`Session ${id} never reached ${want}`);
}

describe("MCP coordinator identity", () => {
  test("an unbound authenticated client can start, wait, read and stop a child", async () => {
    const client = await connect({ client: "grok-bot" });
    const start = await call(client, "session_start", {
      prompt: "Reply with exactly: coordinator child ok",
      workspace: "same",
    });
    expect(start.isError).toBe(false);
    const childId = start.data.session_id as string;
    const coordinatorId = start.data.coordinator_session_id as string;
    expect(childId).toBeTruthy();
    expect(coordinatorId).toBe(coordinatorSessionId("grok-bot"));
    expect(start.data.parent_session_id).toBe(coordinatorId);
    expect(start.data.defaults).toEqual({
      agent: "claude",
      model: "fixture",
      provider_id: "claude",
    });
    // Coordinators have no live turn; notifications default off so notes do not pile up.
    expect(thread(childId)?.spawnedBy?.notify).toBe(false);
    expect(thread(coordinatorId)?.title).toBe("MCP coordinator (grok-bot)");

    const wait = await call(client, "session_wait", {
      session_id: childId,
      until: "idle",
      timeout_s: 15,
    });
    expect(wait.isError).toBe(false);
    expect(wait.data.status).toBe("idle");
    expect(wait.data.last_message).toBe("coordinator child ok");
    expect(wait.data.timed_out).toBe(false);

    const read = await call(client, "session_read", { id: childId });
    expect(read.isError).toBe(false);
    expect(read.data.source).toBe("live-chat");
    expect(read.text).toContain("coordinator child ok");

    const stop = await call(client, "session_stop", { session_id: childId });
    expect(stop.isError).toBe(false);
    expect(stop.data.session_id).toBe(childId);

    // A running child stops through the same ownership rules as any spawned session.
    const held = await call(client, "session_start", { prompt: "hold after 8000ms" });
    const heldId = held.data.session_id as string;
    await statusUntil(client, heldId, "running");
    const stopped = await call(client, "session_stop", { session_id: heldId });
    expect(stopped.isError).toBe(false);
    // The turn drains asynchronously; status stays running until it does.
    expect((await statusUntil(client, heldId, "stopped")).status).toBe("stopped");
  });

  test("a Settings default-agent change reaches children of an existing coordinator", async () => {
    const client = await connect({ client: "default-shift" });
    const coordinatorId = coordinatorSessionId("default-shift");
    const first = await call(client, "session_start", {
      prompt: "Reply with exactly: default shift one",
    });
    expect(first.isError).toBe(false);
    expect(first.data.defaults).toEqual({
      agent: "claude",
      model: "fixture",
      provider_id: "claude",
    });
    expect(thread(first.data.session_id as string)?.config.agent).toBe("claude");
    await call(client, "session_wait", { session_id: first.data.session_id, timeout_s: 15 });

    updateGlobalConfig((raw) => {
      raw.preferences = { chat: { agent: "codex", model: "fixture2", autoApprove: false } };
    });
    try {
      const second = await call(client, "session_start", {
        prompt: "Reply with exactly: default shift two",
      });
      expect(second.isError).toBe(false);
      expect(second.data.defaults).toEqual({
        agent: "codex",
        model: "fixture2",
        provider_id: "codex",
      });
      // The reused coordinator is refreshed from live Settings before the child
      // spawns, so the effective inheritance matches the reported defaults.
      const childId = second.data.session_id as string;
      expect(thread(childId)?.config.agent).toBe("codex");
      expect(thread(childId)?.config.model).toBe("fixture2");
      expect(thread(coordinatorId)?.config.agent).toBe("codex");
      const wait = await call(client, "session_wait", { session_id: childId, timeout_s: 15 });
      expect(wait.data.last_message).toBe("default shift two");
    } finally {
      updateGlobalConfig((raw) => {
        raw.preferences = { chat: { agent: "claude", model: "fixture", autoApprove: false } };
      });
    }
  });

  test("the coordinator is reused per client name, distinct across clients, and listed", async () => {
    const grok = await connect({ client: "grok-bot" });
    const first = await call(grok, "session_list");
    expect(first.isError).toBe(false);
    expect(first.data.coordinator_session_id).toBe(coordinatorSessionId("grok-bot"));
    expect((first.data.sessions as SessionStatus[]).length).toBeGreaterThanOrEqual(2);

    const again = await connect({ client: "grok-bot" });
    expect((await call(again, "session_list")).data.coordinator_session_id).toBe(
      coordinatorSessionId("grok-bot"),
    );

    const other = await connect({ client: "other-bot" });
    const otherList = await call(other, "session_list");
    expect(otherList.data.coordinator_session_id).toBe(coordinatorSessionId("other-bot"));
    expect(otherList.data.sessions).toEqual([]);

    // Unnamed clients share the default coordinator; header naming works too.
    const unnamed = await connect();
    expect((await call(unnamed, "session_list")).data.coordinator_session_id).toBe(
      coordinatorSessionId("mcp"),
    );
    const headerNamed = await connect({}, { "X-ORC-Actor-Name": "Grok Bot" });
    expect((await call(headerNamed, "session_list")).data.coordinator_session_id).toBe(
      coordinatorSessionId("grok-bot"),
    );

    // Meta discovery reaches the same coordinator identity through tool_invoke.
    const meta = new Client({ name: "coordinator-meta", version: "1" });
    const url = new URL(`${process.env.ORC_API_BASE}/mcp?mode=meta&client=grok-bot`);
    await meta.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer test-secret" } },
      }),
    );
    connections.push(meta);
    const invoked = await meta.callTool({
      name: "tool_invoke",
      arguments: { name: "session_list", arguments: {} },
    });
    expect(JSON.stringify(invoked.content)).toContain(coordinatorSessionId("grok-bot"));
  });

  test("bound ?session= and X-ORC-Session clients behave exactly as before", async () => {
    const coordinator = await connect({ client: "bound-parent" });
    const start = await call(coordinator, "session_start", {
      prompt: "Reply with exactly: bound parent",
    });
    const parentId = start.data.session_id as string;
    await call(coordinator, "session_wait", { session_id: parentId, timeout_s: 15 });

    const bound = await connect({ session: parentId });
    const child = await call(bound, "session_start", { prompt: "Reply with exactly: bound child" });
    expect(child.isError).toBe(false);
    expect(child.data.parent_session_id).toBe(parentId);
    expect(child.data.coordinator_session_id).toBeUndefined();
    expect(child.data.defaults).toBeUndefined();
    expect(thread(child.data.session_id as string)?.spawnedBy?.notify).toBe(true);
    const boundList = await call(bound, "session_list");
    expect(boundList.data.coordinator_session_id).toBeUndefined();
    expect((boundList.data.sessions as SessionStatus[]).map((s) => s.session_id)).toContain(
      child.data.session_id as string,
    );

    const headerBound = await connect({}, { "X-ORC-Session": parentId });
    const headerList = await call(headerBound, "session_list");
    expect(headerList.data.coordinator_session_id).toBeUndefined();
    expect((headerList.data.sessions as SessionStatus[]).map((s) => s.session_id)).toContain(
      child.data.session_id as string,
    );

    // speak stays limited to explicitly bound conversations.
    expect((await bound.listTools()).tools.map((t) => t.name)).toContain("speak");
    expect((await coordinator.listTools()).tools.map((t) => t.name)).not.toContain("speak");
    const speak = await call(coordinator, "speak", { text: "not a conversation" });
    expect(speak.isError).toBe(true);
    expect(speak.text).toContain("needs the calling conversation");
  });

  test("a project-scoped coordinator owns the project folder and spawns inside it", async () => {
    const client = await connect({ project: "coord-scope", client: "scoped-bot" });
    const list = await call(client, "session_list");
    const coordinatorId = list.data.coordinator_session_id as string;
    const coordinator = thread(coordinatorId);
    expect(coordinator?.projectId).toBe("proj-coord");
    expect(coordinator?.cwd).toBe(repo);
    const start = await call(client, "session_start", {
      prompt: "Reply with exactly: scoped child",
      workspace: "same",
    });
    expect(start.isError).toBe(false);
    expect(start.data.project_id).toBe("proj-coord");
    expect(thread(start.data.session_id as string)?.cwd).toBe(repo);
    await call(client, "session_wait", { session_id: start.data.session_id, timeout_s: 15 });
  });

  test("coordinator creation is audited with the client name", async () => {
    const entries = new AuditLog(getSqlite()).list({ entityType: "session", limit: 100 });
    const created = entries.filter((entry) => entry.action === "session.coordinator");
    expect(created.length).toBeGreaterThanOrEqual(1);
    const grok = created.find((entry) => entry.actor === "grok-bot");
    expect(grok?.session_id).toBe(coordinatorSessionId("grok-bot"));
    expect(grok?.snapshot).toMatchObject({ client: "grok-bot", transport: "mcp-http" });
    // Reuse does not re-audit: one entry per coordinator, not per request.
    expect(created.filter((entry) => entry.actor === "grok-bot")).toHaveLength(1);
  });

  test("unauthenticated calls are rejected and anonymous installs keep the identity requirement", async () => {
    const url = new URL(`${process.env.ORC_API_BASE}/mcp?mode=full&client=anon`);
    const anonymous = new Client({ name: "no-auth", version: "1" });
    await expect(anonymous.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();

    process.env.ORC_API_SECRET = "";
    resetConfig();
    try {
      const open = await connect({ client: "anon" });
      const start = await call(open, "session_start", { prompt: "should not start" });
      expect(start.isError).toBe(true);
      expect(start.text).toContain("needs the calling session identity");
      expect(thread(coordinatorSessionId("anon"))).toBeNull();
      expect((await open.listTools()).tools.map((t) => t.name)).not.toContain("speak");
    } finally {
      process.env.ORC_API_SECRET = originalSecret ?? "test-secret";
      resetConfig();
    }
  });

  test("ensureCoordinatorSession reuses one thread and never clobbers it", () => {
    const first = ensureCoordinatorSession({ client: "unit-check" });
    first.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content: "kept",
      timestamp: Date.now(),
    });
    new ChatStore(getSqlite()).save(first);
    const second = ensureCoordinatorSession({ client: "unit-check" });
    expect(second.id).toBe(first.id);
    expect(second.messages).toHaveLength(1);
    expect(coordinatorSessionId("Unit Check!")).toBe(coordinatorSessionId("unit-check"));
    expect(thread(coordinatorSessionId("unit-check"))?.cwd).toBe(homedir());
  });
});
