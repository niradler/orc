import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatThread } from "@orc/core/chat";
import { resetConfig, updateGlobalConfig } from "@orc/core/config";
import type { SessionStatus } from "@orc/core/session-messages";
import { AuditLog } from "@orc/db/audit";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import { setSpecHome } from "api-spec-cli";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { invalidateProjectFolderCache } from "../sessions/common.js";
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
    expect(read.data.source).toBe("live");
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

  test("session_delete hides a stopped child without losing its transcript", async () => {
    const client = await connect({ client: "cleanup-bot" });
    const listed = async (args: Record<string, unknown> = {}) =>
      (
        (await call(client, "session_list", { scope: "children", ...args })).data
          .sessions as SessionStatus[]
      ).map((session) => session.session_id);

    const finished = await call(client, "session_start", {
      prompt: "Reply with exactly: cleanup child",
    });
    const finishedId = finished.data.session_id as string;
    await call(client, "session_wait", { session_id: finishedId, timeout_s: 15 });
    expect(await listed()).toContain(finishedId);

    const hidden = await call(client, "session_delete", { session_id: finishedId });
    expect(hidden.isError).toBe(false);
    expect(hidden.data.hidden).toBe(true);
    expect(await listed()).not.toContain(finishedId);
    expect(await listed({ include_hidden: true })).toContain(finishedId);
    // Hiding keeps the transcript readable by id.
    expect((await call(client, "session_read", { id: finishedId })).text).toContain(
      "cleanup child",
    );
    const restored = await call(client, "session_delete", {
      session_id: finishedId,
      restore: true,
    });
    expect(restored.data.hidden).toBe(false);
    expect(await listed()).toContain(finishedId);

    // A stopped child can be hidden the same way.
    const held = await call(client, "session_start", { prompt: "hold after 8000ms" });
    const heldId = held.data.session_id as string;
    await statusUntil(client, heldId, "running");
    await call(client, "session_stop", { session_id: heldId });
    await statusUntil(client, heldId, "stopped");
    expect((await call(client, "session_delete", { session_id: heldId })).data.hidden).toBe(true);
    expect(await listed()).not.toContain(heldId);
    expect(await listed({ include_hidden: true })).toContain(heldId);

    // Only the session that started it (or an ancestor) may hide it.
    const other = await connect({ client: "cleanup-other" });
    const forbidden = await call(other, "session_delete", { session_id: finishedId });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.text).toContain("Only a session or its ancestor");
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
    const otherList = await call(other, "session_list", { scope: "children" });
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
    });
    expect(start.isError).toBe(false);
    expect(start.data.project_id).toBe("proj-coord");
    expect(thread(start.data.session_id as string)?.cwd).toBe(repo);
    await call(client, "session_wait", { session_id: start.data.session_id, timeout_s: 15 });

    // The tool picks the folder and host per call instead of relying on the
    // connection scope: cwd overrides the project folder, host null stays local.
    const explicit = await call(client, "session_start", {
      prompt: "Reply with exactly: explicit folder",
      cwd: repo,
      host: null,
    });
    expect(explicit.isError).toBe(false);
    expect(thread(explicit.data.session_id as string)?.cwd).toBe(repo);
    expect(thread(explicit.data.session_id as string)?.host).toBeNull();
    await call(client, "session_wait", { session_id: explicit.data.session_id, timeout_s: 15 });
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

  test("ensureCoordinatorSession reuses one thread and never clobbers it", async () => {
    const first = await ensureCoordinatorSession({ client: "unit-check" });
    first.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content: "kept",
      timestamp: Date.now(),
    });
    new ChatStore(getSqlite()).save(first);
    const second = await ensureCoordinatorSession({ client: "unit-check" });
    expect(second.id).toBe(first.id);
    expect(second.messages).toHaveLength(1);
    expect(coordinatorSessionId("Unit Check!")).toBe(coordinatorSessionId("unit-check"));
    expect(thread(coordinatorSessionId("unit-check"))?.cwd).toBe(homedir());
  });

  test("a coordinator anchors children to the configured execution host", async () => {
    const previous = process.env.ORC_SSH_HOST;
    process.env.ORC_SSH_HOST = "lab";
    resetConfig();
    try {
      const remote = async () => ({ host: "lab", cwd: "/home/nir" });
      const created = await ensureCoordinatorSession({ client: "host-check" }, remote);
      expect(created.host).toBe("lab");
      expect(created.cwd).toBe("/home/nir");

      // Reuse keeps the anchor without probing the host again.
      let probes = 0;
      const reused = await ensureCoordinatorSession({ client: "host-check" }, async () => {
        probes += 1;
        return { host: "lab", cwd: "/home/nir" };
      });
      expect(reused.host).toBe("lab");
      expect(probes).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ORC_SSH_HOST;
      else process.env.ORC_SSH_HOST = previous;
      resetConfig();
    }
  });

  test("a coordinator left on the container filesystem is re-anchored to the configured host", async () => {
    const previous = process.env.ORC_SSH_HOST;
    process.env.ORC_SSH_HOST = "";
    resetConfig();
    try {
      const stale = await ensureCoordinatorSession({ client: "stale-bot" });
      expect(stale.host).toBeNull();
      expect(stale.cwd).toBe(homedir());

      process.env.ORC_SSH_HOST = "lab";
      resetConfig();
      const repaired = await ensureCoordinatorSession({ client: "stale-bot" }, async () => ({
        host: "lab",
        cwd: "/home/nir",
      }));
      expect(repaired.host).toBe("lab");
      expect(repaired.cwd).toBe("/home/nir");
      expect(thread(coordinatorSessionId("stale-bot"))?.host).toBe("lab");
    } finally {
      if (previous === undefined) delete process.env.ORC_SSH_HOST;
      else process.env.ORC_SSH_HOST = previous;
      resetConfig();
    }
  });

  test("unified session management: options, profile/effort start, cwd project resolution, update, paginated list, native read & auto-adopt", async () => {
    const secondRepo = mkdtempSync(join(tmpdir(), "orc-coordinator-repo2-"));
    const transcriptFile = join(secondRepo, "native-claude.jsonl");
    writeFileSync(
      transcriptFile,
      `${JSON.stringify({
        type: "user",
        timestamp: "2026-11-27T10:00:00.000Z",
        message: { role: "user", content: "Inspect native transcript" },
      })}\n${JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-27T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Native transcript reply ok" }],
        },
      })}\n`,
    );
    const now = Date.now();
    getSqlite()
      .query(
        "INSERT OR REPLACE INTO projects (id, name, description, scope, status, created_at, updated_at) VALUES (?, ?, '', ?, 'active', ?, ?)",
      )
      .run("proj-second", "second-proj", secondRepo, now, now);
    invalidateProjectFolderCache();
    updateGlobalConfig((raw) => {
      raw.preferences = {
        chat: { agent: "claude", model: "fixture", autoApprove: false },
        composer_profiles: [
          {
            id: "fast-codex",
            name: "Fast Codex",
            agent: "codex",
            model: "fixture-fast",
            effort: "high",
          },
        ],
      };
    });
    try {
      const scoped = await connect({ project: "coord-scope", client: "unified-bot" });

      const optionsRes = await call(scoped, "session_options", { agent: "claude" });
      expect(optionsRes.isError).toBe(false);
      expect(optionsRes.data.defaults).toMatchObject({ agent: "claude", model: "fixture" });
      expect(optionsRes.data.profiles).toMatchObject([{ id: "fast-codex", name: "Fast Codex" }]);
      expect(optionsRes.data.agent).toBe("claude");
      expect(optionsRes.data.capabilities).toBeDefined();

      // Explicit cwd inside second-proj must resolve project_id to proj-second even on ?project=coord-scope.
      const started = await call(scoped, "session_start", {
        prompt: "Reply with exactly: profile child ok",
        profile: "Fast Codex",
        cwd: secondRepo,
        send_while_running: "steer",
      });
      expect(started.isError).toBe(false);
      const childId = started.data.session_id as string;
      expect(started.data.project_id).toBe("proj-second");
      const childThread = thread(childId);
      expect(childThread?.config.agent).toBe("codex");
      expect(childThread?.config.model).toBe("fixture-fast");
      expect(childThread?.config.sendWhileRunning).toBe("steer");
      expect(JSON.stringify(childThread?.config.agentOptions.codex)).toContain("high");
      await call(scoped, "session_wait", { session_id: childId, timeout_s: 15 });

      const updated = await call(scoped, "session_update", {
        session_id: childId,
        title: "Renamed Unified Child",
        model: "fixture-updated",
        effort: "medium",
        send_while_running: "queue",
      });
      expect(updated.isError).toBe(false);
      const afterUpdate = thread(childId);
      expect(afterUpdate?.title).toBe("Renamed Unified Child");
      expect(afterUpdate?.config.model).toBe("fixture-updated");
      expect(afterUpdate?.config.sendWhileRunning).toBe("queue");
      expect(JSON.stringify(afterUpdate?.config.agentOptions.codex)).toContain("medium");

      // Insert a stopped native gateway_sessions row in proj-second + a linked row for childId.
      const db = getDb();
      await db
        .insert(bridge_chats)
        .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: LIVE_CHAT_ID })
        .onConflictDoNothing();
      const ts = new Date(now + 1000);
      await db.insert(gateway_sessions).values([
        {
          id: "live-native-stopped",
          chat_id: LIVE_CHAT_ID,
          backend: "claude",
          mode: "direct",
          runtime_session_id: "native-claude-rt-1",
          project_id: "proj-second",
          cwd: secondRepo,
          status: "stopped",
          title: "Stopped Native Claude",
          summary: "Earlier native work",
          transcript_path: transcriptFile,
          created_at: ts,
          updated_at: ts,
          last_activity_at: ts,
        },
        {
          id: "live-linked-child",
          chat_id: LIVE_CHAT_ID,
          backend: "codex",
          mode: "direct",
          runtime_session_id: afterUpdate?.runtimeId ?? "mock-missing",
          project_id: "proj-second",
          cwd: secondRepo,
          status: "idle",
          title: "Duplicate native row for chat",
          created_at: ts,
          updated_at: ts,
          last_activity_at: ts,
        },
      ]);

      // Unified session_list merges chats + native, deduplicates linked rows, and paginates.
      const secondList = await call(scoped, "session_list", {
        project: "second-proj",
        limit: 1,
        offset: 0,
      });
      expect(secondList.isError).toBe(false);
      expect(secondList.data.total).toBe(2);
      expect(secondList.data.has_more).toBe(true);
      expect(secondList.data.next_offset).toBe(1);
      const page2 = await call(scoped, "session_list", {
        project: "second-proj",
        limit: 1,
        offset: 1,
      });
      expect(page2.data.has_more).toBe(false);
      expect(page2.data.next_offset).toBeNull();
      const allSecondIds = [
        ...(secondList.data.sessions as Array<{ session_id: string }>),
        ...(page2.data.sessions as Array<{ session_id: string }>),
      ].map((entry) => entry.session_id);
      expect(allSecondIds).toContain(childId);
      expect(allSecondIds).toContain("live-native-stopped");
      expect(allSecondIds).not.toContain("live-linked-child");

      // session_read falls back to /sessions/live/{id}/transcript for native sessions.
      const nativeRead = await call(scoped, "session_read", { id: "native-claude-rt-1" });
      expect(nativeRead.isError).toBe(false);
      expect(nativeRead.data.source).toBe("live");
      expect(nativeRead.text).toContain("Native transcript reply ok");

      // session_send targeting chat via its linked live_session_id resolves to the chat thread.
      const viaLive = await call(scoped, "session_send", {
        session_id: "live-linked-child",
        prompt: "Message via live id",
      });
      expect(viaLive.isError).toBe(false);
      expect(viaLive.data.target).toMatchObject({ session_id: childId, delivery: "chat" });

      // session_send targeting a stopped native session auto-adopts it into an ORC chat thread.
      const adoptedSend = await call(scoped, "session_send", {
        session_id: "native-claude-rt-1",
        prompt: "Resume native in chat",
      });
      expect(adoptedSend.isError).toBe(false);
      const adoptedTarget = adoptedSend.data.target as { session_id: string; delivery: string };
      expect(adoptedTarget.delivery).toBe("chat");
      expect(adoptedTarget.session_id).not.toBe("live-native-stopped");
      const adoptedThread = thread(adoptedTarget.session_id);
      expect(adoptedThread?.sourceId).toBe("live-native-stopped");
      expect(adoptedThread?.runtimeId).toBe("native-claude-rt-1");
    } finally {
      rmSync(secondRepo, { recursive: true, force: true });
      invalidateProjectFolderCache();
    }
  });

  test("session_update enforces ownership when hiding and removes hidden sessions from default session_list (#580)", async () => {
    const owner = await connect({ client: "hide-owner" });
    const outsider = await connect({ client: "hide-outsider" });
    const started = await call(owner, "session_start", {
      prompt: "Reply with exactly: hideable child",
    });
    expect(started.isError).toBe(false);
    const childId = started.data.session_id as string;
    await statusUntil(owner, childId, "idle");

    const denied = await call(outsider, "session_update", {
      session_id: childId,
      hidden: true,
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("Only a session or its ancestor");

    const hidden = await call(owner, "session_update", {
      session_id: childId,
      hidden: true,
    });
    expect(hidden.isError).toBe(false);
    expect(hidden.data.hidden).toBe(true);

    const defaultList = await call(owner, "session_list", { scope: "children" });
    expect(
      (defaultList.data.sessions as Array<{ session_id: string }>).some(
        (entry) => entry.session_id === childId,
      ),
    ).toBe(false);

    const withHidden = await call(owner, "session_list", {
      scope: "children",
      include_hidden: true,
    });
    expect(
      (withHidden.data.sessions as Array<{ session_id: string }>).some(
        (entry) => entry.session_id === childId,
      ),
    ).toBe(true);

    const stillReadable = await call(owner, "session_read", { id: childId });
    expect(stillReadable.isError).toBe(false);
    expect(stillReadable.text).toContain("hideable child");
  });

  test("session_start returns Settings defaults alongside the error on failure (#581)", async () => {
    const client = await connect({ client: "fail-defaults" });
    const failed = await call(client, "session_start", {
      prompt: "Will fail validation",
      profile: "nonexistent-profile",
    });
    expect(failed.isError).toBe(true);
    expect(failed.data.error).toContain("nonexistent-profile");
    expect(failed.data.coordinator_session_id).toBe(coordinatorSessionId("fail-defaults"));
    expect(failed.data.defaults).toEqual({
      agent: "claude",
      model: "fixture",
      provider_id: "claude",
    });
  });

  test("session_search filters by opencode and rejects unknown harnesses (#585)", async () => {
    const client = await connect({ client: "search-harness" });
    const ok = await call(client, "session_search", { q: "fixture", agent: "opencode" });
    expect(ok.isError).toBe(false);
    expect(Array.isArray(ok.data.sessions)).toBe(true);

    const bad = await call(client, "session_search", { q: "fixture", agent: "bogus-agent" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Invalid args");
  });

  test("session_start infers execution host from project configuration", async () => {
    const localRepo = mkdtempSync(join(tmpdir(), "orc-proj-host-local-"));
    getSqlite()
      .query(
        "INSERT OR REPLACE INTO projects (id, name, status, scope, host) VALUES (?, ?, 'active', ?, ?)",
      )
      .run("proj-local-host", "local-host-proj", localRepo, "local");
    invalidateProjectFolderCache();
    try {
      const client = await connect({ client: "proj-host-check" });
      const coord = await ensureCoordinatorSession({ client: "proj-host-check" });
      new ChatStore(getSqlite()).save({ ...coord, host: "some-ssh-box" });

      const started = await call(client, "session_start", {
        project: "local-host-proj",
        prompt: "Reply with exactly: local host inferred",
      });
      expect(started.isError).toBe(false);
      const childId = started.data.session_id as string;
      const child = thread(childId);
      expect(child?.host).toBeNull();
      expect(child?.cwd).toBe(localRepo);
      expect(child?.projectId).toBe("proj-local-host");
      await statusUntil(client, childId, "idle");
    } finally {
      rmSync(localRepo, { recursive: true, force: true });
      invalidateProjectFolderCache();
    }
  });
});
