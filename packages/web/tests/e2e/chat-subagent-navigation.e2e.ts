import { spawnSync } from "node:child_process";
import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { API_SECRET, repoRoot } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});

test.beforeEach(async ({ page, request }) => {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.route(/\/api\/sessions\/live\/[^/]+\/subagents$/, (route) =>
    route.fulfill({
      json: {
        subagents: route.request().url().includes("/parent-live/")
          ? [
              {
                id: "child-live",
                session_id: "child-native",
                title: "Demo subagent render",
                status: "stopped",
                tool_call_id: "call_sub",
                created_at: Date.now() - 30_000,
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/sessions/live/child-live", (route) =>
    route.fulfill({ json: { id: "child-live", agent: "claude", session_id: "child-native" } }),
  );
  await page.route("**/api/sessions/live/parent-live", (route) =>
    route.fulfill({ json: { id: "parent-live", agent: "codex", session_id: null } }),
  );
  await page.route("**/api/sessions/live/child-live/lineage", (route) =>
    route.fulfill({
      json: {
        parent: { id: "parent-live", title: "Parent session", kind: "session", status: "running" },
        children: [],
      },
    }),
  );
  await page.route("**/api/chat/threads", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      json: {
        id: "73000000-0000-4000-8000-000000000001",
        title: "Demo subagent render",
        config: defaults,
        cwd: "/tmp",
        host: null,
        runtimeId: "child-native",
        sourceId: "child-live",
        backend: "claude-code",
        updatedAt: Date.now(),
        messages: [
          {
            id: "73000000-0000-4000-8000-000000000002",
            role: "user",
            content: "Inspect the parser and report back.",
            timestamp: Date.now() - 30_000,
            agent: "claude",
          },
        ],
      },
    });
  });
  await page.route("**/api/chat/threads/*/live", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/chat/threads/*/session", (route) =>
    route.fulfill({ json: { running: false, queued: [] } }),
  );
});

for (const width of [1440, 390]) {
  test(`a subagent chat goes back to its parent at ${width}px`, async ({ page }) => {
    const parentId = crypto.randomUUID();
    const started = Date.now() - 120_000;
    const seeded = spawnSync(
      "bun",
      [
        "-e",
        'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
        JSON.stringify({
          id: parentId,
          title: "Parent session",
          config: defaults,
          cwd: "/tmp",
          host: null,
          runtimeId: null,
          backend: "codex-cli",
          sourceId: "parent-live",
          updatedAt: started + 40_000,
          messages: [
            { id: `${parentId}-user`, role: "user", content: "Use a subagent", timestamp: started },
            {
              id: `${parentId}-assistant`,
              role: "assistant",
              content: "The subagent is done.",
              timestamp: started + 40_000,
              turn: {
                startedAt: started,
                finishedAt: started + 40_000,
                durationMs: 40_000,
                outcome: "completed",
              },
              activity: [
                {
                  type: "tool",
                  id: "call_sub",
                  name: "task",
                  input: JSON.stringify({ description: "Demo subagent render" }),
                  result: "Done",
                },
              ],
            },
          ],
        }),
      ],
      { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
    );
    expect(seeded.status, seeded.stderr).toBe(0);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=open&chatThread=${parentId}`);

    await page.getByTestId("chat-subagents-toggle").click();
    await page.getByTestId("chat-subagent").getByRole("button").click();
    const headerTitle = page.locator('[data-testid="chat-panel"] header h2');
    await expect(headerTitle).toContainText("Demo subagent render");
    const back = page.getByTestId("chat-parent-back");
    await expect(back).toHaveAccessibleName("Back to Parent session");
    await back.click();
    await expect(headerTitle).toContainText("Parent session");
    await expect(page).toHaveURL(new RegExp(parentId));
  });
}
