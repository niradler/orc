import { spawnSync } from "node:child_process";
import { type ChatActivity, ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
import { API_SECRET, repoRoot } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});

const PARENT_LIVE = "parent-live";
const CHILD_LIVE = "child-live";
const CHILD_NATIVE = "child-native";

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
});

function seed(thread: unknown): void {
  const seeded = spawnSync(
    "bun",
    [
      "-e",
      'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
      JSON.stringify(thread),
    ],
    { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
}

function activity(): ChatActivity[] {
  return [
    {
      type: "tool",
      id: "call_sub",
      name: "task",
      input: JSON.stringify({ description: "Demo subagent render" }),
    },
    {
      type: "tool",
      id: "call_read",
      name: "read",
      input: JSON.stringify({ path: "README.md" }),
      result: "Read complete",
    },
  ];
}

/** The discovered subagent tree is collapsed to its summary line until opened. */
async function openSubagentTree(page: Page): Promise<void> {
  await page.getByTestId("chat-subagents-toggle").click();
}

function seedParent(id: string, started: number): void {
  seed({
    id,
    title: "Parent session",
    config: defaults,
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: PARENT_LIVE,
    updatedAt: started + 40_000,
    messages: [
      { id: `${id}-user`, role: "user", content: "Use a subagent", timestamp: started },
      {
        id: `${id}-assistant`,
        role: "assistant",
        content: "The subagent is done.",
        timestamp: started + 40_000,
        turn: {
          startedAt: started,
          finishedAt: started + 40_000,
          durationMs: 40_000,
          outcome: "completed",
        },
        activity: activity(),
      },
    ],
  });
}

async function mockSubagent(page: Page): Promise<void> {
  await page.route(/\/api\/sessions\/live\/[^/]+\/subagents$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4];
    return route.fulfill({
      json: {
        subagents:
          id === PARENT_LIVE
            ? [
                {
                  id: CHILD_LIVE,
                  session_id: CHILD_NATIVE,
                  title: "Demo subagent render",
                  status: "stopped",
                  tool_call_id: "call_sub",
                  created_at: Date.now() - 30_000,
                },
              ]
            : [],
      },
    });
  });
  await page.route(`**/api/sessions/live/${CHILD_LIVE}`, (route) =>
    route.fulfill({ json: { id: CHILD_LIVE, agent: "claude", session_id: CHILD_NATIVE } }),
  );
  await page.route(`**/api/sessions/live/${CHILD_LIVE}/lineage`, (route) =>
    route.fulfill({
      json: {
        parent: { id: PARENT_LIVE, title: "Parent session", kind: "session", status: "running" },
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
        runtimeId: CHILD_NATIVE,
        sourceId: CHILD_LIVE,
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
          {
            id: "73000000-0000-4000-8000-000000000003",
            role: "assistant",
            content: "The parser reads inline tool results correctly; two matches found.",
            timestamp: Date.now() - 25_000,
            agent: "claude",
            activity: [],
          },
        ],
      },
    });
  });
  await page.route("**/api/chat/threads/*/live", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/chat/threads/*/session", (route) =>
    route.fulfill({ json: { running: false, queued: [] } }),
  );
}

for (const width of [1440, 390]) {
  test(`a subagent names its parent and goes back at ${width}px`, async ({ page }) => {
    const parentId = crypto.randomUUID();
    seedParent(parentId, Date.now() - 120_000);
    await mockSubagent(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?chat=open&chatThread=${parentId}`);

    await expect(page.getByTestId("chat-subagents")).toBeVisible();
    await openSubagentTree(page);
    const row = page.getByTestId("chat-subagent");
    const open = row.getByRole("button");
    await expect(row).toContainText("Demo subagent render");
    await expect(open).toBeVisible();

    await page.screenshot({ path: test.info().outputPath(`subagent-parent-${width}.png`) });
    await open.click();
    const headerTitle = page.locator('[data-testid="chat-panel"] header h2');
    await expect(headerTitle).toContainText("Demo subagent render");
    await expect(page.getByTestId("chat-subagent-kind")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`subagent-open-${width}.png`) });
    if (width === 1440) {
      const parent = page.getByTestId("chat-parent-session");
      await expect(parent).toHaveText("Parent session");
      await parent.click();
    } else {
      await expect(page.getByTestId("chat-parent-session")).toHaveText("Parent session");
      const back = page.getByTestId("chat-parent-back");
      await expect(back).toHaveAccessibleName("Back to Parent session");
      await back.click();
    }
    await expect(headerTitle).toContainText("Parent session");
    await expect(page).toHaveURL(new RegExp(parentId));
  });
}

test("a docked subagent chat names its parent at 1440px", async ({ page }) => {
  const parentId = crypto.randomUUID();
  seedParent(parentId, Date.now() - 120_000);
  await mockSubagent(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat?chatThread=${parentId}`);

  await openSubagentTree(page);
  await page.getByTestId("chat-subagent").getByRole("button").click();
  const headerTitle = page.locator('[data-testid="chat-panel"] header h2');
  await expect(headerTitle).toContainText("Demo subagent render");
  // The docked chat page has room for the whole path: project, parent, title.
  await expect(page.getByTestId("session-project-breadcrumb")).toBeVisible();
  await expect(page.getByTestId("chat-parent-session")).toHaveText("Parent session");
  await page.screenshot({ path: test.info().outputPath("subagent-docked-1440.png") });

  await page.getByTestId("chat-parent-session").click();
  await expect(headerTitle).toContainText("Parent session");
  await expect(page).toHaveURL(new RegExp(parentId));
});
