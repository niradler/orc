import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ChatThreadSchema } from "@orc/core/chat";
import { resetConfig } from "@orc/core/config";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { previewBroker } from "../desktop-preview/broker.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

const session = crypto.randomUUID(),
  other = crypto.randomUUID();
const originalBase = process.env.ORC_API_BASE;
let server: ReturnType<typeof Bun.serve>;
const connections: Client[] = [];
const desktops: { id: string; lease: string }[] = [];
beforeAll(() => {
  const app = setupTestApp();
  for (const id of [session, other])
    new ChatStore(getSqlite()).save(
      ChatThreadSchema.parse({
        id,
        title: "Capability demo",
        config: {},
        cwd: process.cwd(),
        host: null,
        runtimeId: null,
        sourceId: null,
        backend: "codex",
        messages: [],
        updatedAt: Date.now(),
      }),
    );
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  process.env.ORC_API_BASE = `http://127.0.0.1:${server.port}`;
  resetConfig();
});
afterAll(async () => {
  for (const connection of connections) await connection.close();
  for (const desktop of desktops) {
    try {
      previewBroker.close(desktop.id, desktop.lease);
    } catch {
      /* Already disconnected by the test. */
    }
  }
  await server.stop(true);
  if (originalBase === undefined) delete process.env.ORC_API_BASE;
  else process.env.ORC_API_BASE = originalBase;
  teardownTestApp();
});
async function connect(mode: "full" | "meta", bound = true, clientId?: string): Promise<Client> {
  const client = new Client({ name: "capability-demo", version: "1" });
  const url = new URL(`${process.env.ORC_API_BASE}/mcp`);
  url.searchParams.set("mode", mode);
  if (bound) url.searchParams.set("preview_session", session);
  if (clientId) url.searchParams.set("preview_client", clientId);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer test-secret" } },
    }),
  );
  connections.push(client);
  return client;
}
const text = (value: unknown): string => JSON.stringify(value);
async function previewNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("preview_"));
}

test("should reflect only the caller's session/client capabilities through real full and meta MCP, including reconnect and stale names", async () => {
  const full = await connect("full"),
    meta = await connect("meta"),
    unbound = await connect("full", false);
  expect(await previewNames(full)).toEqual([]);
  expect(
    text(await meta.callTool({ name: "tool_search", arguments: { query: "preview" } })),
  ).not.toContain("preview_open_url:");
  expect(
    (await meta.callTool({ name: "tool_describe", arguments: { name: "preview_open_url" } }))
      .isError,
  ).toBe(true);
  const unrelated = crypto.randomUUID();
  const otherLease = previewBroker.register(unrelated, other, undefined, true);
  desktops.push({ id: unrelated, lease: otherLease.lease });
  expect(await previewNames(full)).toEqual([]);
  const id = crypto.randomUUID();
  const { lease } = previewBroker.register(id, session, undefined, true);
  desktops.push({ id, lease });
  expect(await previewNames(full)).toContain("preview_open_url");
  expect(await previewNames(full)).not.toContain("preview_browser_act");
  previewBroker.register(id, session, lease, true, true);
  expect(await previewNames(full)).toContain("preview_browser_act");
  expect(await previewNames(unbound)).toEqual([]);
  expect(
    text(await meta.callTool({ name: "tool_search", arguments: { query: "preview_open_url" } })),
  ).toContain("preview_open_url:");
  expect(
    (await meta.callTool({ name: "tool_describe", arguments: { name: "preview_browser_act" } }))
      .isError,
  ).not.toBe(true);
  previewBroker.register(id, session, lease, false);
  expect(await previewNames(full)).toContain("preview_open_file");
  expect(await previewNames(full)).not.toContain("preview_browser_act");
  expect(
    (
      await full.callTool({
        name: "preview_browser_act",
        arguments: { session_id: session, command: { action: "snapshot" } },
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await meta.callTool({
        name: "tool_invoke",
        arguments: { name: "preview_browser_snapshot", arguments: { session_id: session } },
      })
    ).isError,
  ).toBe(true);
  previewBroker.register(id, session, lease, true, true);
  const second = crypto.randomUUID(),
    secondLease = previewBroker.register(second, session, undefined, true);
  desktops.push({ id: second, lease: secondLease.lease });
  expect(await previewNames(full)).toEqual(["preview_clients", "preview_request_get"]);
  expect(
    (
      await meta.callTool({
        name: "tool_describe",
        arguments: { name: "preview_open_url", client_id: id },
      })
    ).isError,
  ).not.toBe(true);
  const targeted = full.callTool({
    name: "preview_open_url",
    arguments: { client_id: id, url: "https://example.test" },
  });
  const deadline = Date.now() + 2000;
  let pending = previewBroker.pending(id, lease);
  while (!pending.length && Date.now() < deadline) {
    await Bun.sleep(10);
    pending = previewBroker.pending(id, lease);
  }
  expect(pending).toHaveLength(1);
  previewBroker.acknowledge(id, lease, pending[0]?.id as string, "opened", null);
  expect((await targeted).isError).not.toBe(true);
  const pinned = await connect("full", true, id);
  expect(await previewNames(pinned)).toContain("preview_open_url");
  expect(
    (await pinned.callTool({ name: "preview_browser_snapshot", arguments: { session_id: other } }))
      .isError,
  ).toBe(true);
  expect(
    (
      await pinned.callTool({
        name: "preview_browser_snapshot",
        arguments: { session_id: session, client_id: second },
      })
    ).isError,
  ).toBe(true);
  previewBroker.close(id, lease);
  expect(await previewNames(pinned)).toEqual([]);
  expect(
    (
      await pinned.callTool({
        name: "preview_open_url",
        arguments: { session_id: session, url: "https://example.com" },
      })
    ).isError,
  ).toBe(true);
  expect(await previewNames(full)).toContain("preview_open_url");
  const replacement = previewBroker.register(id, session, undefined, true);
  desktops.push({ id, lease: replacement.lease });
  // A stale lease must fail; reconnecting uses the newly returned lease.
  expect(replacement.lease).not.toBe(lease);
  expect(() => previewBroker.pending(id, lease)).toThrow();
  expect(await previewNames(pinned)).toContain("preview_open_url");
});
