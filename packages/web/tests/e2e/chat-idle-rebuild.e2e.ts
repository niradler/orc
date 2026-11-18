import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { openChatHistory, waitHistoryClosed } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

declare global {
  interface Window {
    __sawWorking?: boolean;
  }
}

test("rebuilding an idle session's transcript does not pop the working panel", async ({ page }) => {
  const now = Date.now();
  const threadId = "91000000-0000-4000-8000-000000000001";
  const sourceId = "idle-source";
  const runtimeId = "ses_idle_opencode";
  const thread: ChatThread = {
    id: threadId,
    title: "Idle OpenCode session",
    config: ChatSettingsSchema.parse({ agent: "opencode" }),
    cwd: "/fixture",
    host: null,
    runtimeId,
    sourceId,
    backend: "opencode",
    updatedAt: now,
    messages: [],
  };
  const live = {
    id: sourceId,
    session_id: runtimeId,
    agent: "opencode",
    name: "Idle OpenCode session",
    project_id: null,
    host: null,
    cwd: "/fixture",
    status: "stopped",
    last_activity_at: new Date(now - 90_000).toISOString(),
    created_at: new Date(now - 3_600_000).toISOString(),
  };

  await page.addInitScript((secret) => {
    localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
    localStorage.setItem("orc_selected_project", "all");
    window.__sawWorking = false;
    const flag = () => {
      window.__sawWorking = true;
    };
    const selector =
      '[data-testid="chat-working-spinner"], [data-testid="chat-header-state"][data-state="working"]';
    const isWorking = (node: EventTarget | null): boolean => {
      if (!(node instanceof Element)) return false;
      return node.matches(selector) || node.querySelector(selector) !== null;
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) if (isWorking(node)) flag();
        } else if (isWorking(mutation.target)) flag();
      }
    });
    const start = () =>
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state"],
      });
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  }, API_SECRET);

  await page.route(/\/api\/projects(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({
      json: {
        threads: [
          {
            id: threadId,
            title: thread.title,
            agent: "opencode",
            runtimeId,
            sourceId,
            host: null,
            running: false,
            updatedAt: now,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chat/threads/${threadId}`, (route) => route.fulfill({ json: thread }));
  let healed = false;
  await page.route(`**/api/chat/threads/${threadId}/session`, (route) =>
    route.fulfill({
      json: {
        changed: !healed,
        running: false,
        live: {
          id: sourceId,
          agent: "opencode",
          tokens_used: null,
          tokens_estimated: false,
          status: "stopped",
          waiting_for_human: false,
          waiting_for: null,
          background_work: false,
          created_at: live.created_at,
          last_activity_at: live.last_activity_at,
        },
        queued: [],
      },
    }),
  );
  let refreshed = 0;
  await page.route(`**/api/chat/threads/${threadId}/refresh`, async (route) => {
    refreshed++;
    healed = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ json: thread });
  });
  await page.route("**/api/chat/threads/*/live", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route(`**/api/sessions/live/${sourceId}/children`, (route) =>
    route.fulfill({ json: { sessions: [] } }),
  );
  for (const kind of ["live", "archive"] as const)
    await page.route(`**/api/sessions/${kind}?**`, (route) =>
      route.fulfill({
        json: { sessions: kind === "live" ? [live] : [], has_more: false },
      }),
    );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=open&project=all");
  await openChatHistory(page);
  const row = page.getByTestId("chat-session-list").locator(`[data-history-id="chat:${threadId}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId("chat-resume-thread").click();
  await waitHistoryClosed(page);

  await expect.poll(() => refreshed, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("chat-working-spinner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__sawWorking ?? false)).toBe(false);
  await expect(page.getByTestId("chat-header-state").first()).toHaveAttribute(
    "data-state",
    "idle",
    { timeout: 15_000 },
  );
  // Let the delayed attach fully complete, then recheck that nothing popped late.
  await page.waitForTimeout(2500);
  expect(await page.evaluate(() => window.__sawWorking ?? false)).toBe(false);
  await expect(page.getByTestId("chat-working-spinner")).toHaveCount(0);
  await expect(page.getByTestId("chat-header-state").first()).toHaveAttribute("data-state", "idle");
});
