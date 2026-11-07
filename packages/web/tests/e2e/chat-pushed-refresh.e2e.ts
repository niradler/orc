import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { openChatHistory, waitHistoryClosed } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

test("should show queued ORC answers and rebuild the chat when its session changed on disk", async ({
  page,
}) => {
  const now = Date.now();
  let thread: ChatThread = {
    id: "80000000-0000-4000-8000-0000000000a1",
    title: "Codex waiting on IBKR",
    config: ChatSettingsSchema.parse({ agent: "codex", model: "fixture-model" }),
    cwd: "/fixture/codex",
    host: null,
    runtimeId: "codex-runtime",
    sourceId: null,
    backend: "codex-cli",
    updatedAt: now - 5000,
    messages: [{ id: "m1", role: "user", content: "Check positions", timestamp: now - 6000 }],
  };
  const delivered: ChatThread = {
    ...thread,
    updatedAt: now,
    messages: [
      ...thread.messages,
      { id: "m2", role: "user", content: "ORC is delivering the human response", timestamp: now },
      { id: "m3", role: "assistant", content: "Token expired; renew it.", timestamp: now },
    ],
  };
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/threads", (route) =>
    route.fulfill({
      json: {
        threads: [
          {
            id: thread.id,
            title: thread.title,
            agent: "codex",
            running: false,
            updatedAt: thread.updatedAt,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/chat/threads/${thread.id}`, (route) => route.fulfill({ json: thread }));
  let changed = true;
  let queued = [{ id: "hr-1", title: "IBKR positions check" }];
  await page.route(`**/api/chat/threads/${thread.id}/session`, (route) =>
    route.fulfill({ json: { changed, running: false, queued } }),
  );
  let rebuilt = 0;
  await page.route(`**/api/chat/threads/${thread.id}/refresh`, (route) => {
    rebuilt++;
    thread = delivered;
    changed = false;
    queued = [];
    return route.fulfill({ json: thread });
  });
  await page.route("**/api/chat/threads/*/live", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.route("**/api/sessions/archive?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({ json: { sessions: [], has_more: false } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tasks?chat=full");
  await openChatHistory(page);
  await page
    .getByTestId("chat-session-list")
    .locator(`[data-history-id="chat:${thread.id}"]`)
    .getByTestId("chat-resume-thread")
    .click();
  await waitHistoryClosed(page);
  await expect(page.getByTestId("chat-pending-count")).toHaveText("1 pending");
  await page.getByTestId("chat-queue-toggle").click();
  await expect(page.getByTestId("chat-queued-answer")).toContainText("IBKR positions check");
  const refresh = page.getByTestId("chat-refresh-button").filter({ visible: true });
  await expect(refresh).toHaveAttribute("data-stale", "true");
  await expect(refresh).toHaveClass(/text-warning/);
  await expect(refresh).toHaveAccessibleName("Refresh session: it changed outside this chat");
  await refresh.click();
  await expect(
    page.getByTestId("chat-messages").getByText("Token expired; renew it."),
  ).toBeVisible();
  await expect(page.getByTestId("chat-live-announcer")).toContainText("Token expired; renew it.");
  expect(rebuilt).toBe(1);
  await expect(refresh).not.toHaveAttribute("data-stale", "true");
  await expect(refresh).toHaveAccessibleName("Refresh session");
  await expect(page.getByTestId("chat-message-queue")).toHaveCount(0);
});
