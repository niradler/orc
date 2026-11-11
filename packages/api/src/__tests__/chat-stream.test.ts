import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, resetConfig } from "@orc/core/config";
import { initializeAgentPreferences } from "@orc/core/provider-service";
import type { createApp } from "../server.js";
import { setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const AUTH = {
  Authorization: "Bearer test-secret",
  "content-type": "application/json",
};

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
});

/**
 * These tests exercise /chat/stream without shelling out to a real LLM.
 *
 * The happy-path round-trip (spawn acpx -> stdin flush -> stdout -> SSE) is
 * covered by the Playwright e2e spec in packages/web/tests/e2e/chat.spec.ts,
 * which is the only place where spawning a real agent makes sense.
 *
 * Here we lock down the input-validation contract so a broken client cannot
 * spawn an agent with an empty or malformed prompt.
 */
describe("/chat/stream contract", () => {
  test("rejects empty messages array with 400", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/messages/i);
  });

  test("rejects missing messages field with 400", async () => {
    const res = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(400);
  });

  test("runs a mocked turn even when the agent provider is disabled", async () => {
    // The browser suites chat through ORC_E2E_CHAT_MOCK with no agent CLI
    // installed, so an installed-but-disabled profile must not block the turn.
    const home = mkdtempSync(join(tmpdir(), "orc-chat-mock-"));
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, ".orc"), { recursive: true });
    writeFileSync(globalConfigPath(), "{}");
    resetConfig();
    initializeAgentPreferences(() => null);
    resetConfig();
    process.env.ORC_E2E_CHAT_MOCK = "1";
    try {
      const res = await app.request("/api/chat/stream", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          messages: [{ role: "user", content: "Reply with exactly: MOCK-OK." }],
          agent: "codex",
          model: "",
          agentOptions: {},
          workspace: { host: null, cwd: "", worktree: false },
          context: { source: "webchat", route: "/activity?project=all" },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("MOCK-OK");
    } finally {
      delete process.env.ORC_E2E_CHAT_MOCK;
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfig();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
