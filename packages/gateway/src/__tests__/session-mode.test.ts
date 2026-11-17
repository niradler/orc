import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, registerBackend, UNKNOWN_CAPABILITIES } from "@orc/agent-runtime";
import { resetConfig } from "@orc/core/config";
import type { AgentCapabilities } from "@orc/core/types";
import { createTestDb, getSqlite } from "@orc/db/client";
import { runAgentTurn } from "../agent-runner.js";
import { handleDirectCommand } from "../direct.js";
import type { PermissionManager } from "../permission-manager.js";
import { createGatewaySession, getActiveGatewaySession } from "../store.js";
import type { GatewayAdapter } from "../types.js";

const original = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ORC_DB_PATH: process.env.ORC_DB_PATH,
};
const home = mkdtempSync(join(tmpdir(), "orc-gateway-mode-"));
const modes: string[] = [];
let closed = 0;

function fixture(capabilities: AgentCapabilities): AgentSession {
  let alive = true;
  let pending = true;
  return {
    id: "fixture",
    capabilities,
    alive: () => alive,
    send: async () => {
      pending = true;
    },
    respondPermission: () => {},
    ...(capabilities.livePermissions
      ? { setPermissionMode: (mode: string) => void modes.push(mode) }
      : {}),
    async *events() {
      if (!pending) return;
      pending = false;
      yield { type: "text" as const, data: "done" };
      yield { type: "result" as const, data: { runtimeSessionId: "native" } };
    },
    close: async () => {
      alive = false;
      closed++;
    },
  };
}

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  const live: AgentCapabilities = {
    ...UNKNOWN_CAPABILITIES,
    livePermissions: true,
    permissionModes: ["default", "plan", "acceptEdits"],
  };
  const restart: AgentCapabilities = {
    ...UNKNOWN_CAPABILITIES,
    permissionModes: ["default", "plan"],
  };
  for (const [name, capabilities] of [
    ["mode-live", live],
    ["mode-restart", restart],
  ] as const)
    registerBackend(name, () => ({
      name,
      capabilities,
      startSession: async () => fixture(capabilities),
      resumeSession: async () => fixture(capabilities),
      preflight: async () => ({ ok: true }),
      stop: async () => {},
    }));
});

afterAll(() => {
  for (const [key, value] of Object.entries(original))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

async function open(chatKey: string, backend: string) {
  getSqlite()
    .query(
      "INSERT INTO bridge_chats (id, platform, chat_id, mode, created_at, updated_at) VALUES (?, 'telegram', ?, ?, 0, 0)",
    )
    .run(chatKey, chatKey, `agent:${backend}`);
  return createGatewaySession({ chatKey, backend, cwd: home, mode: `agent:${backend}` });
}

async function liveTurn(chatKey: string) {
  const session = await getActiveGatewaySession(chatKey);
  if (!session) throw new Error("no session");
  await runAgentTurn(
    {
      chatKey,
      chatId: chatKey,
      platform: "telegram",
      adapter: {} as GatewayAdapter,
      permissionManager: {} as PermissionManager,
      session: { ...session, cwd: home, acpx_agent: null, a2a_url: null },
    },
    "hello",
    undefined,
    null,
  );
}

const mode = (chatKey: string, value: string) =>
  handleDirectCommand({ chatKey, rawText: `/session mode ${value}` });

for (const backend of ["acpx", "a2a"])
  test(`${backend} sessions reject plan and keep their mode`, async () => {
    await open(`mode-${backend}`, backend);
    expect((await mode(`mode-${backend}`, "plan"))?.text).toBe(
      'This agent does not support the "plan" permission mode.',
    );
    expect((await getActiveGatewaySession(`mode-${backend}`))?.permission_mode).toBeNull();
  });

test("a live session switches its permission mode in place", async () => {
  await open("mode-live", "mode-live");
  await liveTurn("mode-live");
  const reply = await mode("mode-live", "edit");
  expect(reply?.text).toBe("Mode set: ✏️ Edit — file edits auto-approved, bash still prompts");
  expect(modes).toEqual(["acceptEdits"]);
  expect(closed).toBe(0);
  expect((await getActiveGatewaySession("mode-live"))?.permission_mode).toBe("acceptEdits");
});

test("a live session without live switching restarts on the next message", async () => {
  await open("mode-restart", "mode-restart");
  await liveTurn("mode-restart");
  const reply = await mode("mode-restart", "plan");
  expect(reply?.text).toContain("The agent restarts on your next message to apply it.");
  expect(closed).toBe(1);
  expect((await getActiveGatewaySession("mode-restart"))?.permission_mode).toBe("plan");
});
